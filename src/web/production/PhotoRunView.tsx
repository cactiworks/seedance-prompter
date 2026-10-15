import { useState } from 'react';
import { currentArtifact, type ProductionRun } from '../../core/production/model.ts';
import { masterAttempts, masterRejected, photoPrice } from '../../core/production/photos.ts';
import { masterApproved, reviewedPhoto } from '../../core/production/review.ts';
import { boundPrompts } from '../../core/production/appearance.ts';
import { hasStoryEvents, sceneForShot } from '../../core/production/plan.ts';
import { Button, Dialog, Tag, Text } from '../ui/components/index.ts';
import { CharacterField } from './CharacterField.tsx';
import { Preparation } from './Preparation.tsx';
import { useProduction } from './store.ts';
import { PhotoReview, PhotoVerdict } from './PhotoReview.tsx';
import { PhotoStart } from './PhotoStart.tsx';
import { RetouchStart } from './RetouchStart.tsx';
import styles from './Production.module.css';

const STATUS: Record<string, string> = { pending: 'Ожидает', submitting: 'Отправляется', queued: 'В очереди', running: 'Генерируется', downloading: 'Скачивается', saved: 'Сохранено', failed: 'Ошибка', unknown: 'Исход неизвестен', download_failed: 'Не скачано' };
export function ReusePlan({ run }: { run: ProductionRun }) {
  const { photoCommand, busy } = useProduction();
  const [requestId] = useState(() => crypto.randomUUID());
  return <div className={styles.notice}><Text variant="label">Сохранённые сцена и prompts доступны для новой серии. Codex повторно не вызывается; стоимость фото подтвердишь отдельно.</Text><div><Button variant="border" disabled={busy} onClick={() => void photoCommand('fork-photos', { rev: run.rev, requestId })}>Реальные фото по этому плану</Button></div></div>;
}
function progress(run: ProductionRun): number {
  if (!run.planned) return 0;
  if (!masterApproved(run)) return 1;
  if (run.photos?.status === 'complete') return 5;
  if (run.retouch?.status === 'running' || run.retouch?.status === 'stopped') return 4;
  return run.review?.status === 'complete' ? 3 : 2;
}
function nextStep(run: ProductionRun): [string, string] {
  if (run.paused) return ['На паузе', 'Серия сохранена. Уже отправленные фото завершатся; новые ждут продолжения.'];
  if (!run.planned) return [run.preparation?.status === 'running' ? 'Готовим сцену и план' : 'Подготовка остановлена', 'Сценарий сохранён.'];
  if (run.photos?.status === 'complete') return ['Фото готовы к монтажу', 'Скачай принятые кадры ниже.'];
  if (run.retouch?.status === 'running') return ['Исправляем детали', `${run.retouch.items.filter(i => i.status === 'complete').length} из ${run.shots.length} проверено. Лицо, руки, фоновые люди и текст; затем — готовые фото.`];
  if (run.retouch?.status === 'stopped') return ['Есть незавершённые кадры', 'Исходники сохранены. Причина указана на кадре; продолжить проверку можно ниже.'];
  if (run.appearance?.status === 'running' || run.appearance?.status === 'pending') return ['Закрепляем внешность', 'Сравниваем референсы и готовим опорный кадр.'];
  if (run.appearance?.error && run.appearance.status !== 'complete') return ['Не удалось закрепить внешность', 'Продолжи серию, чтобы повторить этот этап. Фото ещё не отправлялись.'];
  const failed = run.photos?.items.find(i => ['failed', 'unknown', 'download_failed'].includes(i.status));
  if (failed) return ['Получение фото остановлено', failed.status === 'unknown' ? 'Ответ от Higgsfield потерян. Сначала проверь историю сервиса: задача могла быть оплачена.' : failed.status === 'download_failed' ? 'Фото создано, но не скачалось. Повтори скачивание без новой генерации.' : 'Сервис не завершил задачу. Причина и доступные действия — ниже.'];
  if (masterRejected(run)) return run.photos?.status === 'running'
    ? ['Подбираем опорный кадр', `Предыдущий не прошёл проверку. Следующая попытка в пределах лимита: ${Math.min(3, masterAttempts(run) + 1)} из 3.`]
    : ['Опорный кадр требует внимания', run.masterReview?.report?.results[0]?.reason ?? 'Кадр не прошёл проверку.'];
  if (['failed', 'interrupted'].includes(run.masterReview?.status ?? '')) return ['Проверка опорного кадра остановлена', 'Фото сохранено. Можно повторить только проверку.'];
  if (run.masterReview?.status === 'running') return ['Проверяем опорный кадр', 'Остальные фотографии начнутся после проверки внешности и сцены.'];
  if (run.photos?.status === 'running') return !masterApproved(run)
    ? ['Создаём опорный кадр', `Попытка ${(run.photos.masterHistory?.length ?? 0) + 1} из ${run.photos.budget?.masterLimit ?? 1}.`]
    : ['Создаём фотографии', `${run.shots.filter(s => s.photoId).length} из ${run.shots.length} готово. Затем — отбор и твоя приёмка.`];
  if (run.review?.status === 'running' || (run.review?.status === 'pending' && run.photos?.status === 'review')) return ['Отбираем фотографии', 'Проверяем узнаваемость, руки и цельность всей серии.'];
  if (run.review?.status === 'complete') return ['Выбери фото для монтажа', 'Выбери подходящие по замыслу. Детали система проверит и исправит после milestone.'];
  if (run.photos?.status === 'review') return ['Отбор требует внимания', 'Фото сохранены. Повтори проверку, чтобы перейти к приёмке.'];
  return [run.photos ? 'Продолжить эту серию' : 'План готов — можно создавать фото', run.photos ? 'Сохранённые этапы повторяться не будут.' : `Кадров: ${run.shots.length} · Soul 2 · 1080p · 9:16`];
}
export function PhotoRunView({ run }: { run: ProductionRun }) {
  const { act, photoCommand, busy, setCharacter, setDraft, newForm } = useProduction();
  const [inspect, setInspect] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const artifact = currentArtifact(run, inspect);
  const master = currentArtifact(run, run.photos?.masterArtifactId ?? null);
  const eligible = run.retouch?.status === 'running' ? [] : run.shots.filter(s => ['photoReview', 'ready'].includes(s.step) && s.photoId && (reviewedPhoto(run, s.photoId) || run.retouch?.items.some(i => i.shotId === s.id)) && !run.retouch?.items.some(i => i.shotId === s.id && i.status === 'complete')).map(s => s.photoId!);
  const recommended = eligible.filter(id => reviewedPhoto(run, id)?.verdict === 'keep');
  const selection = (selected ?? eligible).filter(id => eligible.includes(id));
  const withIssues = selection.filter(id => reviewedPhoto(run, id)?.verdict !== 'keep').length;
  const accepted = run.shots.filter(s => s.acceptedPhotoId).length;
  const step = progress(run);
  const [title, note] = nextStep(run);
  const failures = run.photos?.items.filter(i => ['failed', 'unknown', 'download_failed'].includes(i.status)) ?? [];
  const inspectReview = artifact && (reviewedPhoto(run, artifact.id) ?? run.photos?.masterHistory?.find(h => h.artifactId === artifact.id)?.review.report?.results.find(r => r.artifactId === artifact.id));
  const replan = () => { setDraft({ title: run.title, script: run.script, direction: run.direction, characterId: run.characterId, style: run.style, planningMode: 'codex', mode: 'photos', scenario: 'normal' }); newForm(); };
  return <>
    <header className={styles.header}><div><Text variant="caption" tone="secondary">Серия фотографий{run.character && ` · ${run.character.name}`}</Text><Text as="h1" variant="title-m">{run.title}</Text></div><div className={styles.headerActions}>{run.photos?.status !== 'complete' && <Button variant="border" disabled={busy} onClick={() => void act({ type: run.paused ? 'resume' : 'pause' })}>{run.paused ? 'Снять паузу' : 'Пауза'}</Button>}</div></header>
    <ol className={styles.productionPath} aria-label="Путь серии">{['План', 'Опорный кадр', 'Фотографии', 'Твоя приёмка', 'Правки деталей', 'Готово'].map((label, i) => <li key={label} aria-current={step === i ? 'step' : undefined} data-complete={step > i}><span>{String(i + 1).padStart(2, '0')}</span>{label}</li>)}</ol>
    <section className={`${styles.productionFocus} ${eligible.length ? styles.milestoneFocus : ''}`} aria-label="Следующий шаг">
      <div role="status"><Text as="h2" variant="title-s">{title}</Text><Text variant="label" tone="secondary">{note}</Text></div>
      {!run.planned && <Preparation run={run} />}
      {run.planned && !run.photos && <><Text variant="label">{run.scenePlan?.artDirection?.concept ?? run.scenePlan?.scene.title}</Text><details className={styles.detail}><summary>Персонаж: {run.character?.name ?? 'не выбран'} · изменить</summary><CharacterField compact value={run.characterId ?? null} name={run.character?.name} disabled={busy} onChange={setCharacter} /></details>{!run.character && <Text variant="caption">Soul ID не выбран — фотографии будут без привязки к твоей внешности.</Text>}</>}
      {run.planned && hasStoryEvents(run.scenePlan) && <details className={styles.detail}><summary>События по сценарию · кадров: {run.shots.length} · сцен: {run.scenePlan!.scenes!.length}</summary><div className={styles.shotPlan}>{run.scenePlan!.shots.map(shot => <article className={styles.planShot} key={shot.id}><Text variant="label" medium>{shot.title}</Text><blockquote className={styles.scriptQuote}>{shot.scriptExcerpt}</blockquote><Text variant="label">{shot.action}</Text><Text variant="caption" tone="secondary">{sceneForShot(run.scenePlan!, shot).title} · {shot.framing}</Text></article>)}</div></details>}
      {run.planned && !hasStoryEvents(run.scenePlan) && <><Text variant="caption" tone="secondary">Это прежний план с общей сценой. Для отдельных событий и локаций нужна новая режиссура; сценарий и фото сохранятся.</Text><div><Button variant="border" disabled={busy} onClick={replan}>Новая режиссура по этому сценарию</Button></div></>}
      <PhotoStart run={run} />
      <PhotoReview run={run} scope="master" />
      <PhotoReview run={run} />
      {failures.map(item => <div className={styles.costControls} key={item.tag}>
        <Text variant="caption">{item.key === 'scene' ? 'Опорный кадр' : run.shots.find(s => s.id === item.key)?.title}: {item.error}</Text>
        {item.jobId && (item.status === 'download_failed' || item.errorCode === 'POLL_TIMEOUT') && <div><Button variant="border" disabled={busy} onClick={() => void photoCommand('photos/retry', { jobId: item.jobId })}>Повторить {item.status === 'download_failed' ? 'скачивание' : 'проверку статуса'} · без генерации</Button></div>}
      </div>)}
      {eligible.length > 0 && <div className={styles.gateActions}><Tag tone="warning">Milestone · приёмка фото</Tag><Text variant="caption">Выбрано {selection.length}{withIssues > 0 && ` · с замечаниями: ${withIssues}`}</Text><RetouchStart run={run} ids={selection} onStarted={() => setSelected(null)} /></div>}
      {accepted > 0 && accepted < run.shots.length && <Text variant="caption">Готово {accepted} из {run.shots.length}. Остальные позиции ещё не закрыты.</Text>}
      {accepted > 0 && <a className={styles.download} href={`/api/production/${run.id}/manifest`} download>Скачать список принятых фото · {accepted}</a>}
    </section>
    <section className={styles.productionResults} aria-label="Изображения серии">
      <div className={styles.header}><Text as="h2" variant="title-s">Фотографии <Text as="span" variant="caption" tone="secondary">{run.shots.filter(s => s.photoId).length} / {run.shots.length || '—'}</Text></Text>{eligible.length > 0 && <div className={styles.headerActions}><Button variant="ghost" disabled={busy || run.paused} onClick={() => setSelected(recommended)}>Рекомендованные</Button><Button variant="ghost" disabled={busy || run.paused} onClick={() => setSelected(eligible)}>Выбрать все</Button></div>}</div>
      {master && <div className={styles.masterStrip}><button type="button" className={styles.thumbnail} onClick={() => setInspect(master.id)} aria-label="Открыть опорный кадр"><img src={master.url} alt="Опорный кадр" /></button><div><Text variant="label" medium>Опорный кадр · {masterAttempts(run)} / 3</Text><Text variant="caption" tone="secondary">{masterApproved(run) ? hasStoryEvents(run.scenePlan) ? 'Образ проверен · у кадров своя композиция' : 'Задаёт образ и сцену для серии' : masterRejected(run) ? 'Требует внимания' : 'Проверяется'}</Text><Button variant="ghost" onClick={() => setInspect(master.id)}>Рассмотреть</Button></div></div>}
      {run.shots.some(s => s.photoId) ? <div className={styles.grid}>{run.shots.map(shot => {
        const photo = currentArtifact(run, shot.photoId); if (!photo) return null;
        return <article className={styles.asset} key={photo.id}><button type="button" className={`${styles.thumbnail} ${styles.photoThumbnail}`} onClick={() => setInspect(photo.id)} aria-label={`Открыть ${shot.title}`}><img src={photo.url} alt={shot.title} /></button><div className={styles.assetBody}><div className={styles.assetTitle}><Text variant="label" medium>{shot.title}</Text>{eligible.includes(photo.id) && <input type="checkbox" aria-label={`Принять ${shot.title}`} checked={selection.includes(photo.id)} disabled={busy || run.paused} onChange={() => setSelected(selection.includes(photo.id) ? selection.filter(id => id !== photo.id) : [...selection, photo.id])} />}</div>{run.retouch?.items.find(i => i.shotId === shot.id)?.error && <Text variant="caption">{run.retouch.items.find(i => i.shotId === shot.id)!.error}</Text>}{shot.acceptedPhotoId ? <><Tag tone="success">{run.retouch?.items.some(i => i.shotId === shot.id && i.status === 'complete') ? 'Детали проверены' : 'Принято ранее'}</Tag><a className={styles.download} href={photo.url} download>Скачать фото</a></> : <PhotoVerdict compact result={reviewedPhoto(run, photo.id)} />}</div></article>;
      })}</div> : <div className={styles.resultEmpty}><Text variant="label" tone="secondary">Здесь появятся кадры серии после проверки опорного изображения.</Text></div>}
    </section>
    <details className={styles.productionDetails}><summary>Детали производства</summary><div className={styles.detailsBody}>
      <details className={styles.detail}><summary>Сценарий, сцена и план кадров</summary><pre>{run.script}</pre><pre>{run.direction}</pre><Preparation run={run} /></details>
      <details className={styles.detail}><summary>Внешность и prompts</summary>{run.appearance?.error && <Text>{run.appearance.error}</Text>}{run.appearance?.output && <><Text>{run.appearance.output.profile.summaryRu}</Text><pre>{JSON.stringify(run.appearance.output.profile, null, 2)}</pre></>}<pre>{boundPrompts(run)?.masterPrompt}</pre>{boundPrompts(run)?.shots.map(shot => <pre key={shot.shotId}>{shot.shotId}: {shot.imagePrompt}</pre>)}</details>
      <details className={styles.detail}><summary>Задачи и проверки</summary>{run.photos?.items.map(item => <div className={styles.photoJob} key={item.tag}><div><Text variant="label">{item.key === 'scene' ? 'Опорный кадр' : run.shots.find(s => s.id === item.key)?.title}</Text><Text variant="caption">{item.taskId} {item.error}</Text></div><Tag>{STATUS[item.status]}</Tag></div>)}{[run.appearance, run.masterReview, run.review].filter(Boolean).map((state, i) => <pre key={i}>{JSON.stringify(state, null, 2)}</pre>)}</details>
      {!!run.photos?.masterHistory?.length && <details className={styles.detail}><summary>Предыдущие опорные кадры · {run.photos.masterHistory.length}</summary><div className={styles.grid}>{run.photos.masterHistory.map((history, i) => { const old = currentArtifact(run, history.artifactId); return old && <article key={old.id} className={styles.asset}><button className={styles.thumbnail} onClick={() => setInspect(old.id)} aria-label={`Открыть попытку ${i + 1}`}><img src={old.url} alt={`Опорный кадр, попытка ${i + 1}`} /></button><div className={styles.assetBody}><Text variant="caption">{history.review.report?.results[0]?.reason}</Text></div></article>; })}</div></details>}
      {run.retouch && <details className={styles.detail}><summary>Автоправки · версии и проверки</summary><pre>{JSON.stringify(run.retouch, null, 2)}</pre></details>}
      <details className={styles.detail}><summary>История · {run.events.length}</summary><ol className={styles.events}>{run.events.map((event, i) => <li key={i}><time>{new Date(event.at).toLocaleTimeString('ru-RU')}</time>{event.message}</li>)}</ol></details>
      <Button variant="border" disabled={busy} onClick={replan}>Изменить замысел — открыть заполненный brief</Button><Text variant="caption" tone="secondary">Новая версия плана создаётся отдельно. Текущая серия и фото сохраняются.</Text>
      {failures.some(i => i.status === 'failed' || i.status === 'unknown') && <ReusePlan run={run} />}
    </div></details>
    <Dialog open={!!artifact} onOpenChange={open => { if (!open) setInspect(null); }} size="l" title={artifact?.shotId === 'scene' ? 'Опорный кадр' : run.shots.find(s => s.id === artifact?.shotId)?.title ?? 'Фотография'} description="Фото и результат проверки">
      {artifact && <div className={styles.inspect}><img className={styles.preview} src={artifact.url} alt={artifact.shotId === 'scene' ? 'Опорный кадр' : 'Фотография серии'} /><div className={styles.inspectData}><PhotoVerdict result={inspectReview || undefined} /><a className={styles.download} href={artifact.url} download>Скачать эту версию</a>{artifact.sourceId && currentArtifact(run, artifact.sourceId) && <Button variant="border" onClick={() => setInspect(artifact.sourceId)}>Посмотреть до правки</Button>}<details className={styles.detail}><summary>Prompt и данные задачи</summary><Text variant="caption">{artifact.model} · {artifact.taskId} · оценка {photoPrice(artifact.cost)}</Text><Text variant="caption">{artifact.qcNote}</Text><pre>{artifact.prompt}</pre></details></div></div>}
    </Dialog>
  </>;
}
