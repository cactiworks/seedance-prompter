import { useMemo, useRef, useState, type ReactNode } from 'react';
import { buildShot, type PackBundle } from '../../core/pipeline.ts';
import { activeStates, emptyUnit, type Project, type Ref, type Shot } from '../../core/model/project.ts';
import { Button, Card, Icon, Meter, SegmentedControl, Select, Switch, Tag, Text, TextField, type TagTone } from '../ui/components/index.ts';
import { currentShot, slugify, useStore } from '../store.ts';
import styles from './Workspace.module.css';

const KIND_RU: Record<Ref['kind'], string> = { location: 'Локация', character: 'Герой', object: 'Предмет', gear: 'Техника', other: 'Другое' };
const BLOCK_RU: Record<string, string> = { style: 'Стиль-блок', format: 'Формат', 'role-shooting': 'Роль: снимающая техника', 'role-props': 'Роль: реквизит', camera: 'Камера', lens: 'Объектив', flare: 'Блик', imperfections: 'Дефекты и речь', 'operator-rule': 'Правило про оператора', location: 'Локация и погода', segment: 'Сценарий' };
const SEVERITY: Record<string, { tone: TagTone; label: string }> = { error: { tone: 'danger', label: 'error' }, warning: { tone: 'warning', label: 'warning' }, info: { tone: 'info', label: 'info' } };
const SAVE_RU = { saved: 'сохранено', dirty: 'есть правки…', saving: 'сохраняю…', conflict: 'конфликт окон', error: 'не сохранено' } as const;

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

/** Подсветка того, что поставил компилятор: ссылки, реплики, неразвёрнутые плейсхолдеры. */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(<<<image_\d+>>>|@Image \d+|«[^»]*»|\{\{[^}]*\}\})/g);
  return (
    <>
      {parts.map((part, i) => {
        if (/^(?:<<<image_\d+>>>|@Image \d+)$/.test(part)) return <span key={i} className={`${styles.hl} ${styles.hlRef}`}>{part}</span>;
        if (part.startsWith('«')) return <span key={i} className={`${styles.hl} ${styles.hlSay}`}>{part}</span>;
        if (part.startsWith('{{')) return <span key={i} className={`${styles.hl} ${styles.hlBad}`}>{part}</span>;
        return <span key={i}>{part}</span>;
      })}
    </>
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
  const [copied, setCopied] = useState(false);
  const [newRef, setNewRef] = useState<{ label: string; kind: Ref['kind'] }>({ label: '', kind: 'location' });
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  const fileInputs = useRef(new Map<string, HTMLInputElement>());

  const build = useMemo(() => (project !== null && shot !== null ? buildShot(project, shot, pack) : null), [project, shot, pack]);
  if (project === null || shot === null || build === null) return null;

  const errors = build.findings.filter((f) => f.severity === 'error').length;
  const usedLines = project.lines.filter((line) => shot.segments.some((s) => s.text.en.includes(`{{line:${line.id}}}`)));
  const unread = usedLines.filter((line) => !line.proofread).length;
  const canCopy = build.blockers.length === 0 && errors === 0 && unread === 0;
  const speechTone = build.metrics.speechWords > build.metrics.speechCapacity ? 'warning' : 'accent';

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
    store.update((p) => ({ ...p, refs: p.refs.map((r) => (r.key === ref.key ? { ...r, file: `${fileName}?v=${Date.now()}` } : r)) }));
  };

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(build.prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
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
            <div className={styles.kits}>
              {Object.values(pack.kits).map((kit) => (
                <button key={kit.id} type="button" className={`${styles.kit} ${shot.kitId === kit.id ? styles.kitOn : ''}`} onClick={() => store.updateShot((s) => ({ ...s, kitId: kit.id, defects: null }))} aria-pressed={shot.kitId === kit.id}>
                  <Text variant="label" medium>{kit.anchor.split(' with ')[0]}</Text>
                  <Text variant="caption" tone="secondary">{kit.titleRu.split(' — ')[1] ?? kit.titleRu}</Text>
                </button>
              ))}
            </div>
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
                  </div>
                );
              })}
              {shot.panel.length === 0 && <div className={`${styles.stripEmpty} lab-hatch`}><Text variant="label" tone="tertiary">Панель пуста. Добавь референс локации — без него промпт не соберётся.</Text></div>}
            </div>
            <div className={styles.addRow}>
              <TextField label="Новый референс" placeholder="Набережная, Alexander, пикап…" value={newRef.label} onChange={(event) => setNewRef({ ...newRef, label: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && addRef()} />
              <Select label="Что это" value={newRef.kind} onChange={(kind) => setNewRef({ ...newRef, kind: kind as Ref['kind'] })} options={Object.entries(KIND_RU).map(([value, label]) => ({ value, label }))} />
              <Button variant="secondary" size="m" icon={<Icon name="plus" />} onClick={addRef} disabled={newRef.label.trim() === ''}>В панель</Button>
            </div>
          </Section>

          <Section n="03" title="Локация и погода" note="Погода должна давать физику: мокрый асфальт, отражения, пар, ветер. Свет — событие, а не состояние.">
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

          <Section n="06" title="Сценарий по таймлайну" note="Абзац = отрезок времени. Одно главное действие в абзаце; 4–6 крупных событий на 30 секунд.">
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

            {build.blockers.length > 0 && (
              <div className={styles.blockers}>
                {build.blockers.map((b, i) => (
                  <div key={`${b.code}-${i}`} className={styles.blocker}>
                    <Icon name="alert-circle" size={1.125} />
                    <Text variant="label">{b.messageRu}</Text>
                  </div>
                ))}
              </div>
            )}

            <div className={styles.copyRow}>
              <Button variant="dark" size="m" icon={<Icon name={copied ? 'checkmark' : 'copy'} />} disabled={!canCopy} onClick={() => void copy()}>
                {copied ? 'Скопировано' : 'Копировать для генерации'}
              </Button>
              {!canCopy && (
                <Text variant="caption" tone="secondary">
                  {build.blockers.length > 0 ? 'Сначала сними блокеры сборки.' : errors > 0 ? `Линтер: ${errors} ошибок.` : `Не вычитано реплик: ${unread}.`}
                </Text>
              )}
            </div>
          </Card>

          <Card padding="l" className={styles.previewCard}>
            <Text variant="caption" tone="secondary">Промпт</Text>
            {build.paragraphs.map((paragraph, i) => (
              <div key={i} id={`p-${i}`} className={styles.paragraph}>
                <div className={styles.paragraphHead}>
                  <Text variant="caption" tone="tertiary" mono>{String(i + 1).padStart(2, '0')}</Text>
                  <Text variant="caption" tone="secondary">{BLOCK_RU[paragraph.kind] ?? paragraph.kind}</Text>
                  <Tag tone={paragraph.origin === 'textUnit' ? 'neutral' : 'outline'}>{paragraph.origin === 'verbatim' ? 'дословно из гайда' : paragraph.origin === 'template' ? 'шаблон' : 'твой текст'}</Tag>
                </div>
                <p className={styles.promptText}><Highlighted text={build.resolvedParagraphs[i] ?? ''} /></p>
              </div>
            ))}
          </Card>

          <Card padding="l" className={styles.previewCard}>
            <Text variant="caption" tone="secondary">Линтер · {build.findings.length}</Text>
            {build.findings.length === 0 && <Text variant="label" tone="tertiary">Находок нет.</Text>}
            {build.findings.map((finding, i) => (
              <button key={`${finding.fingerprint}-${i}`} type="button" className={styles.finding} onClick={() => finding.paragraph !== null && document.getElementById(`p-${finding.paragraph}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
                <Tag tone={SEVERITY[finding.severity]?.tone ?? 'neutral'} dot>{SEVERITY[finding.severity]?.label}</Tag>
                <span className={styles.findingBody}>
                  <Text variant="label">{finding.messageRu}</Text>
                  <Text variant="caption" tone="secondary">{finding.fixHintRu}</Text>
                  <Text variant="caption" tone="tertiary" mono>{finding.ruleId}{finding.paragraph !== null ? ` · абзац ${finding.paragraph + 1}` : ''}</Text>
                </span>
              </button>
            ))}
          </Card>
        </aside>
      </div>
    </div>
  );
}
