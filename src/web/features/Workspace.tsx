import { useMemo, useRef, useState, type ReactNode } from 'react';
import { buildShot, CUSTOM_KIT, type PackBundle } from '../../core/pipeline.ts';
import { activeStates, durationOf, emptyUnit, eventBudget, type Project, type Ref, type Shot } from '../../core/model/project.ts';
import { Button, Card, Icon, Meter, SegmentedControl, Select, Switch, Tag, Text, TextField } from '../ui/components/index.ts';
import { currentShot, downscale, slugify, useStore } from '../store.ts';
import { Attempts } from './Attempts.tsx';
import { ExportCard } from './ExportCard.tsx';
import { Findings } from './Findings.tsx';
import { PromptText } from './PromptText.tsx';
import styles from './Workspace.module.css';

const KIND_RU: Record<Ref['kind'], string> = { location: 'Локация', character: 'Герой', object: 'Предмет', gear: 'Техника', other: 'Другое' };
const BLOCK_RU: Record<string, string> = { style: 'Стиль-блок', format: 'Формат', 'role-shooting': 'Роль: снимающая техника', 'role-props': 'Роль: реквизит', camera: 'Камера', lens: 'Объектив', flare: 'Блик', imperfections: 'Дефекты и речь', 'operator-rule': 'Правило про оператора', location: 'Локация и погода', segment: 'Сценарий' };
const SAVE_RU = { saved: 'сохранено', dirty: 'есть правки…', saving: 'сохраняю…', conflict: 'конфликт окон', error: 'не сохранено' } as const;
const DURATION_PRESETS = [5, 10, 15, 20, 30];

/** Длительность дубля. Черновик живёт в поле: в кадр уходит только целое 4–30, недопечатанное число промпт не ломает. */
function DurationField({ value, onCommit }: { value: number; onCommit: (durationSec: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const parse = (text: string): number | null => (/^\d+$/.test(text.trim()) && Number(text) >= 4 && Number(text) <= 30 ? Number(text) : null);
  const valid = parse(draft) !== null;
  const set = (text: string): void => {
    setDraft(text);
    const n = parse(text);
    if (n !== null) onCommit(n);
  };
  return (
    <div className={styles.duration}>
      <TextField label="Длительность, с" type="number" inputMode="numeric" min={4} max={30} step={1} value={draft} onChange={(event) => set(event.target.value)} onBlur={() => !valid && setDraft(String(value))} error={valid ? undefined : `Seedance 2.5 принимает целое от 4 до 30. В промпте остаётся ${value} с.`} helper="Это же число ставится в Higgsfield. От него считаются ёмкость речи и бюджет событий." />
      <div className={styles.presets}>
        {DURATION_PRESETS.map((n) => <Button key={n} variant={value === n ? 'secondary' : 'ghost'} size="xs" onClick={() => set(String(n))}>{n}</Button>)}
      </div>
    </div>
  );
}

function Section({ n, title, note, children }: { n: string; title: string; note?: string; children: ReactNode }) {
  return (
    <Card padding="l" className={styles.section}>
      <header className={styles.sectionHead}>
        <Text variant="caption" tone="tertiary" mono>{n}</Text>
        <div>
          <Text as="h2" variant="title-s">{title}</Text>
          {note !== undefined && <Text variant="label" tone="secondary">{note}</Text>}
        </div>
      </header>
      <div className={styles.sectionBody}>{children}</div>
    </Card>
  );
}

function syncLocationRefs(project: Project, shot: Shot): Shot {
  const kinds = new Map(project.refs.map((ref) => [ref.key, ref.kind]));
  return { ...shot, locationRefs: shot.panel.filter((key) => kinds.get(key) === 'location').slice(0, 2) };
}

export function Workspace({ pack }: { pack: PackBundle }) {
  const store = useStore();
  const project = store.project;
  const shot = useStore(currentShot);
  const [exportOpen, setExportOpen] = useState(false);
  const [visionAgreed, setVisionAgreed] = useState(false);
  const [newRef, setNewRef] = useState<{ label: string; kind: Ref['kind'] }>({ label: '', kind: 'location' });
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  const fileInputs = useRef(new Map<string, HTMLInputElement>());

  const build = useMemo(() => (project !== null && shot !== null ? buildShot(project, shot, pack) : null), [project, shot, pack]);
  if (project === null || shot === null || build === null) return null;

  const errors = build.findings.filter((f) => f.severity === 'error').length;
  const warnings = build.findings.filter((f) => f.severity === 'warning').length;
  const blocking = build.blockers.length + errors;
  const canCopy = blocking === 0;
  const duration = durationOf(project, shot);
  const budget = eventBudget(duration);
  const speechTone = build.metrics.speechWords > build.metrics.speechCapacity ? 'warning' : 'accent';
  const kits = Object.values(pack.kits).sort((a, b) => Number(a.source !== 'guide' && a.source !== undefined) - Number(b.source !== 'guide' && b.source !== undefined));
  const kit = pack.kits[shot.kitId];
  const isCustom = shot.kitId === CUSTOM_KIT;
  const gearRefs = shot.panel.flatMap((key) => { const ref = project.refs.find((r) => r.key === key); return ref !== undefined && ref.kind !== 'location' && ref.kind !== 'character' ? [ref] : []; });
  const setCustom = (patch: Partial<Shot['customKit']>): void => store.updateShot((s) => ({ ...s, customKit: { ...s.customKit, ...patch } }));
  const setRole = (patch: Partial<NonNullable<Shot['roleSplit']>>): void => store.updateShot((s) => (s.roleSplit === null ? s : { ...s, roleSplit: { ...s.roleSplit, ...patch } }));

  const insert = (segmentId: string, token: string): void => {
    const area = areas.current.get(segmentId);
    store.updateShot((s) => ({
      ...s,
      segments: s.segments.map((segment) => {
        if (segment.id !== segmentId) return segment;
        const at = area?.selectionStart ?? segment.text.en.length;
        return { ...segment, text: { ...segment.text, en: `${segment.text.en.slice(0, at)}${token}${segment.text.en.slice(at)}`, source: 'manual', locked: true } };
      }),
    }));
  };

  const addRef = (): void => {
    const label = newRef.label.trim();
    if (label === '') return;
    const taken = new Set(project.refs.map((ref) => ref.key));
    let key = slugify(label);
    for (let n = 2; taken.has(key); n += 1) key = `${slugify(label)}-${n}`;
    store.update((p) => {
      const next = { ...p, refs: [...p.refs, { key, label, kind: newRef.kind, file: null, flags: { hasPeople: false, hasText: false, studioBackdrop: false } }] };
      return { ...next, shots: next.shots.map((s) => (s.id === shot.id ? syncLocationRefs(next, { ...s, panel: [...s.panel, key] }) : s)) };
    });
    setNewRef({ label: '', kind: newRef.kind });
  };

  const moveRef = (key: string, delta: number): void =>
    store.update((p) => ({
      ...p,
      shots: p.shots.map((s) => {
        if (s.id !== shot.id) return s;
        const panel = [...s.panel];
        const from = panel.indexOf(key);
        const to = from + delta;
        if (from === -1 || to < 0 || to >= panel.length) return s;
        panel.splice(to, 0, ...panel.splice(from, 1));
        return syncLocationRefs(p, { ...s, panel });
      }),
    }));

  const removeFromPanel = (key: string): void => store.update((p) => ({ ...p, shots: p.shots.map((s) => (s.id === shot.id ? syncLocationRefs(p, { ...s, panel: s.panel.filter((k) => k !== key) }) : s)) }));

  const upload = async (ref: Ref, file: File): Promise<void> => {
    const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
    const fileName = `${ref.key}.${['jpg', 'png', 'webp'].includes(ext) ? ext : 'jpg'}`;
    await store.uploadRef(file, fileName);
    // Уменьшенная копия для vision-анализа: сама никуда не уходит, пока владелец не нажмёт «Анализ».
    await downscale(file).then((blob) => store.uploadRef(new File([blob], `${ref.key}-vision.jpg`), `${ref.key}-vision.jpg`)).catch(() => undefined);
    store.update((p) => ({ ...p, refs: p.refs.map((r) => (r.key === ref.key ? { ...r, file: `${fileName}?v=${Date.now()}` } : r)) }));
  };

  // Гейт «наружу»: картинка уходит в Anthropic только после явного согласия, один раз на сессию.
  const confirmVision = (key: string): void => {
    if (!visionAgreed && !window.confirm('Уменьшенная копия этой картинки уйдёт в Anthropic для анализа (тот же получатель, что у сессий Claude Code). На референсе может быть твоё лицо. Отправить?')) return;
    setVisionAgreed(true);
    void store.analyzeRef(key);
  };

  const refByKey = new Map(project.refs.map((ref) => [ref.key, ref]));
  const incoming = activeStates(project, shot.id);
  const outcomes = project.states.filter((state) => state.originShotId === shot.id);
  const nextStateId = `S${Math.max(0, ...project.states.map((s) => Number(s.id.slice(1)))) + 1}`;
  const nextLineId = `L${Math.max(0, ...project.lines.map((l) => Number(l.id.slice(1)))) + 1}`;

  return (
    <div className={styles.shell}>
      <header className={`${styles.topbar} lab-glass-thin`}>
        <Button variant="ghost" size="xs" icon={<Icon name="chevron-back" size={1} />} onClick={store.closeProject}>Ролики</Button>
        <Text variant="label" medium>{project.title}</Text>
        <SegmentedControl aria-label="Кадры ролика" size="s" value={shot.id} onChange={store.selectShot} options={project.shots.map((s, i) => ({ value: s.id, label: `Кадр ${i + 1}` }))} />
        <Button variant="ghost" size="xs" icon={<Icon name="plus" size={1} />} onClick={store.addShot}>кадр</Button>
        <span className={styles.spacer} />
        <Tag tone={store.save === 'saved' ? 'neutral' : store.save === 'conflict' || store.save === 'error' ? 'danger' : 'outline'}>{SAVE_RU[store.save]}</Tag>
        <Tag tone="outline">{project.dialect.refSyntax === 'higgsfield-chip' ? '<<<image_N>>>' : '@Image N'}</Tag>
      </header>

      <div className={styles.columns}>
        <div className={styles.form}>
          <Section n="01" title="Как снято" note="Сначала «как снято», потом «что снято». Комплект — одна переменная на все места промпта.">
            <DurationField key={shot.id} value={duration} onCommit={(durationSec) => store.updateShot((s) => ({ ...s, durationSec }))} />
            <div className={styles.kits}>
              {kits.map((item) => (
                <button key={item.id} type="button" className={`${styles.kit} ${shot.kitId === item.id ? styles.kitOn : ''}`} onClick={() => store.updateShot((s) => ({ ...s, kitId: item.id, defects: null, roleSplit: item.layout === 'split' ? s.roleSplit : null }))} aria-pressed={shot.kitId === item.id}>
                  <Text variant="label" medium>{item.titleRu.split(' — ')[0]}</Text>
                  <Text variant="caption" tone="secondary">{item.titleRu.split(' — ')[1] ?? ''}</Text>
                  {item.source !== undefined && item.source !== 'guide' && <Tag tone="outline">не из гайда</Tag>}
                </button>
              ))}
              <button type="button" className={`${styles.kit} ${isCustom ? styles.kitOn : ''}`} onClick={() => store.updateShot((s) => ({ ...s, kitId: CUSTOM_KIT, defects: null, roleSplit: null }))} aria-pressed={isCustom}>
                <Text variant="label" medium>Своя камера</Text>
                <Text variant="caption" tone="secondary">любая техника: модель, объектив и характер картинки своими словами</Text>
                <Tag tone="outline">не из гайда</Tag>
              </button>
            </div>
            {kit?.noteRu !== undefined && kit.noteRu !== '' && (
              <div className={styles.report}>
                <Text variant="label" tone="secondary">{kit.noteRu}</Text>
              </div>
            )}
            {isCustom && (
              <div className={styles.customKit}>
                <div className={styles.pair}>
                  <TextField label="Камера (английский)" placeholder="Fujifilm X100V" value={shot.customKit.camera} onChange={(event) => setCustom({ camera: event.target.value })} helper="Реальная модель. «Cinematic camera» — не якорь, модель выберет усреднённую картинку." />
                  <TextField label="Объектив (английский, можно пусто)" placeholder="its fixed 23mm f/2 lens" value={shot.customKit.lens} onChange={(event) => setCustom({ lens: event.target.value })} helper="Встанет после «with». Для встроенной оптики пиши «its built-in … lens»." />
                </div>
                <TextField multiline label="Характер картинки (английский)" placeholder="fine digital grain, slightly muted colors with a soft green-teal cast, gentle contrast, smooth highlight rolloff, mild softness toward the corners" value={shot.customKit.look} onChange={(event) => setCustom({ look: event.target.value })} helper="Продолжает фразу через запятую: зерно, цвет, контраст, боке, блики — чем эта техника видна на картинке. Без точки в конце." />
                <TextField label="Примечание об оптике (можно пусто)" placeholder="No anamorphic streaks, only a faint veiling glow when the sun enters the frame" value={shot.customKit.lensNote} onChange={(event) => setCustom({ lensNote: event.target.value })} helper="Отдельное предложение сразу после характера — обычно про поведение блика." />
                <Text variant="caption" tone="tertiary" mono>
                  …shot on {shot.customKit.camera.trim() || '<камера>'}{shot.customKit.lens.trim() !== '' ? ` with ${shot.customKit.lens.trim()}` : ''}, {shot.customKit.look.trim() || '<характер>'}.
                </Text>
              </div>
            )}
            {kit?.layout === 'split' && (
              <div className={styles.customKit}>
                <Switch checked={shot.roleSplit !== null} onChange={(on) => store.updateShot((s) => ({ ...s, roleSplit: on ? { cameraRef: gearRefs[0]?.key ?? '', lensRef: gearRefs[1]?.key ?? gearRefs[0]?.key ?? '', cameraHolder: '', lensHolder: '', propsEn: '' } : null }))} label="В кадре есть такая же камера или объектив как реквизит" disabled={shot.roleSplit === null && gearRefs.length === 0} />
                <Text variant="caption" tone="tertiary">
                  {shot.roleSplit === null
                    ? gearRefs.length === 0 ? 'Приём 06 «один объект — одна роль». Нужен, только когда герои держат эту же технику в руках; для него добавь в панель референсы камеры и объектива (тип «Техника»).' : 'Приём 06 «один объект — одна роль». Без реквизита разделение не нужно — кадр собирается как есть.'
                    : 'Промпт разведёт снимающую технику и реквизит: блики и боке — только «on the image itself», на предметах в руках их не будет.'}
                </Text>
                {shot.roleSplit !== null && (
                  <>
                    <div className={styles.pair}>
                      <Select label="Референс камеры" value={shot.roleSplit.cameraRef} onChange={(cameraRef) => setRole({ cameraRef })} options={gearRefs.map((r) => ({ value: r.key, label: r.label }))} />
                      <Select label="Референс объектива" value={shot.roleSplit.lensRef} onChange={(lensRef) => setRole({ lensRef })} options={gearRefs.map((r) => ({ value: r.key, label: r.label }))} />
                    </div>
                    <div className={styles.pair}>
                      <TextField label="Кто держит камеру (имя в промпте)" placeholder="Alexander" value={shot.roleSplit.cameraHolder} onChange={(event) => setRole({ cameraHolder: event.target.value })} />
                      <TextField label="Кто показывает объектив" placeholder="John" value={shot.roleSplit.lensHolder} onChange={(event) => setRole({ lensHolder: event.target.value })} />
                    </div>
                    <TextField multiline label="Реквизит одним предложением (английский)" placeholder="Alexander holds a RED V-RAPTOR in his hands, and John holds an open case with Laowa Proteus lenses" value={shot.roleSplit.propsEn} onChange={(event) => setRole({ propsEn: event.target.value })} helper="Встанет после «Separately, …». Без точки в конце." />
                  </>
                )}
              </div>
            )}
            <div className={styles.row}>
              <Text variant="label" tone="secondary">Правило «оператор не виден»</Text>
              <SegmentedControl aria-label="Правило про оператора" size="s" value={shot.operatorRule} onChange={(operatorRule) => store.updateShot((s) => ({ ...s, operatorRule }))} options={[{ value: 'long', label: 'Полное' }, { value: 'short', label: 'Краткое' }, { value: 'off', label: 'Нет' }]} />
            </div>
            <div className={styles.row}>
              <Text variant="label" tone="secondary">Формула референса локации</Text>
              <SegmentedControl aria-label="Формула локации" size="s" value={shot.locationRule} onChange={(locationRule) => store.updateShot((s) => ({ ...s, locationRule }))} options={[{ value: 'short', label: 'Краткая' }, { value: 'long', label: 'С повтором номеров' }]} />
            </div>
          </Section>

          <Section n="02" title="Панель референсов" note="Порядок картинок — это нумерация в тексте. Загружай в Higgsfield в том же порядке.">
            <div className={styles.strip}>
              {shot.panel.map((key, index) => {
                const ref = refByKey.get(key);
                if (ref === undefined) return null;
                return (
                  <div key={key} className={styles.ref}>
                    <button type="button" className={`${styles.thumb} ${ref.file === null ? 'lab-hatch' : ''}`} onClick={() => fileInputs.current.get(key)?.click()} title="Загрузить картинку">
                      {ref.file !== null && <img src={`/api/projects/${project.slug}/refs/${ref.file}`} alt={ref.label} />}
                      <span className={styles.number}>{index + 1}</span>
                    </button>
                    <input ref={(el) => void (el === null ? fileInputs.current.delete(key) : fileInputs.current.set(key, el))} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) void upload(ref, file); }} />
                    <Text variant="caption" medium>{ref.label}</Text>
                    <Text variant="caption" tone="tertiary">{KIND_RU[ref.kind]}</Text>
                    <div className={styles.refActions}>
                      <Button variant="ghost" size="xs" iconOnly aria-label="Левее" icon={<Icon name="chevron-back" size={1} />} disabled={index === 0} onClick={() => moveRef(key, -1)} />
                      <Button variant="ghost" size="xs" iconOnly aria-label="Правее" icon={<Icon name="chevron-forward" size={1} />} disabled={index === shot.panel.length - 1} onClick={() => moveRef(key, 1)} />
                      <Button variant="ghost" size="xs" iconOnly aria-label="Убрать из панели" icon={<Icon name="close" size={1} />} onClick={() => removeFromPanel(key)} />
                    </div>
                    {ref.file !== null && (
                      <Button variant="soft" size="xs" icon={<Icon name="eye" size={0.875} />} loading={store.analyzing === key} disabled={store.analyzing !== null && store.analyzing !== key} onClick={() => confirmVision(key)}>
                        Анализ
                      </Button>
                    )}
                    {(ref.flags.hasPeople || ref.flags.hasText || ref.flags.studioBackdrop) && (
                      <div className={styles.flags}>
                        {ref.flags.hasPeople && <Tag tone="warning">люди</Tag>}
                        {ref.flags.hasText && <Tag tone="warning">текст</Tag>}
                        {ref.flags.studioBackdrop && <Tag tone="info">студия</Tag>}
                      </div>
                    )}
                  </div>
                );
              })}
              {shot.panel.length === 0 && <div className={`${styles.stripEmpty} lab-hatch`}><Text variant="label" tone="tertiary">Панель пуста. Добавь референс локации — без него промпт не соберётся.</Text></div>}
            </div>
            {shot.panel.filter((key) => store.visionReports[key] !== undefined).map((key) => {
              const report = store.visionReports[key];
              if (report === undefined) return null;
              return (
                <div key={key} className={`${styles.report} ${report.ok ? '' : styles.reportBad}`}>
                  <Text variant="label" medium>{refByKey.get(key)?.label}: {report.summaryRu}</Text>
                  {report.risksRu.map((risk, i) => <Text key={i} variant="label" tone="secondary">— {risk}</Text>)}
                  {report.clothingEn !== '' && <Text variant="caption" tone="tertiary" mono>{report.clothingEn}</Text>}
                  {report.flags !== null && (
                    <div className={styles.row}>
                      <Text variant="caption" tone="tertiary">Флаги кормят линтер и клаузу «do not take the background». Ничего не применяется само.</Text>
                      <Button variant="secondary" size="xs" onClick={() => store.applyVisionFlags(key)}>Применить флаги</Button>
                    </div>
                  )}
                </div>
              );
            })}
            <div className={styles.addRow}>
              <TextField label="Новый референс" placeholder="Набережная, Alexander, пикап…" value={newRef.label} onChange={(event) => setNewRef({ ...newRef, label: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && addRef()} />
              <Select label="Что это" value={newRef.kind} onChange={(kind) => setNewRef({ ...newRef, kind: kind as Ref['kind'] })} options={Object.entries(KIND_RU).map(([value, label]) => ({ value, label }))} />
              <Button variant="secondary" size="m" icon={<Icon name="plus" />} onClick={addRef} disabled={newRef.label.trim() === ''}>В панель</Button>
            </div>
          </Section>

          <Section n="03" title="Локация и погода" note="Погода должна давать физику: мокрый асфальт, отражения, пар, ветер. Свет — событие, а не состояние.">
            <div className={styles.pair}>
              <TextField label="Место по-русски" placeholder="Набережная Москвы-реки у парковки, вдали высотка МГУ" value={project.world.place.ru} onChange={(event) => store.update((p) => ({ ...p, world: { ...p.world, place: { ...p.world.place, ru: event.target.value } } }))} />
              <TextField multiline label="Погода и свет по-русски" placeholder="Дождь только закончился, выходит солнце. Мокрый асфальт, лужи, лёгкий ветер." value={project.world.weather.ru} onChange={(event) => store.update((p) => ({ ...p, world: { ...p.world, weather: { ...p.world.weather, ru: event.target.value } } }))} helper="Агент переведёт оба поля, когда будет раскладывать кадр, — если английские ниже пусты." />
            </div>
            <TextField label="Место (английский, в промпт)" placeholder="the embankment of the Moskva River near the parking area" value={project.world.place.en} onChange={(event) => store.update((p) => ({ ...p, world: { ...p.world, place: { ...p.world.place, en: event.target.value, source: 'manual', locked: true } } }))} helper="Продолжает фразу «Location: exactly as in <<<image_1>>> — …»" />
            <TextField label="Что брать с референса" value={project.world.useOnlyEn} onChange={(event) => store.update((p) => ({ ...p, world: { ...p.world, useOnlyEn: event.target.value } }))} helper="Людей с референса промпт игнорирует сам — это дословная формула гайда." />
            <TextField multiline label="Погода, физика, базовый свет (английский)" placeholder="The rain has just stopped, the sun is coming out. Wet asphalt, puddles reflecting the sky…" value={project.world.weather.en} onChange={(event) => store.update((p) => ({ ...p, world: { ...p.world, weather: { ...p.world.weather, en: event.target.value, source: 'manual', locked: true } } }))} />
          </Section>

          <Section n="04" title="Герои и предметы" note="Внешность берётся с character sheet, а не из текста. Под каждый образ — своя карта.">
            {project.entities.map((entity) => (
              <div key={entity.key} className={styles.entityRow}>
                <TextField label="Имя в промпте (латиницей)" value={entity.name} onChange={(event) => store.update((p) => ({ ...p, entities: p.entities.map((e) => (e.key === entity.key ? { ...e, name: event.target.value } : e)) }))} />
                <Select label="Референс" value={entity.refKey ?? ''} onChange={(refKey) => store.update((p) => ({ ...p, entities: p.entities.map((e) => (e.key === entity.key ? { ...e, refKey: refKey === '' ? null : refKey } : e)) }))} options={[{ value: '', label: 'без референса' }, ...project.refs.filter((r) => r.kind !== 'location').map((r) => ({ value: r.key, label: r.label }))]} />
                <Button variant="ghost" size="m" iconOnly aria-label="Удалить" icon={<Icon name="bin" />} onClick={() => store.update((p) => ({ ...p, entities: p.entities.filter((e) => e.key !== entity.key) }))} />
              </div>
            ))}
            <div className={styles.row}>
              <Button variant="secondary" size="s" icon={<Icon name="person" />} onClick={() => store.update((p) => ({ ...p, entities: [...p.entities, { key: `hero-${p.entities.length + 1}-${Date.now().toString(36)}`, name: 'Alexander', kind: 'character', refKey: null }] }))}>Герой</Button>
              <Button variant="secondary" size="s" icon={<Icon name="component" />} onClick={() => store.update((p) => ({ ...p, entities: [...p.entities, { key: `prop-${p.entities.length + 1}-${Date.now().toString(36)}`, name: 'the main pickup', kind: 'object', refKey: null }] }))}>Предмет</Button>
            </div>
          </Section>

          <Section n="05" title="Реплики" note="Текст в «ёлочках» модель озвучит буква в букву. Вычитай каждую — галочка сбросится при правке.">
            {project.lines.map((line) => (
              <div key={line.id} className={styles.lineRow}>
                <Tag tone="accent">{line.id}</Tag>
                <TextField label="Реплика по-русски" value={line.ru} lang="ru" spellCheck onChange={(event) => store.update((p) => ({ ...p, lines: p.lines.map((l) => (l.id === line.id ? { ...l, ru: event.target.value, proofread: false } : l)) }))} helper={`${line.ru.split(/\s+/).filter(Boolean).length} слов`} />
                <Switch checked={line.proofread} onChange={(proofread) => store.update((p) => ({ ...p, lines: p.lines.map((l) => (l.id === line.id ? { ...l, proofread } : l)) }))} label="вычитана" />
              </div>
            ))}
            <div className={styles.row}>
              <Button variant="secondary" size="s" icon={<Icon name="mic" />} onClick={() => store.update((p) => ({ ...p, lines: [...p.lines, { id: nextLineId, speakerKey: null, ru: '', proofread: false }] }))}>Реплика</Button>
            </div>
          </Section>

          <Section n="06" title="Сценарий по таймлайну" note={`Абзац = отрезок времени. Одно главное действие в абзаце; на ${duration} с — ${budget.min === budget.max ? budget.min : `${budget.min}–${budget.max}`} крупных событий (гайд: 4–6 на 30 секунд).`}>
            <div className={styles.synopsis}>
              <TextField multiline label="Кадр своими словами" placeholder="Alexander стоит у пикапа с камерой и говорит в объектив: «Сейчас мы снимаем на Sony VENICE 2.» Потом бросает камеру за кадр, John встаёт в стойку, начинается спарринг…" value={shot.synopsisRu} onChange={(event) => store.updateShot((s) => ({ ...s, synopsisRu: event.target.value }))} helper="Реплики пиши в «ёлочках» — они уйдут в список реплик буква в букву. Агент разложит кадр по времени в пределах бюджета событий." />
              <div className={styles.row}>
                <Text variant="caption" tone="tertiary">{shot.segments.some((s) => s.beatsRu.trim() !== '' || s.text.en.trim() !== '') ? 'Текущие отрезки будут заменены.' : ''}</Text>
                <Button variant="soft" size="s" icon={<Icon name="layers" />} loading={store.planning} disabled={shot.synopsisRu.trim() === ''} onClick={() => void store.planShot()}>
                  {store.planning ? 'Раскладываю…' : 'Разложить по отрезкам'}
                </Button>
              </div>
              {store.planReport !== null && (
                <div className={`${styles.report} ${store.planReport.ok ? '' : styles.reportBad}`}>
                  <Text variant="label" tone="secondary">{store.planReport.messageRu}</Text>
                </div>
              )}
            </div>
            {shot.segments.map((segment, index) => (
              <div key={segment.id} className={styles.segment}>
                <div className={styles.segmentHead}>
                  <Text variant="label" medium>Отрезок {index + 1}</Text>
                  <Tag tone={segment.text.en.trim() === '' ? 'outline' : segment.text.source === 'llm' ? 'accent' : 'neutral'}>{segment.text.en.trim() === '' ? 'пусто' : segment.text.source === 'llm' ? 'агент' : 'вручную'}</Tag>
                  {segment.text.locked && segment.text.en.trim() !== '' && (
                    <Button variant="ghost" size="xs" icon={<Icon name="lock" size={0.875} />} onClick={() => store.updateShot((s) => ({ ...s, segments: s.segments.map((x) => (x.id === segment.id ? { ...x, text: { ...x.text, locked: false } } : x)) }))}>
                      защищён от агента — снять
                    </Button>
                  )}
                  <span className={styles.spacer} />
                  <Button variant="ghost" size="xs" iconOnly aria-label="Удалить отрезок" icon={<Icon name="bin" size={1} />} onClick={() => store.updateShot((s) => ({ ...s, segments: s.segments.filter((x) => x.id !== segment.id) }))} />
                </div>
                <TextField multiline label="Что происходит (по-русски — вход для писателя)" value={segment.beatsRu} onChange={(event) => store.updateShot((s) => ({ ...s, segments: s.segments.map((x) => (x.id === segment.id ? { ...x, beatsRu: event.target.value } : x)) }))} />
                <TextField multiline label="Абзац промпта (английский)" value={segment.text.en} onChange={(event) => store.updateShot((s) => ({ ...s, segments: s.segments.map((x) => (x.id === segment.id ? { ...x, text: { ...x.text, en: event.target.value, source: 'manual', locked: true } } : x)) }))} onFocus={(event) => areas.current.set(segment.id, event.target as HTMLTextAreaElement)} helper="Номера и реплики не пиши руками — вставляй кнопками ниже." />
                {store.writeReport?.notes[segment.id] !== undefined && store.writeReport.notes[segment.id] !== '' && (
                  <div className={styles.agentNote}>
                    <Icon name="sparkles" size={1} />
                    <Text variant="label" tone="secondary">{store.writeReport.notes[segment.id]}</Text>
                  </div>
                )}
                <div className={styles.tokens}>
                  {project.entities.map((entity) => <Button key={entity.key} variant="soft" size="xs" onClick={() => insert(segment.id, `{{intro:${entity.key}}}`)}>{entity.name}</Button>)}
                  {shot.panel.map((key, i) => <Button key={key} variant="border" size="xs" onClick={() => insert(segment.id, `{{ref:${key}}}`)}>№{i + 1} {refByKey.get(key)?.label}</Button>)}
                  {project.lines.map((line) => <Button key={line.id} variant="secondary" size="xs" icon={<Icon name="mic" size={0.875} />} onClick={() => insert(segment.id, `{{line:${line.id}}}`)}>{line.id}</Button>)}
                  {incoming.map((state) => <Button key={state.id} variant="danger" size="xs" icon={<Icon name="pin" size={0.875} />} onClick={() => insert(segment.id, `{{state:${state.id}}}`)}>{state.id} {state.titleRu}</Button>)}
                </div>
              </div>
            ))}
            <div className={styles.row}>
              <Button variant="secondary" size="s" icon={<Icon name="plus" />} onClick={() => store.updateShot((s) => ({ ...s, segments: [...s.segments, { id: `seg-${Date.now().toString(36)}`, titleRu: '', beatsRu: '', text: emptyUnit() }] }))}>Отрезок</Button>
              <div className={styles.writeRow}>
                {store.writing && <Button variant="ghost" size="s" onClick={store.cancelWrite}>Отмена</Button>}
                <Button variant="primary" size="s" icon={<Icon name="sparkles" variant="filled" />} loading={store.writing} disabled={!shot.segments.some((s) => !s.text.locked && s.beatsRu.trim() !== '')} onClick={() => void store.writeShot()}>
                  {store.writing ? 'Агент пишет… до пары минут' : 'Написать кадр'}
                </Button>
              </div>
            </div>
            <Text variant="caption" tone="tertiary">Агент пишет только отрезки с русским описанием, не защищённые от него. Реплики упоминай в описании как L1, L2 — он поставит их в этом порядке.</Text>
            {store.writeReport !== null && (
              <div className={`${styles.report} ${store.writeReport.ok ? '' : styles.reportBad}`}>
                <Text variant="label" medium>{store.writeReport.messageRu}</Text>
                {store.writeReport.warningsRu.map((w, i) => <Text key={`w${i}`} variant="label" tone="secondary">{w}</Text>)}
                {store.writeReport.remainingRu.length > 0 && <Text variant="caption" tone="secondary">Осталось после ремонта: {store.writeReport.remainingRu.join(' · ')}</Text>}
              </div>
            )}
          </Section>

          <Section n="07" title="Память между кадрами" note="Что случилось в кадре N, должно быть видно в кадре N+1. Пиши сторону, степень и ограничитель — иначе модель нарисует разбитое лицо не с той стороны.">
            {incoming.length > 0 && (
              <div className={styles.incoming}>
                <Text variant="caption" tone="secondary">Пришло из прошлых кадров — обязано стоять в сценарии</Text>
                {incoming.map((state) => (
                  <div key={state.id} className={styles.stateRow}>
                    <Tag tone={shot.segments.some((s) => s.text.en.includes(`{{state:${state.id}}}`)) ? 'success' : 'danger'} dot>{state.id}</Tag>
                    <Text variant="label">{state.titleRu || state.en}</Text>
                  </div>
                ))}
              </div>
            )}
            {outcomes.map((state) => (
              <div key={state.id} className={styles.segment}>
                <div className={styles.segmentHead}>
                  <Tag tone="danger">{state.id}</Tag>
                  <Text variant="label" medium>Последствие этого кадра</Text>
                  <span className={styles.spacer} />
                  <Button variant="ghost" size="xs" iconOnly aria-label="Удалить последствие" icon={<Icon name="bin" size={1} />} onClick={() => store.update((p) => ({ ...p, states: p.states.filter((s) => s.id !== state.id) }))} />
                </div>
                <TextField label="Что случилось (по-русски, для себя)" placeholder="Синяк на правой щеке после удара ногой" value={state.titleRu} onChange={(event) => store.update((p) => ({ ...p, states: p.states.map((s) => (s.id === state.id ? { ...s, titleRu: event.target.value } : s)) }))} />
                <TextField multiline label="Каноническая фраза для следующих кадров (английский)" placeholder="Alexander's face shows a slight redness and a small scrape on the right side only — a mark from a recent hit, no blood, no cut, just a light bruise forming under the skin." value={state.en} onChange={(event) => store.update((p) => ({ ...p, states: p.states.map((s) => (s.id === state.id ? { ...s, en: event.target.value } : s)) }))} helper="Агент вставляет эту фразу буква в букву и не перефразирует: сторона, степень, «no blood, no cut»." />
              </div>
            ))}
            <div className={styles.row}>
              <Button variant="secondary" size="s" icon={<Icon name="pin" />} onClick={() => store.update((p) => ({ ...p, states: [...p.states, { id: nextStateId, titleRu: '', en: '', originShotId: shot.id, resolvedInShotId: null }] }))}>Последствие кадра</Button>
            </div>
          </Section>
        </div>

        <aside className={styles.preview}>
          <Card padding="l" elevation="raised" className={styles.previewCard}>
            <div className={styles.meters}>
              <Meter label="Длина" value={build.metrics.chars} max={10000} unit="знаков" />
              <Meter label="Речь" value={build.metrics.speechWords} max={build.metrics.speechCapacity} unit={`/ ${build.metrics.speechCapacity} слов`} tone={speechTone} />
              <Meter label="Референсы" value={build.metrics.refsUsed} max={Math.max(1, build.metrics.refsInPanel)} unit={`/ ${build.metrics.refsInPanel} в панели`} tone={build.metrics.refsUsed < build.metrics.refsInPanel ? 'warning' : 'success'} />
            </div>

            <div className={styles.copyRow}>
              <Button variant="dark" size="m" icon={<Icon name="push" />} disabled={!canCopy} onClick={() => setExportOpen(true)}>
                Забрать в Higgsfield
              </Button>
              {!canCopy ? (
                <button type="button" className={styles.linkButton} onClick={() => document.getElementById('findings')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  <Text variant="caption" tone="secondary">Не готово к генерации: {blocking} — список ниже</Text>
                </button>
              ) : (
                <Text variant="caption" tone="secondary">
                  {shot.critique?.prompt === build.prompt ? `Критик: ${shot.critique.verdict === 'ready' ? 'готов' : shot.critique.verdict === 'risky' ? 'с рисками' : 'не готов'}.` : 'Собран. Настройки, картинки по номерам и промпт — в одном окне.'}
                </Text>
              )}
            </div>
          </Card>

          <ExportCard open={exportOpen} onOpenChange={setExportOpen} project={project} shot={shot} shotIndex={project.shots.findIndex((s) => s.id === shot.id)} build={build} durationSec={duration} warnings={warnings} />

          <Findings
            build={build}
            shot={shot}
            blockLabel={(index) => {
              const paragraph = build.paragraphs[index];
              if (paragraph === undefined) return `абзац ${index + 1}`;
              const segment = paragraph.segmentId === undefined ? -1 : shot.segments.findIndex((s) => s.id === paragraph.segmentId);
              return segment === -1 ? `абзац ${index + 1} · ${BLOCK_RU[paragraph.kind] ?? paragraph.kind}` : `абзац ${index + 1} · отрезок ${segment + 1}`;
            }}
            onSuppress={(fingerprint, reasonRu) => store.updateShot((s) => ({ ...s, suppressed: [...s.suppressed.filter((x) => x.fingerprint !== fingerprint), { fingerprint, reasonRu }] }))}
            onRestore={(fingerprint) => store.updateShot((s) => ({ ...s, suppressed: s.suppressed.filter((x) => x.fingerprint !== fingerprint) }))}
            critic={{ running: store.critiquing, error: store.critiqueError, onRun: () => void store.critiqueShot(), onCancel: store.cancelCritique }}
          />

          <Card padding="l" className={styles.previewCard}>
            <Text variant="caption" tone="secondary">Промпт</Text>
            {build.paragraphs.map((paragraph, i) => (
              <div key={i} id={`p-${i}`} className={styles.paragraph}>
                <div className={styles.paragraphHead}>
                  <Text variant="caption" tone="tertiary" mono>{String(i + 1).padStart(2, '0')}</Text>
                  <Text variant="caption" tone="secondary">{BLOCK_RU[paragraph.kind] ?? paragraph.kind}</Text>
                  <Tag tone={paragraph.origin === 'textUnit' ? 'neutral' : 'outline'}>{paragraph.origin === 'verbatim' ? (paragraph.kind === 'style' && (isCustom || (kit?.source !== undefined && kit.source !== 'guide')) ? 'формула гайда · техника не из гайда' : 'дословно из гайда') : paragraph.origin === 'template' ? 'шаблон' : 'твой текст'}</Tag>
                </div>
                <PromptText text={build.resolvedParagraphs[i] ?? ''} />
              </div>
            ))}
          </Card>

          <Attempts prompt={build.prompt} canSave={canCopy} />
        </aside>
      </div>
    </div>
  );
}
