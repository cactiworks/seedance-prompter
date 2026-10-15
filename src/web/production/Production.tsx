import { useEffect, useState, type ReactNode } from 'react';
import { currentArtifact, isAutomatic, runLabel, stageProgress, STAGES, type Artifact, type ProductionRun, type ProductionShot, type StageId } from '../../core/production/model.ts';
import { Button, Dialog, Icon, Tag, Text, TextField } from '../ui/components/index.ts';
import { useProduction } from './store.ts';
import styles from './Production.module.css';
import { Preparation } from './Preparation.tsx';
import { PhotoRunView, ReusePlan } from './PhotoRunView.tsx';
import { CharacterField } from './CharacterField.tsx';

function eventLabel(message: string): string {
  return message.replace(/\b(?:photos|photoQc|photoReview|videos|videoQc|videoReview|upscale|finalQc|ready)\b/g,
    (id) => STAGES.find(([stage]) => stage === id)?.[1] ?? id);
}

export function ProductionList() {
  const { runs, activeId, busy, newForm, select } = useProduction();
  return <>
    <Button variant="border" icon={<Icon name="plus" size={1} />} onClick={newForm} disabled={busy}>Новая серия</Button>
    <Text variant="caption" tone="tertiary" className={styles.sideTitle}>Производство</Text>
    <nav className={styles.runList} aria-label="Серии производства">
      {runs.map((run) => <button type="button" key={run.id} className={styles.runItem} aria-current={run.id === activeId ? 'page' : undefined} onClick={() => select(run.id)} disabled={busy}>
        <span>{run.title}</span><small>{runLabel(run)}</small>
      </button>)}
      {!runs.length && <Text variant="caption" tone="secondary">Здесь сохраняются серии и их этапы.</Text>}
    </nav>
  </>;
}
function NewRun() {
  const { draft: input, setDraft: setInput, create, busy } = useProduction();
  return <div className={styles.start} data-guide="production-start">
    <Tag tone="outline">Production</Tag>
    <Text as="h1" variant="title-l">От сценария к подборке кадров</Text>
    <Text tone="secondary">Задай направление. Codex подготовит единую сцену, план кадров и prompts. После подготовки подтверди стоимость фото — серия создастся в Higgsfield, пройдёт отбор критиком Codex и придёт на приёмку. Видео и upscale пока отключены.</Text>
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void create(input); }}>
      <TextField label="Название серии" value={input.title} maxLength={100} required onChange={(e) => setInput({ ...input, title: e.target.value })} />
      <TextField multiline label="Сценарий" rows={4} value={input.script} maxLength={12000} required onChange={(e) => setInput({ ...input, script: e.target.value })} />
      <TextField multiline label="Визуальный вектор" rows={3} value={input.direction} maxLength={3000} required onChange={(e) => setInput({ ...input, direction: e.target.value })} />
      <CharacterField value={input.characterId ?? null} disabled={busy} onChange={(characterId) => setInput({ ...input, characterId })} />
      <fieldset className={styles.choices}><legend>Как снято</legend>{([['phone', 'Phone / UGC'], ['cinema', 'Cinematic']] as const).map(([style, label]) => <label key={style}><input type="radio" name="production-style" checked={input.style === style} onChange={() => setInput({ ...input, style })} />{label}</label>)}</fieldset>
      <fieldset className={styles.choices}><legend>Подготовка серии</legend>{([['codex', 'Codex → реальные фото'], ['mock', 'Демо без генераций']] as const).map(([planningMode, label]) => <label key={planningMode}><input type="radio" name="production-planning" checked={input.planningMode === planningMode} onChange={() => setInput({ ...input, planningMode, mode: planningMode === 'codex' ? 'photos' : 'mock' })} />{label}</label>)}</fieldset>
      {input.planningMode !== 'codex' && <label className={styles.check}><input type="checkbox" checked={input.scenario === 'repair'} onChange={(e) => setInput({ ...input, scenario: e.target.checked ? 'repair' : 'normal' })} />Показать локальную правку одного кадра</label>}
      <div className={styles.notice}><Text variant="label" medium>{input.planningMode === 'codex' ? 'Codex расходует квоту ChatGPT · фото запускаются отдельно' : 'Демонстрация процесса · без вызовов моделей'}</Text><Text variant="caption" tone="secondary">{input.planningMode === 'codex' ? 'По кнопке отправятся только сценарий, вектор и выбранная манера съёмки. Два вызова Codex, до четырёх при исправлении ответов. Агент выберет 1–8 кадров. Затем появятся стоимость и отдельная кнопка запуска фото. Выбранный Soul ID используется только при генерации в Higgsfield.' : 'Тексты сохранятся без анализа. Сцена, три кадра и prompts фиксированы; внешние сервисы не вызываются.'}</Text></div>
      <Button type="submit" variant="primary" size="m" loading={busy} disabled={!input.title.trim() || !input.script.trim() || !input.direction.trim()}>{input.planningMode === 'codex' ? 'Подготовить с Codex' : 'Запустить mock-серию'}</Button>
    </form>
  </div>;
}
function Stage({ run, id, index, title, subtitle, children }: { run: ProductionRun; id: StageId; index: number; title: string; subtitle: string; children: ReactNode }) {
  const { act, busy } = useProduction();
  const progress = stageProgress(run, id);
  const active = progress.active > 0;
  const showByDefault = active || (id === 'ready' && progress.done > 0);
  const [manualExpanded, setExpanded] = useState<boolean | null>(null);
  const [revealed, setRevealed] = useState(showByDefault);
  useEffect(() => { if (showByDefault) setRevealed(true); }, [showByDefault]);
  const expanded = manualExpanded ?? revealed;
  const completed = progress.total > 0 && progress.done === progress.total;
  const gate = id === 'photoReview' || id === 'videoReview';
  const label = completed ? 'Завершено' : progress.errors ? 'Сбой' : active ? run.paused ? 'На паузе' : gate ? 'Твоё решение' : 'В работе' : progress.done ? 'Частично готово' : 'Ожидает';
  return <section id={`production-${id}`} className={`${styles.stage} ${active ? styles.stageActive : ''} ${gate ? styles.milestone : ''}`} data-stage={id}>
    <button type="button" className={styles.stageHead} aria-expanded={expanded} aria-controls={`stage-body-${id}`} onClick={() => setExpanded(!expanded)}>
      <span className={styles.stepNumber}>{completed ? <Icon name="checkmark" size={1} /> : String(index + 1).padStart(2, '0')}</span>
      <span className={styles.stageName}><Text as="span" variant="title-s" medium>{title}</Text><Text as="span" variant="caption" tone="secondary">{subtitle}</Text></span>
      <span className={styles.stageMeta}><Tag tone={progress.errors ? 'danger' : completed ? 'success' : active ? gate ? 'warning' : 'accent' : 'neutral'}>{label}</Tag><span className={styles.count}>{progress.done} / {progress.total || '—'}</span></span>
      <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={1} />
    </button>
    {expanded && <div id={`stage-body-${id}`} className={styles.stageBody}>
      {run.shots.filter((s) => s.step === id && s.error).map((shot) => <div key={shot.id} className={styles.error} role="alert"><div><Text variant="label" medium>{shot.title} · сбой</Text><Text variant="caption">{shot.error}</Text></div><Button variant="border" disabled={busy || run.paused} onClick={() => void act({ type: 'retry', shotId: shot.id })}>Повторить mock-этап</Button></div>)}
      {children}</div>}
  </section>;
}
function AssetCard({ run, shot, artifact, check, checked, onCheck, onInspect, onEdit, final = false }: { run: ProductionRun; shot: ProductionShot; artifact: Artifact; check?: boolean; checked?: boolean; onCheck?: () => void; onInspect: (a: Artifact) => void; onEdit: (s: ProductionShot) => void; final?: boolean }) {
  const { busy } = useProduction();
  const eligible = artifact.qc === 'pass' && !run.paused && !busy;
  return <article className={styles.asset} data-artifact={artifact.id}>
    <button type="button" className={styles.thumbnail} onClick={() => onInspect(artifact)} aria-label={`Открыть ${shot.title}, ${artifact.kind === 'photo' ? 'фото' : 'видео'}, версия ${artifact.version}`}>
      <img src={artifact.poster} alt={`${shot.title} — демонстрационный макет, версия ${artifact.version}`} />
      <span className={styles.assetType}>{artifact.kind === 'photo' ? 'Фото' : '▶ 00:04'} · v{artifact.version}</span>
    </button>
    <div className={styles.assetBody}>
      <div className={styles.assetTitle}><Text variant="label" medium>{shot.title}</Text>{check && <input type="checkbox" aria-label={`Выбрать ${shot.title}`} disabled={!eligible} checked={checked ?? false} onChange={onCheck} />}</div>
      <Text variant="caption" tone="secondary">{shot.framing} · {run.style === 'phone' ? 'Phone / UGC' : 'Cinematic'}</Text>
      <Tag tone={artifact.qc === 'repair' ? 'warning' : artifact.qc === 'pass' ? 'success' : 'neutral'}>{artifact.qc === 'repair' ? 'Нужна правка' : artifact.qc === 'pass' ? 'Mock QC пройден' : 'Проверяется'}</Tag>
      {artifact.qc === 'repair' && <Text variant="caption" tone="secondary">{artifact.qcNote}</Text>}
      <div className={styles.assetActions}><Button variant="ghost" size="xs" onClick={() => onInspect(artifact)}>Открыть детали</Button>{artifact.kind === 'photo' && artifact.id === shot.photoId && !['photos', 'photoQc'].includes(shot.step) && <Button variant="border" size="xs" disabled={busy || run.paused} onClick={() => onEdit(shot)}>Правка фото</Button>}{final && <a href={artifact.url} download={`${shot.id}-mock.${artifact.kind === 'photo' ? 'png' : 'mp4'}`}>Скачать</a>}</div>
    </div>
  </article>;
}
function Gate({ run, kind, onInspect, onEdit }: { run: ProductionRun; kind: 'photo' | 'video'; onInspect: (a: Artifact) => void; onEdit: (s: ProductionShot) => void }) {
  const { act, busy } = useProduction();
  const [selected, setSelected] = useState<string[]>([]);
  const shots = run.shots.filter((s) => s.step === (kind === 'photo' ? 'photoReview' : 'videoReview'));
  const eligible = shots.map((s) => currentArtifact(run, kind === 'photo' ? s.photoId : s.videoId)).filter((a): a is Artifact => a?.qc === 'pass').map((a) => a.id);
  const selection = selected.filter((id) => eligible.includes(id));
  return <>
    <Text variant="label" tone="secondary">{kind === 'photo' ? 'Проверь лицо, сцену и детали. Прими выбранные версии: только они пойдут в видео. Остальные можно исправить отдельно.' : 'Посмотри клипы целиком. Только выбранные версии перейдут к Topaz. В mock-режиме списаний и реального upscale нет.'}</Text>
    {shots.length ? <div className={styles.grid}>{shots.map((shot) => {
      const artifact = currentArtifact(run, kind === 'photo' ? shot.photoId : shot.videoId)!;
      return <AssetCard key={artifact.id} run={run} shot={shot} artifact={artifact} check checked={selection.includes(artifact.id)} onCheck={() => setSelected(selection.includes(artifact.id) ? selection.filter((id) => id !== artifact.id) : [...selection, artifact.id])} onInspect={onInspect} onEdit={onEdit} />;
    })}</div> : <Text variant="label" tone="tertiary">{run.approvals.some((a) => a.kind === kind) ? 'Принятые ветви уже на следующих этапах. Подтверждения сохранены для конкретных версий.' : 'Здесь появятся результаты после проверки.'}</Text>}
    {shots.length > 0 && <div className={styles.gateActions}><Button variant="ghost" disabled={!eligible.length || run.paused || busy} onClick={() => setSelected(eligible)}>Выбрать доступные</Button><span className={styles.spacer} /><Text variant="caption" tone="secondary">{selection.length} выбрано · 0 кредитов</Text><Button variant="primary" disabled={!selection.length || run.paused || busy} onClick={() => void act({ type: kind === 'photo' ? 'approvePhotos' : 'approveVideos', ids: selection }).then((ok) => { if (ok) setSelected([]); })}>{kind === 'photo' ? 'Принять фото' : 'Принять и продолжить до Topaz'}</Button></div>}
  </>;
}
function RunView({ run }: { run: ProductionRun }) {
  const { act, busy, setCharacter } = useProduction();
  const [inspect, setInspect] = useState<Artifact | null>(null);
  useEffect(() => { setInspect((previous) => previous ? currentArtifact(run, previous.id) ?? previous : null); }, [run]);
  const [editing, setEditing] = useState<{ shotId: string; sourceId: string } | null>(null);
  const [note, setNote] = useState('Убрать лишнюю деталь у блокнота. Сохранить комнату, свет и композицию.');
  const onEdit = (shot: ProductionShot): void => { if (shot.photoId) setEditing({ shotId: shot.id, sourceId: shot.photoId }); };
  const ready = run.shots.filter((s) => s.step === 'ready').length;
  const total = run.shots.length || run.scenePlan?.shots.length || (run.planningMode === 'codex' ? 0 : 3);
  const allReady = run.planned && ready === total;
  const activity = run.shots.find((s) => isAutomatic(s.step) && s.error === null);
  function gallery(kind: Artifact['kind'], final = false) {
    const pairs = run.shots.flatMap((shot) => {
      const artifact = currentArtifact(run, kind === 'photo' ? final ? shot.acceptedPhotoId : shot.photoId : kind === 'video' ? shot.videoId : shot.step === 'ready' ? shot.finalId : null);
      return artifact ? [{ shot, artifact }] : [];
    });
    return pairs.length ? <div className={styles.grid}>{pairs.map(({ shot, artifact }) => <AssetCard key={artifact.id} run={run} shot={shot} artifact={artifact} onInspect={setInspect} onEdit={onEdit} final={final} />)}</div> : <Text variant="label" tone="tertiary">Результаты появятся после предыдущего этапа.</Text>;
  }
  function body(id: StageId): ReactNode {
    if (id === 'plan') return <>
      {run.preparation ? <Preparation run={run} /> : <>
      <div className={styles.scene}><div><Text variant="caption" tone="tertiary">Паспорт сцены · demo v1</Text><Text variant="title-s">Одна комната. Одно утро.</Text><Text variant="label" tone="secondary">Окно слева, стол, блокнот и кружка. Мягкий пасмурный свет; один условный персонаж в тёмной одежде. Эти признаки общие для всех кадров.</Text></div><dl><dt>Манера</dt><dd>{run.style === 'phone' ? 'Phone / UGC' : 'Cinematic'}</dd><dt>План</dt><dd>Средний → крупный → деталь</dd><dt>Ограничения</dt><dd>Без мата, убийств и шок-контента</dd></dl></div>
      <Text variant="caption" tone="secondary">Паспорт и кадры — фиксированный mock. Твой сценарий и вектор сохранены ниже; для автоматической режиссуры создай новую серию с Codex.</Text></>}
      <details className={styles.detail}><summary>Сценарий и визуальный вектор</summary><pre>{run.script}</pre><pre>{run.direction}</pre></details>
    </>;
    if (id === 'photoReview' || id === 'videoReview') return <Gate run={run} kind={id === 'photoReview' ? 'photo' : 'video'} onInspect={setInspect} onEdit={onEdit} />;
    if (id === 'photos' || id === 'videos') return <><Text variant="label" tone="secondary">{id === 'photos' ? 'Создаются локальные демонстрационные варианты. Для правки сохраняется отдельная версия и её исходник.' : 'Видео создаются только от принятых фотографий. Превью — настоящий локальный MP4, 4 секунды, 480p.'}</Text>{gallery(id === 'photos' ? 'photo' : 'video')}</>;
    if (id === 'photoQc' || id === 'videoQc' || id === 'finalQc') return <div className={styles.qcList}>{run.shots.map((shot) => {
      const artifact = currentArtifact(run, id === 'photoQc' ? shot.photoId : id === 'videoQc' ? shot.videoId : shot.finalId);
      return <div key={shot.id} className={styles.qcRow}><Text variant="label" medium>{shot.title}</Text><Text variant="caption" tone="secondary">{artifact?.qcNote || 'Ожидает результата для проверки.'}</Text>{artifact && <Button variant="ghost" size="xs" onClick={() => setInspect(artifact)}>Результат</Button>}</div>;
    })}</div>;
    if (id === 'upscale') return <><Text variant="label" tone="secondary">Этап повторяет будущую передачу принятых клипов в Topaz. Сейчас используется тот же mock-файл 480p: реального улучшения разрешения нет.</Text>{gallery('final')}</>;
    return <><div className={styles.gateActions}><Text variant="label" tone="secondary">{ready} из {total || '—'} клипов готовы. Принятые фотографии доступны отдельно. Каждый файл помечен как demo.</Text><a className={styles.download} href={`/api/production/${run.id}/manifest`} download>Скачать список файлов</a></div>{gallery('photo', true)}{gallery('final', true)}</>;
  }
  return <>
    <header className={styles.header}><div><div className={styles.eyebrow}><Tag tone="outline">{run.planningMode === 'codex' ? 'Codex + mock-медиа' : 'Mock · 0 кредитов'}</Tag><Text as="span" variant="caption" tone="secondary">Серия · {total ? `${total} кадров` : 'планируется'}</Text></div><Text as="h1" variant="title-m">{run.title}</Text></div><div className={styles.headerActions}><Tag tone={allReady ? 'success' : 'neutral'} dot>{runLabel(run)}</Tag>{!allReady && <Button variant="border" disabled={busy} onClick={() => void act({ type: run.paused ? 'resume' : 'pause' })}>{run.paused ? 'Продолжить' : 'Пауза'}</Button>}</div></header>
    <div className={styles.mockNote}>{run.planningMode === 'codex' ? 'Сцена, shot plan и prompts — Codex. Картинки и клипы — условные локальные макеты, они не изображают этот план. Медиа, проверки качества и upscale остаются mock, без вызовов генерации KIE и Higgsfield.' : 'Локальная демонстрация процесса. Кадры условные, проверки смоделированы. Генерация и LLM не вызываются. Soul ID управляется отдельно.'}</div>
    {run.planned && run.promptPlan && <ReusePlan run={run} />}
    <CharacterField value={run.characterId ?? null} name={run.character?.name} disabled={busy} onChange={setCharacter} />
    <nav className={styles.overview} aria-label="Этапы серии">{[['photoReview', '01', 'Принятие фото'], ['videoReview', '02', 'До Topaz'], ['ready', '03', 'Выдача']] .map(([id, n, label]) => <button type="button" key={id} onClick={() => { const target = document.getElementById(`production-${id}`); const button = target?.querySelector('button'); if (button?.getAttribute('aria-expanded') === 'false') button.click(); target?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}><span>{n}</span><Text as="span" variant="label">{label}</Text><Text as="span" variant="caption" tone="tertiary">{stageProgress(run, id as StageId).done} / {total || '—'}</Text></button>)}</nav>
    {run.paused && <div className={styles.notice} role="status">Серия на паузе. Состояние сохранено; продолжение вернётся к текущим этапам.</div>}
    <div className={styles.timeline}>{STAGES.map(([id, title, subtitle], index) => <Stage key={id} run={run} id={id} index={index} title={title} subtitle={id === 'plan' ? run.planningMode === 'codex' ? 'Режиссёр → агент prompts · Codex' : 'Фиксированная сцена · mock' : subtitle}>{body(id)}</Stage>)}</div>
    <details className={styles.detail}><summary>История версий и действий · {run.events.length}</summary><div className={styles.history}>{run.artifacts.map((a) => <button type="button" key={a.id} onClick={() => setInspect(a)}><span>{a.id}</span><small>{a.sourceId ? `из ${a.sourceId}` : 'исходный вариант'}</small></button>)}</div><ol className={styles.events}>{run.events.map((event, index) => <li key={index}><time>{new Date(event.at).toLocaleTimeString('ru-RU')}</time>{eventLabel(event.message)}</li>)}</ol></details>
    <details className={styles.detail}><summary>Проверить поведение при сбое</summary><Text variant="label" tone="secondary">На активном mock-этапе можно показать ошибку, затем повторить только его. Другие кадры продолжат работу.</Text><Button variant="border" disabled={!activity || busy || run.paused} onClick={() => { if (activity) void act({ type: 'simulateFailure', shotId: activity.id }); }}>Смоделировать сбой этапа</Button></details>
    <Dialog open={inspect !== null} onOpenChange={(open) => { if (!open) setInspect(null); }} title={inspect ? `${run.shots.find((s) => s.id === inspect.shotId)?.title ?? 'Результат'} · v${inspect.version}` : 'Результат'} description="Mock-артефакт. Здесь виден результат, его исходник и данные этапа." size="l">
      {inspect && <div className={styles.inspect}>{inspect.kind === 'photo' ? <img className={styles.preview} src={inspect.url} alt="Демонстрационный кадр" /> : <video className={styles.preview} src={inspect.url} poster={inspect.poster} controls playsInline preload="metadata" />}
        <div className={styles.inspectData}><Tag tone="outline">{inspect.model} · имитация</Tag><Text variant="label">{inspect.qcNote || 'Ожидает проверки'}</Text><dl><dt>Версия</dt><dd>{inspect.id}</dd><dt>Исходник</dt><dd>{inspect.sourceId ?? 'Первый вариант'}</dd><dt>Задача</dt><dd>{inspect.taskId}</dd><dt>Стоимость</dt><dd>0 кредитов</dd><dt>Формат</dt><dd>{inspect.kind === 'photo' ? 'PNG · 480 × 854' : 'MP4 · 480 × 854 · 4 секунды'}</dd></dl>{inspect.note && <Text variant="label">Правка: {inspect.note}</Text>}<Text variant="caption" tone="tertiary">{run.promptPlan && inspect.kind !== 'final' ? 'Prompt подготовлен Codex · медиа не генерировалось' : 'Демонстрационный prompt · не отправлялся'}</Text><pre>{inspect.prompt}</pre></div>
      </div>}
    </Dialog>
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }} title="Правка фотографии" description="Создастся новая версия от выбранного исходника. Прежний кадр сохранится; видео этой ветви потребуется принять заново." footer={<Button variant="primary" disabled={busy || !note.trim()} onClick={() => { if (editing) void act({ type: 'edit', ...editing, note }).then((ok) => { if (ok) setEditing(null); }); }}>Создать mock-правку</Button>}>
      {editing && <div className={styles.editForm}><Text variant="caption" tone="secondary">Исходник: {editing.sourceId} · Seedream 5 Pro / KIE · имитация</Text><TextField multiline label="Что изменить" rows={4} value={note} maxLength={1500} onChange={(e) => setNote(e.target.value)} /><Text variant="caption" tone="secondary">В этом каркасе показываем подготовленный вариант: меняется деталь у блокнота. Произвольные правки и кисть подключим вместе с реальным editing.</Text></div>}
    </Dialog>
  </>;
}
export function Production() {
  const { load, refresh, initialized, run, error, connectionError, warnings } = useProduction();
  useEffect(() => { void load(); const timer = setInterval(() => void refresh(), 800); const summaries = setInterval(() => void load(), 5000); return () => { clearInterval(timer); clearInterval(summaries); }; }, [load, refresh]);
  return <main className={styles.page} data-production="true"><div className={styles.inner}>
    {error && <div className={`${styles.error} ${styles.globalError}`} role="alert">{error}<Button variant="border" onClick={() => void load()}>Обновить</Button></div>}
    {connectionError && <Text tone="accent">{connectionError}</Text>}
    {warnings.map((warning) => <Text key={warning} tone="accent">{warning}</Text>)}
    {!initialized ? <Text tone="secondary">Открываю производство…</Text> : run ? run.mode === 'photos' ? <PhotoRunView key={run.id} run={run} /> : <RunView key={run.id} run={run} /> : <NewRun />}
  </div></main>;
}
