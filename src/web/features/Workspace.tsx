import { SeriesPreparation } from '../series/SeriesPreparation.tsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { activeCritiqueFindings } from '../../core/review.ts';
import { pendingLabels } from '../../core/compose.ts';
import { buildShot, CUSTOM_KIT, holderName, shootingModeOf, type PackBundle } from '../../core/pipeline.ts';
import { isCanvasRefKey } from '../../core/model/canvas.ts';
import { plural } from '../../core/canvas/seedance.ts';
import { activeStates, ASPECT_RATIOS, CUSTOM_SHOOTING, durationOf, emptyUnit, eventBudget, isObjectRef, needsAgent, REF_KINDS, segmentNeedsWriter, shootingOf, storyboardFrames, syncPanel, type AspectRatio, type Ref, type Segment, type Shooting, type Shot, type Structure } from '../../core/model/project.ts';
import { Button, Card, Icon, Meter, SegmentedControl, Select, Switch, Tag, Text, TextField } from '../ui/components/index.ts';
import { currentShot, downscale, slugify, useStore } from '../store.ts';
import { Attempts } from './Attempts.tsx';
import { ExportCard } from './ExportCard.tsx';
import { Findings } from './Findings.tsx';
import { PromptText } from './PromptText.tsx';
import { ThemeSwitch } from './ThemeSwitch.tsx';
import styles from './Workspace.module.css';

const KIND_RU: Record<Ref['kind'], string> = { location: 'Локация', character: 'Герой', object: 'Предмет', gear: 'Техника', frame: 'Раскадровка', other: 'Другое' };
const STRUCTURE_RU: Record<Structure, string> = { 'one-take': 'Один дубль', cuts: 'Шоты со склейками' };
const BLOCK_RU: Record<string, string> = { style: 'Стиль-блок', format: 'Формат', 'role-shooting': 'Роль: снимающая техника', 'role-props': 'Роль: реквизит', camera: 'Камера', lens: 'Объектив', flare: 'Блик', imperfections: 'Дефекты и речь', 'operator-rule': 'Правило про оператора', location: 'Локация и погода', segment: 'Сценарий' };
const SAVE_RU = { saved: 'сохранено', dirty: 'есть правки…', saving: 'сохраняю…', conflict: 'конфликт окон', error: 'не сохранено' } as const;
const DURATION_PRESETS = [5, 10, 15, 20, 30];

/** Длительность дубля. Черновик живёт в поле: в кадр уходит только целое 4–30, недопечатанное число промпт не ломает. */
function DurationField({ value, onCommit }: { value: number; onCommit: (durationSec: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const parse = (text: string): number | null => (/^\d+$/.test(text.trim()) && Number(text) >= 4 && Number(text) <= 30 ? Number(text) : null);
  const valid = parse(draft) !== null;
  // Длительность поменялась не отсюда (другое окно, восстановление формы браузером) — поле показывает её, а не старый черновик.
  useEffect(() => {
    setDraft((current) => (parse(current) === value ? current : String(value)));
  }, [value]);
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

/** Что агент сделал из русского поля: только для чтения. Устарело — сказано прямо, английский не показывается как верный. */
function Derived({ label, en, pending }: { label: string; en: string; pending: boolean }) {
  if (en.trim() === '' && !pending) return null;
  return (
    <Text variant="caption" tone="tertiary" className={styles.derived}>
      {pending ? 'обновится при сборке' : <>{label}: <span className={styles.derivedEn}>{en}</span></>}
    </Text>
  );
}

function segmentStatus(segment: Segment): { tone: 'outline' | 'warning' | 'neutral'; label: string } {
  if (segment.beatsRu.trim() === '' && segment.text.en.trim() === '') return { tone: 'outline', label: 'пусто' };
  if (segmentNeedsWriter(segment)) return segment.text.en.trim() === '' ? { tone: 'outline', label: 'не написан' } : { tone: 'warning', label: 'изменён — перепишется' };
  return { tone: 'neutral', label: segment.text.source === 'llm' ? 'написан агентом' : 'написан' };
}

/** Seedance-промптер из canvas: тот же редактор кадра — во весь экран поверх холста, холст под ним живой. */
export function WorkspaceOverlay({ pack }: { pack: PackBundle }) {
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Seedance-промптер">
      <Workspace pack={pack} />
    </div>
  );
}

export function Workspace({ pack }: { pack: PackBundle }) {
  const store = useStore();
  const project = store.project;
  const shot = useStore(currentShot);
  const inCanvas = store.host !== null;
  const [exportOpen, setExportOpen] = useState(false);
  const [visionAgreed, setVisionAgreed] = useState(false);
  const [newRef, setNewRef] = useState<{ label: string; kind: Ref['kind'] }>({ label: '', kind: 'location' });
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
  const gearRefs = shot.panel.flatMap((key) => { const ref = project.refs.find((r) => r.key === key); return ref !== undefined && isObjectRef(ref) ? [ref] : []; });
  const characters = project.entities.filter((e) => e.kind === 'character');
  const setRole = (patch: Partial<NonNullable<Shot['roleSplit']>>): void => store.updateShot((s) => (s.roleSplit === null ? s : { ...s, roleSplit: { ...s.roleSplit, ...patch } }));
  const setWorld = (field: 'place' | 'weather', ru: string): void => store.update((p) => ({ ...p, world: { ...p.world, [field]: { ...p.world[field], ru } } }));

  // Кнопка учитывает и последствия этого кадра для следующих — блокер кадра о них молчит.
  const pending = pendingLabels(project, shot, 'compose');
  const described = shot.segments.some((s) => s.beatsRu.trim() !== '');
  const composeLabel = store.composing === 'fields' ? 'Перевожу поля…' : store.composing === 'writing' ? 'Пишу отрезки…' : pending.length > 0 ? 'Собрать промпт' : 'Переписать кадр';

  const addRef = (): void => {
    const label = newRef.label.trim();
    if (label === '') return;
    const taken = new Set(project.refs.map((ref) => ref.key));
    let key = slugify(label);
    for (let n = 2; taken.has(key); n += 1) key = `${slugify(label)}-${n}`;
    store.update((p) => {
      const next = { ...p, refs: [...p.refs, { key, label, kind: newRef.kind, file: null, flags: { hasPeople: false, hasText: false, studioBackdrop: false } }] };
      return { ...next, shots: next.shots.map((s) => (s.id === shot.id ? syncPanel(next, { ...s, panel: [...s.panel, key] }) : s)) };
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
        return syncPanel(p, { ...s, panel });
      }),
    }));

  const removeFromPanel = (key: string): void => store.update((p) => ({ ...p, shots: p.shots.map((s) => (s.id === shot.id ? syncPanel(p, { ...s, panel: s.panel.filter((k) => k !== key) }) : s)) }));

  // Тип картинки меняет её роль во всех кадрах ролика: локация, кадр раскадровки, герой…
  const setRefKind = (key: string, kind: Ref['kind']): void =>
    store.update((p) => {
      const next = { ...p, refs: p.refs.map((r) => (r.key === key ? { ...r, kind } : r)) };
      return { ...next, shots: next.shots.map((s) => (s.panel.includes(key) ? syncPanel(next, s) : s)) };
    });

  const shooting = shootingOf(shot);
  const resolvedShooting = shootingModeOf(shot, pack);
  const modes = pack.shooting?.modes ?? [];
  const cuts = shooting.structure === 'cuts';
  const setShooting = (patch: Partial<Shooting>): void => store.updateShot((s) => ({ ...s, shooting: { ...shootingOf(s), ...patch } }));
  const shootingPending = shooting.mode === CUSTOM_SHOOTING && needsAgent((shooting.ru ?? '').trim(), shooting.operation, shooting.enFor, false);

  // Кадры раскадровки по порядку: отрезок N открывается на кадре N. Недостающие отрезки создаются, лишние не трогаются.
  const frames = storyboardFrames(project, shot);
  const bindFrames = (): void =>
    store.updateShot((s) => {
      const stamp = Date.now().toString(36);
      const segments = frames.map((frame, i) => {
        const existing = s.segments[i];
        return existing === undefined ? { id: `seg-${stamp}-${i + 1}`, titleRu: '', beatsRu: '', text: emptyUnit(), frameRef: frame.key } : { ...existing, frameRef: frame.key };
      });
      return { ...s, segments: [...segments, ...s.segments.slice(frames.length)] };
    });
  const unitLabel = cuts ? 'Шот' : 'Отрезок';

  const upload = async (ref: Ref, file: File): Promise<void> => {
    const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
    const fileName = `${ref.key}.${['jpg', 'png', 'webp'].includes(ext) ? ext : 'jpg'}`;
    await store.uploadRef(file, fileName);
    // Уменьшенная копия для vision-анализа: сама никуда не уходит, пока владелец не нажмёт «Анализ».
    await downscale(file).then((blob) => store.uploadRef(new File([blob], `${ref.key}-vision.jpg`), `${ref.key}-vision.jpg`)).catch(() => undefined);
    store.update((p) => ({ ...p, refs: p.refs.map((r) => (r.key === ref.key ? { ...r, file: `${fileName}?v=${Date.now()}` } : r)) }));
  };

  // Гейт «наружу»: картинка уходит в OpenAI только после явного согласия, один раз на сессию.
  const confirmVision = (key: string): void => {
    if (!visionAgreed && !window.confirm('Уменьшенная копия этой картинки уйдёт в OpenAI через Codex для анализа. На референсе может быть твоё лицо. Отправить?')) return;
    setVisionAgreed(true);
    void store.analyzeRef(key);
  };

  const scrollToParagraph = (segmentId: string): void => {
    const index = build.paragraphs.findIndex((p) => p.segmentId === segmentId);
    if (index !== -1) document.getElementById(`p-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const refByKey = new Map(project.refs.map((ref) => [ref.key, ref]));
  const incoming = activeStates(project, shot.id);
  const outcomes = project.states.filter((state) => state.originShotId === shot.id);
  const nextStateId = `S${Math.max(0, ...project.states.map((s) => Number(s.id.slice(1)))) + 1}`;
  const nextLineId = `L${Math.max(0, ...project.lines.map((l) => Number(l.id.slice(1)))) + 1}`;
  const { place, weather } = project.world;
  const kitPending = needsAgent((shot.customKit.ru ?? '').trim(), shot.customKit.camera, shot.customKit.enFor, false);
  const propsPending = shot.roleSplit !== null && needsAgent((shot.roleSplit.propsRu ?? '').trim(), shot.roleSplit.propsEn, shot.roleSplit.propsFor, false);

  return (
    <div className={styles.shell}>
      <header className={`${styles.topbar} lab-glass-thin`}>
        <Button variant="ghost" size="xs" icon={<Icon name="chevron-back" size={1} />} onClick={() => void store.closeProject()}>{inCanvas ? 'Canvas' : 'Ролики'}</Button>
        {inCanvas ? (
          <>
            <Text variant="label" medium>Seedance-промптер</Text>
            <Tag tone="outline">нода canvas</Tag>
          </>
        ) : (
          <>
            <Text variant="label" medium>{project.title}</Text>
            <SegmentedControl aria-label="Кадры ролика" size="s" value={shot.id} onChange={store.selectShot} options={project.shots.map((s, i) => ({ value: s.id, label: `Кадр ${i + 1}` }))} />
            <Button variant="ghost" size="xs" icon={<Icon name="plus" size={1} />} onClick={store.addShot}>кадр</Button>
          </>
        )}
        <span className={styles.spacer} />
        <Tag tone={store.save === 'saved' ? 'neutral' : store.save === 'conflict' || store.save === 'error' ? 'danger' : 'outline'}>{SAVE_RU[store.save]}</Tag>
        <ThemeSwitch />
        {store.composing !== null && <Button variant="ghost" size="s" onClick={store.cancelCompose}>Отмена</Button>}
        <Button variant="primary" size="s" icon={<Icon name="sparkles" variant="filled" />} loading={store.composing !== null} disabled={store.composing === null && pending.length === 0 && !described} onClick={() => void store.composeShot(pending.length === 0)} title={pending.length > 0 ? `Агент перепишет в промпт: ${pending.join(', ')}` : 'Переписать все отрезки кадра заново'}>
          {composeLabel}
        </Button>
      </header>

      <div className={styles.columns}>
        <div className={styles.form}>
          {project.production && <SeriesPreparation key={project.slug} project={project} />}
          <Section n="01" title="Как снято" note="Сначала «как снято», потом «что снято». Комплект — одна переменная на все места промпта.">
            <div className={styles.aspect}>
              <Text variant="label" tone="secondary">Формат кадра</Text>
              <SegmentedControl<AspectRatio> aria-label="Формат кадра" size="s" value={project.aspectRatio} onChange={(aspectRatio) => store.update((p) => ({ ...p, aspectRatio }))} options={ASPECT_RATIOS.map((value) => ({ value, label: value, title: pack.dialects.aspect?.labelsRu[value] }))} />
              <Text variant="caption" tone="tertiary">{pack.dialects.aspect?.labelsRu[project.aspectRatio] ?? ''} · общий для всех кадров ролика; это же значение выставь в Higgsfield.</Text>
            </div>
            <DurationField key={shot.id} value={duration} onCommit={(durationSec) => store.updateShot((s) => ({ ...s, durationSec }))} />
            {modes.length > 0 && (
              <div className={styles.group}>
                <Text variant="label" tone="secondary">Съёмка — как работает камера</Text>
                <div className={styles.kits}>
                  {modes.map((mode) => (
                    <button key={mode.id} type="button" className={`${styles.kit} ${shooting.mode === mode.id ? styles.kitOn : ''}`} onClick={() => setShooting({ mode: mode.id })} aria-pressed={shooting.mode === mode.id}>
                      <Text variant="label" medium>{mode.titleRu}</Text>
                      {mode.source === 'guide' ? <Tag tone="neutral">метод гайда</Tag> : <Tag tone="outline">не из гайда</Tag>}
                    </button>
                  ))}
                </div>
                {resolvedShooting.mode !== undefined && (
                  <div className={styles.report}>
                    <Text variant="label" tone="secondary">{resolvedShooting.mode.noteRu}</Text>
                  </div>
                )}
                {shooting.mode === CUSTOM_SHOOTING && (
                  <div className={styles.customKit}>
                    <TextField
                      multiline
                      label="Как работает камера — своими словами"
                      placeholder="Камера на скейте в сантиметрах от асфальта, летит за героем, на поворотах заносит вбок"
                      value={shooting.ru ?? ''}
                      onChange={(event) => setShooting({ ru: event.target.value })}
                      helper="На чём стоит камера или кто её несёт, как двигается, как ведёт героя. Модель камеры — ниже, в «Камера». Агент перепишет это в стиль-блок и в язык камеры для писателя."
                    />
                    <Derived label="в промпте" en={shooting.operation} pending={shootingPending} />
                    {!shootingPending && shooting.language.trim() !== '' && <Derived label="писателю" en={shooting.language} pending={false} />}
                  </div>
                )}
                <div className={styles.aspect}>
                  <Text variant="label" tone="secondary">Монтаж</Text>
                  <SegmentedControl<Structure> aria-label="Монтаж" size="s" value={shooting.structure} onChange={(structure) => setShooting({ structure })} options={(['one-take', 'cuts'] as const).map((value) => ({ value, label: STRUCTURE_RU[value] }))} />
                  <Text variant="caption" tone="tertiary">
                    {cuts
                      ? 'Каждый отрезок сценария — отдельный шот, между шотами склейки; всё — одна генерация. Мультишот в Seedance 2.5 заявлен официально, формула склеек не из гайда — проверяется прогоном.'
                      : 'Один непрерывный дубль без склеек — как в гайде.'}
                  </Text>
                </div>
              </div>
            )}
            <Text variant="label" tone="secondary">Камера</Text>
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
                <Text variant="caption" tone="secondary">любая техника — описываешь своими словами</Text>
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
                <TextField
                  multiline
                  label="Камера и картинка — своими словами"
                  placeholder="Fujifilm X100V со встроенным 23 мм. Мелкое цифровое зерно, приглушённые цвета с зеленцой, мягкий контраст, углы чуть мягче центра"
                  value={shot.customKit.ru ?? ''}
                  onChange={(event) => store.updateShot((s) => ({ ...s, customKit: { ...s.customKit, ru: event.target.value } }))}
                  helper="Нужна реальная модель — «кинокамера» не якорь, модель выберет усреднённую картинку. Зерно, цвет, контраст, блики — тезисно. Агент перепишет это в формулу гайда «shot on … with …»."
                />
                <Derived label="в промпте" en={shot.customKit.camera.trim() === '' ? '' : `shot on ${shot.customKit.camera}${shot.customKit.lens.trim() !== '' ? ` with ${shot.customKit.lens}` : ''}, ${shot.customKit.look}.${shot.customKit.lensNote.trim() !== '' ? ` ${shot.customKit.lensNote}.` : ''}`} pending={kitPending} />
              </div>
            )}
            {kit?.layout === 'split' && (
              <div className={styles.customKit}>
                <Switch checked={shot.roleSplit !== null} onChange={(on) => store.updateShot((s) => ({ ...s, roleSplit: on ? { cameraRef: gearRefs[0]?.key ?? '', lensRef: gearRefs[1]?.key ?? gearRefs[0]?.key ?? '', cameraHolderKey: characters[0]?.key, lensHolderKey: characters[1]?.key ?? characters[0]?.key, cameraHolder: '', lensHolder: '', propsRu: '', propsEn: '' } : null }))} label="В кадре есть такая же камера или объектив как реквизит" disabled={shot.roleSplit === null && gearRefs.length === 0} />
                <Text variant="caption" tone="tertiary">
                  {shot.roleSplit === null
                    ? gearRefs.length === 0 ? 'Приём 06 «один объект — одна роль». Нужен, только когда герои держат эту же технику в руках; для него добавь в панель референсы камеры и объектива (тип «Техника»).' : 'Приём 06 «один объект — одна роль». Без реквизита разделение не нужно — кадр собирается как есть.'
                    : 'Промпт разведёт снимающую технику и реквизит: блики и боке — только «on the image itself», на предметах в руках их не будет.'}
                </Text>
                {shot.roleSplit !== null && (
                  <>
                    <div className={styles.twoCols}>
                      <Select label="Референс камеры" value={shot.roleSplit.cameraRef} onChange={(cameraRef) => setRole({ cameraRef })} options={gearRefs.map((r) => ({ value: r.key, label: r.label }))} />
                      <Select label="Референс объектива" value={shot.roleSplit.lensRef} onChange={(lensRef) => setRole({ lensRef })} options={gearRefs.map((r) => ({ value: r.key, label: r.label }))} />
                    </div>
                    <div className={styles.twoCols}>
                      <Select label="Кто держит камеру" value={shot.roleSplit.cameraHolderKey ?? ''} onChange={(cameraHolderKey) => setRole({ cameraHolderKey })} options={[{ value: '', label: characters.length === 0 ? 'сначала добавь героя в секции 04' : 'не выбран' }, ...characters.map((e) => ({ value: e.key, label: e.nameRu?.trim() || e.name }))]} />
                      <Select label="Кто показывает объектив" value={shot.roleSplit.lensHolderKey ?? ''} onChange={(lensHolderKey) => setRole({ lensHolderKey })} options={[{ value: '', label: characters.length === 0 ? 'сначала добавь героя в секции 04' : 'не выбран' }, ...characters.map((e) => ({ value: e.key, label: e.nameRu?.trim() || e.name }))]} />
                    </div>
                    {(shot.roleSplit.cameraHolderKey === undefined || shot.roleSplit.cameraHolderKey === '') && shot.roleSplit.cameraHolder !== '' && <Text variant="caption" tone="tertiary">Из старой версии: камеру держит {holderName(project, undefined, shot.roleSplit.cameraHolder)}, объектив — {shot.roleSplit.lensHolder}.</Text>}
                    <TextField multiline label="Реквизит — кто что держит" placeholder="Саша держит в руках RED V-RAPTOR, Женя — открытый кейс с объективами Laowa Proteus" value={shot.roleSplit.propsRu ?? ''} onChange={(event) => setRole({ propsRu: event.target.value })} />
                    <Derived label="в промпте" en={shot.roleSplit.propsEn === '' ? '' : `Separately, ${shot.roleSplit.propsEn}.`} pending={propsPending} />
                  </>
                )}
              </div>
            )}
            <details className={styles.more}>
              <summary><Text as="span" variant="label" tone="secondary">Формулы гайда — обычно не трогать</Text></summary>
              <div className={styles.moreBody}>
                <div className={styles.row}>
                  <Text variant="label" tone="secondary">{resolvedShooting.guide ? 'Правило «оператор не виден»' : 'Правило «съёмочная группа не видна»'}</Text>
                  <SegmentedControl aria-label="Правило про оператора" size="s" value={shot.operatorRule} onChange={(operatorRule) => store.updateShot((s) => ({ ...s, operatorRule }))} options={[{ value: 'long', label: 'Полное' }, { value: 'short', label: 'Краткое' }, { value: 'off', label: 'Нет' }]} />
                </div>
                <div className={styles.row}>
                  <Text variant="label" tone="secondary">Формула референса локации</Text>
                  <SegmentedControl aria-label="Формула локации" size="s" value={shot.locationRule} onChange={(locationRule) => store.updateShot((s) => ({ ...s, locationRule }))} options={[{ value: 'short', label: 'Краткая' }, { value: 'long', label: 'С повтором номеров' }]} />
                </div>
              </div>
            </details>
          </Section>

          <Section n="02" title="Панель референсов" note="Порядок картинок — это нумерация в тексте. Загружай в Higgsfield в том же порядке.">
            {inCanvas && (
              <Text variant="caption" tone="tertiary">
                Картинки, подключённые к ноде проводками в canvas, приходят сюда сами при каждом открытии; проводок снят — картинка уходит из панели. Тип и порядок задаёшь здесь: сгенерированные кадры по умолчанию — «Кадр раскадровки».
              </Text>
            )}
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
                    <span title={ref.note}>
                      <Text variant="caption" medium>{ref.label}</Text>
                    </span>
                    <select className={styles.kindSelect} value={ref.kind} aria-label={`Что это: ${ref.label}`} onChange={(event) => setRefKind(key, event.target.value as Ref['kind'])}>
                      {REF_KINDS.map((kind) => (
                        <option key={kind} value={kind}>{KIND_RU[kind]}</option>
                      ))}
                    </select>
                    {isCanvasRefKey(key) && (
                      <span className={styles.refTag}>
                        <Tag tone="outline">из canvas</Tag>
                      </span>
                    )}
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
              <TextField label="Новый референс" placeholder="Набережная, Саша, пикап…" value={newRef.label} onChange={(event) => setNewRef({ ...newRef, label: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && addRef()} />
              <Select label="Что это" value={newRef.kind} onChange={(kind) => setNewRef({ ...newRef, kind: kind as Ref['kind'] })} options={Object.entries(KIND_RU).map(([value, label]) => ({ value, label }))} />
              <Button variant="secondary" size="m" icon={<Icon name="plus" />} onClick={addRef} disabled={newRef.label.trim() === ''}>В панель</Button>
            </div>
          </Section>

          <Section n="03" title="Локация и погода" note="Тезисно, как думаешь. Агент допишет физику, которую модель умеет рисовать: мокрый асфальт, отражения, пар, ветер.">
            <TextField label="Место" placeholder="Набережная Москвы-реки у парковки, вдали высотка МГУ" value={place.ru} onChange={(event) => setWorld('place', event.target.value)} helper="Что это за место и что в нём видно. Как оно выглядит, модель возьмёт с референса локации." />
            <TextField multiline label="Погода и свет" placeholder="Дождь только закончился, выходит солнце. Мокрый асфальт, лужи, лёгкий ветер." value={weather.ru} onChange={(event) => setWorld('weather', event.target.value)} helper="Базовое состояние на весь дубль. Если свет меняется по ходу — это событие, пиши его в сценарий." />
            {place.ru.trim() === '' && place.en.trim() !== '' && <Derived label="место в промпте (из старой версии)" en={place.en} pending={false} />}
            {weather.ru.trim() === '' && weather.en.trim() !== '' && <Derived label="погода в промпте (из старой версии)" en={weather.en} pending={false} />}
          </Section>

          <Section n="04" title="Герои и предметы" note="Внешность берётся с character sheet, а не из текста. Здесь — как ты их называешь; имя для промпта агент сделает сам.">
            {project.entities.map((entity) => (
              <div key={entity.key} className={styles.entity}>
                <div className={styles.entityRow}>
                  <TextField label={entity.kind === 'character' ? 'Кто это' : 'Что это'} placeholder={entity.kind === 'character' ? 'Саша' : 'пикап'} value={entity.nameRu ?? ''} onChange={(event) => store.update((p) => ({ ...p, entities: p.entities.map((e) => (e.key === entity.key ? { ...e, nameRu: event.target.value } : e)) }))} />
                  <Select label="Референс" value={entity.refKey ?? ''} onChange={(refKey) => store.update((p) => ({ ...p, entities: p.entities.map((e) => (e.key === entity.key ? { ...e, refKey: refKey === '' ? null : refKey } : e)) }))} options={[{ value: '', label: 'без референса' }, ...project.refs.filter((r) => r.kind !== 'location').map((r) => ({ value: r.key, label: r.label }))]} />
                  <Button variant="ghost" size="m" iconOnly aria-label="Удалить" icon={<Icon name="bin" />} onClick={() => store.update((p) => ({ ...p, entities: p.entities.filter((e) => e.key !== entity.key) }))} />
                </div>
                <Derived label="в промпте" en={entity.name} pending={needsAgent((entity.nameRu ?? '').trim(), entity.name, entity.nameFor, false)} />
              </div>
            ))}
            <div className={styles.row}>
              <Button variant="secondary" size="s" icon={<Icon name="person" />} onClick={() => store.update((p) => ({ ...p, entities: [...p.entities, { key: `hero-${p.entities.length + 1}-${Date.now().toString(36)}`, nameRu: '', name: '', kind: 'character', refKey: null }] }))}>Герой</Button>
              <Button variant="secondary" size="s" icon={<Icon name="component" />} onClick={() => store.update((p) => ({ ...p, entities: [...p.entities, { key: `prop-${p.entities.length + 1}-${Date.now().toString(36)}`, nameRu: '', name: '', kind: 'object', refKey: null }] }))}>Предмет</Button>
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

          <Section
            n="06"
            title={cuts ? 'Сценарий по шотам' : 'Сценарий по таймлайну'}
            note={`${cuts ? 'Абзац = шот: своя крупность и ракурс, одно главное действие, между шотами склейка.' : 'Абзац = отрезок времени. Одно главное действие в отрезке;'} На ${duration} с — ${budget.min === budget.max ? budget.min : `${budget.min}–${budget.max}`} крупных событий (гайд: 4–6 на 30 секунд).`}
          >
            {frames.length > 0 && (
              <div className={styles.report}>
                <Text variant="label" tone="secondary">
                  Кадров раскадровки в панели: {frames.length}. {unitLabel} N открывается на кадре N — фразу-привязку пишет компилятор, писатель продолжает с этого момента. «{cuts ? 'Разложить по шотам' : 'Разложить по отрезкам'}» сделает ровно {frames.length} {cuts ? plural(frames.length, 'шот', 'шота', 'шотов') : plural(frames.length, 'отрезок', 'отрезка', 'отрезков')}.
                </Text>
                <div className={styles.row}>
                  <Text variant="caption" tone="tertiary">Уже есть отрезки — им проставятся кадры по порядку, текст не тронется.</Text>
                  <Button variant="secondary" size="s" icon={<Icon name="layers" />} onClick={bindFrames}>
                    Привязать кадры по порядку
                  </Button>
                </div>
              </div>
            )}
            <div className={styles.synopsis}>
              <TextField multiline label="Кадр своими словами" placeholder="Саша стоит у пикапа с камерой и говорит в объектив: «Сейчас мы снимаем на Sony VENICE 2.» Потом бросает камеру за кадр, Женя встаёт в стойку, начинается спарринг…" value={shot.synopsisRu} onChange={(event) => store.updateShot((s) => ({ ...s, synopsisRu: event.target.value }))} helper="Реплики пиши в «ёлочках» — они уйдут в список реплик буква в букву. Агент разложит кадр по времени в пределах бюджета событий." />
              <div className={styles.row}>
                <Text variant="caption" tone="tertiary">{shot.segments.some((s) => s.beatsRu.trim() !== '' || s.text.en.trim() !== '') ? 'Текущие отрезки будут заменены.' : ''}</Text>
                <Button variant="soft" size="s" icon={<Icon name="layers" />} loading={store.planning} disabled={shot.synopsisRu.trim() === ''} onClick={() => void store.planShot()}>
                  {store.planning ? 'Раскладываю…' : cuts ? 'Разложить по шотам' : 'Разложить по отрезкам'}
                </Button>
              </div>
              {store.planReport !== null && (
                <div className={`${styles.report} ${store.planReport.ok ? '' : styles.reportBad}`}>
                  <Text variant="label" tone="secondary">{store.planReport.messageRu}</Text>
                </div>
              )}
            </div>
            {shot.segments.map((segment, index) => {
              const status = segmentStatus(segment);
              const note = store.writeReport?.notes[segment.id];
              return (
                <div key={segment.id} className={styles.segment}>
                  <div className={styles.segmentHead}>
                    <Text variant="label" medium>{unitLabel} {index + 1}</Text>
                    <Tag tone={status.tone}>{status.label}</Tag>
                    <span className={styles.spacer} />
                    {segment.text.en.trim() !== '' && <Button variant="ghost" size="xs" icon={<Icon name="arrow-forward" size={0.875} />} onClick={() => scrollToParagraph(segment.id)}>в промпте</Button>}
                    <Button variant="ghost" size="xs" iconOnly aria-label="Удалить отрезок" icon={<Icon name="bin" size={1} />} onClick={() => store.updateShot((s) => ({ ...s, segments: s.segments.filter((x) => x.id !== segment.id) }))} />
                  </div>
                  {frames.length > 0 && (
                    <div className={styles.frameRow}>
                      {(() => {
                        const frame = frames.find((f) => f.key === segment.frameRef);
                        return frame?.file !== null && frame?.file !== undefined ? <img className={styles.frameThumb} src={`/api/projects/${project.slug}/refs/${frame.file}`} alt={frame.label} /> : <span className={`${styles.frameThumb} lab-hatch`} />;
                      })()}
                      <Select
                        label="Открывается на кадре раскадровки"
                        value={segment.frameRef ?? ''}
                        onChange={(frameRef) => store.updateShot((s) => ({ ...s, segments: s.segments.map((x) => (x.id === segment.id ? { ...x, frameRef: frameRef === '' ? null : frameRef } : x)) }))}
                        options={[{ value: '', label: 'без кадра' }, ...frames.map((f) => ({ value: f.key, label: `№${shot.panel.indexOf(f.key) + 1} · ${f.label}` }))]}
                      />
                    </div>
                  )}
                  <TextField multiline label="Что происходит" value={segment.beatsRu} onChange={(event) => store.updateShot((s) => ({ ...s, segments: s.segments.map((x) => (x.id === segment.id ? { ...x, beatsRu: event.target.value } : x)) }))} />
                  {note !== undefined && note !== '' && (
                    <div className={styles.agentNote}>
                      <Icon name="sparkles" size={1} />
                      <Text variant="label" tone="secondary">{note}</Text>
                    </div>
                  )}
                </div>
              );
            })}
            <div className={styles.row}>
              <Button variant="secondary" size="s" icon={<Icon name="plus" />} onClick={() => store.updateShot((s) => ({ ...s, segments: [...s.segments, { id: `seg-${Date.now().toString(36)}`, titleRu: '', beatsRu: '', text: emptyUnit() }] }))}>{unitLabel}</Button>
            </div>
            <Text variant="caption" tone="tertiary">Реплики упоминай в отрезке как L1, L2 — агент поставит их в этом порядке. Номера картинок, реплики и последствия прошлых кадров он вставит сам; английский текст — в превью справа.</Text>
          </Section>

          <Section n="07" title="Память между кадрами" note="Что случилось в этом кадре, должно быть видно в следующих. Агент вставит это в них сам.">
            {incoming.length > 0 && (
              <div className={styles.incoming}>
                <Text variant="caption" tone="secondary">Пришло из прошлых кадров — агент обязан показать это здесь</Text>
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
                <TextField multiline label="Что осталось после кадра" placeholder="Лёгкий синяк на правой щеке у Саши, без крови и порезов" value={state.titleRu} onChange={(event) => store.update((p) => ({ ...p, states: p.states.map((s) => (s.id === state.id ? { ...s, titleRu: event.target.value } : s)) }))} helper="Сторона, насколько сильно и чего нет — иначе модель нарисует разбитое лицо не с той стороны." />
                <Derived label="в следующих кадрах" en={state.en} pending={needsAgent(state.titleRu, state.en, state.enFor)} />
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
                  {shot.critique?.prompt === build.prompt ? `Критик: замечаний осталось ${activeCritiqueFindings(shot, build.prompt).length}.` : 'Собран. Настройки, картинки по номерам и промпт — в одном окне.'}
                </Text>
              )}
            </div>

            {store.writeReport !== null && (
              <div className={`${styles.report} ${store.writeReport.ok ? '' : styles.reportBad}`}>
                <Text variant="label" medium>{store.writeReport.messageRu}</Text>
                {store.writeReport.fieldsNoteRu !== '' && <Text variant="label" tone="secondary">{store.writeReport.fieldsNoteRu}</Text>}
                {store.writeReport.warningsRu.map((w, i) => <Text key={`w${i}`} variant="label" tone="secondary">{w}</Text>)}
                {store.writeReport.remainingRu.length > 0 && <Text variant="caption" tone="secondary">Осталось после ремонта: {store.writeReport.remainingRu.join(' · ')}</Text>}
              </div>
            )}
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
            onSuppress={(fingerprint, reasonRu, messageRu) => store.updateShot((s) => ({ ...s, suppressed: [...s.suppressed.filter((x) => x.fingerprint !== fingerprint), { fingerprint, reasonRu, messageRu }] }))}
            onRestore={(fingerprint) => store.updateShot((s) => ({ ...s, suppressed: s.suppressed.filter((x) => x.fingerprint !== fingerprint) }))}
            critic={{ running: store.critiquing, error: store.critiqueError, onRun: () => void store.critiqueShot(), onCancel: store.cancelCritique }}
          />

          <Card padding="l" className={styles.previewCard}>
            <Text variant="caption" tone="secondary">Промпт — его пишут агенты из твоих полей</Text>
            {build.paragraphs.map((paragraph, i) => (
              <div key={i} id={`p-${i}`} className={styles.paragraph}>
                <div className={styles.paragraphHead}>
                  <Text variant="caption" tone="tertiary" mono>{String(i + 1).padStart(2, '0')}</Text>
                  <Text variant="caption" tone="secondary">{BLOCK_RU[paragraph.kind] ?? paragraph.kind}</Text>
                  <Tag tone={paragraph.origin === 'textUnit' ? 'neutral' : paragraph.origin === 'derived' ? 'warning' : 'outline'}>{paragraph.origin === 'verbatim' ? (paragraph.kind === 'style' && (isCustom || (kit?.source !== undefined && kit.source !== 'guide')) ? 'формула гайда · техника не из гайда' : 'дословно из гайда') : paragraph.origin === 'derived' ? `режим «${resolvedShooting.mode?.titleRu ?? shooting.mode}» · не из гайда` : paragraph.origin === 'template' ? 'формула гайда + твои поля' : 'агент по твоим битам'}</Tag>
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
