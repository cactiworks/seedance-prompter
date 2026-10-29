import { ui } from '../language.ts';
import { useCanvas } from '../canvas/canvasStore.ts';
import { seriesApi } from '../series/api.ts';
import { useState } from 'react';
import { currentArtifact, type ProductionRun } from '../../core/production/model.ts';
import { photoOutput } from '../../core/production/output.ts';
import { canRegenerateMaster, masterAttempts, masterRejected, photoPrice } from '../../core/production/photos.ts';
import { LOGIC_CRITERIA, masterApproved, reviewedPhoto } from '../../core/production/review.ts';
import { boundPrompts } from '../../core/production/appearance.ts';
import { hasStoryEvents, sceneForShot } from '../../core/production/plan.ts';
import { Button, Dialog, Tag, Text } from '../ui/components/index.ts';
import { CharacterField } from './CharacterField.tsx';
import { Preparation } from './Preparation.tsx';
import { useProduction } from './store.ts';
import { PhotoReview, PhotoVerdict } from './PhotoReview.tsx';
import { PhotoStart } from './PhotoStart.tsx';
import { PhotoSelection } from './PhotoSelection.tsx';
import { photoSelectionProblem } from '../../core/production/selection.ts';
import { useGen } from '../gen/genStore.ts';
import styles from './Production.module.css';

const STATUS: Record<string, string> = { pending: 'Ожидает', submitting: 'Отправляется', queued: 'В очереди', running: 'Генерируется', downloading: 'Скачивается', saved: 'Сохранено', failed: 'Ошибка', unknown: 'Исход неизвестен', download_failed: 'Не скачано' };
export function ReusePlan({ run }: { run: ProductionRun }) {
  const { photoCommand, busy } = useProduction();
  const [requestId] = useState(() => crypto.randomUUID());
  return <div className={styles.notice}><Text variant="label">{ui("Создай новую серию по сохранённому плану и prompts. Codex повторно не вызывается и ничего не генерируется автоматически; стоимость фото подтвердишь отдельно.")}</Text><div><Button variant="primary" disabled={busy} onClick={() => void photoCommand('fork-photos', { rev: run.rev, requestId })}>{ui("Новая серия по этому плану")}</Button></div></div>;
}
function progress(run: ProductionRun): number {
  if (!run.planned) return 0;
  if (!masterApproved(run)) return 1;
  if (run.photos?.status === 'complete') return 4;
  return !photoSelectionProblem(run) ? 3 : 2;
}
function nextStep(run: ProductionRun): [string, string] {
  if (run.paused) return [ui("На паузе"), ui("Серия сохранена. Уже отправленные фото завершатся; новые ждут продолжения.")];
  if (!run.planned) return [run.preparation?.status === 'running' ? run.contentMode === 'broll' ? ui("Придумываем B-roll") : ui("Готовим сцену и план") : ui("Подготовка остановлена"), ui("Твой brief сохранён.")];
  if (run.photos?.status === 'complete') return [ui("Фотографии приняты"), ui("Продолжи в Canvas: подготовь Prompter по серии и запускай видео по одному.")];
  if (run.retouch?.status === 'running') return [ui("Исправляем детали"), ui("{0} из {1} проверено. Внешность, одежда, логика сцены и детали; затем — готовые фото.", run.retouch.items.filter(i => i.status === 'complete').length, run.shots.length)];
  if (run.appearance?.status === 'running' || run.appearance?.status === 'pending') return [ui("Закрепляем внешность"), ui("Сравниваем референсы и готовим опорный кадр.")];
  if (run.appearance?.error && run.appearance.status !== 'complete') return [ui("Не удалось закрепить внешность"), ui("Продолжи серию, чтобы повторить этот этап. Фото ещё не отправлялись.")];
  const failed = run.photos?.items.find(i => ['failed', 'unknown', 'download_failed'].includes(i.status));
  if (failed) return [ui("Получение фото остановлено"), failed.status === 'unknown' ? ui("Ответ от Higgsfield потерян. Сначала проверь историю сервиса: задача могла быть оплачена.") : failed.status === 'download_failed' ? ui("Фото создано, но не скачалось. Повтори скачивание без новой генерации.") : ui("Сервис не завершил задачу. Причина и доступные действия — ниже.")];
  if (masterRejected(run)) return run.photos?.status === 'running'
    ? [ui("Подбираем опорный кадр"), ui("Предыдущий не прошёл проверку. Следующая попытка в пределах лимита: {0} из 3.", Math.min(3, masterAttempts(run) + 1))]
    : [ui("Опорный кадр требует внимания"), run.masterReview?.report?.results[0]?.reason ?? ui("Кадр не прошёл проверку.")];
  if (['failed', 'interrupted'].includes(run.masterReview?.status ?? '')) return [ui("Проверка опорного кадра остановлена"), ui("Фото сохранено. Можно повторить только проверку.")];
  if (run.masterReview?.status === 'running') return [ui("Проверяем опорный кадр"), ui("Остальные фотографии начнутся после проверки внешности и сцены.")];
  if (run.photos?.status === 'running') return !masterApproved(run)
    ? [ui("Создаём опорный кадр"), ui("Попытка {0} из {1}.", (run.photos.masterHistory?.length ?? 0) + 1, run.photos.budget?.masterLimit ?? 1)]
    : [ui("Создаём фотографии"), ui("{0} из {1} готово. Затем — отбор и твоя приёмка.", run.shots.filter(s => s.photoId).length, run.shots.length)];
  if (run.review?.status === 'running' || (run.review?.status === 'pending' && run.photos?.status === 'review')) return [ui("Отбираем фотографии"), ui("Проверяем внешность, одежду, логику сцены и цельность серии.")];
  if (!photoSelectionProblem(run)) return [ui("Выбери подходящие фотографии"), ui("Отметь галочкой то, что подходит, и нажми «Продолжить». Пересоздадим только неотмеченные позиции. Правки в Canvas — по желанию.")];
  if (run.photos?.status === 'review') return [ui("Отбор требует внимания"), ui("Фото сохранены. Повтори проверку, чтобы перейти к приёмке.")];
  return [run.photos ? ui("Продолжить эту серию") : ui("План готов — можно создавать фото"), run.photos ? ui("Сохранённые этапы повторяться не будут.") : ui("Кадров: {0} · Soul 2 · {1} · {2}", run.shots.length, photoOutput(run).resolution, photoOutput(run).aspectRatio)];
}
export function PhotoRunView({ run }: { run: ProductionRun }) {
  const { act, photoCommand, busy, setCharacter, setDraft, newForm } = useProduction();
  const [inspect, setInspect] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const artifact = currentArtifact(run, inspect);
  const master = currentArtifact(run, run.photos?.masterArtifactId ?? null);
  const eligible = photoSelectionProblem(run) ? [] : run.shots.filter(s => !s.acceptedPhotoId && s.photoId).map(s => s.photoId!);
  const selection = selected.filter(id => eligible.includes(id));
  const accepted = run.shots.filter(s => s.acceptedPhotoId).length;
  const step = progress(run);
  const [title, note] = nextStep(run);
  const failures = run.photos?.items.filter(i => ['failed', 'unknown', 'download_failed'].includes(i.status)) ?? [];
  const inspectReview = artifact && (reviewedPhoto(run, artifact.id) ?? run.photos?.masterHistory?.find(h => h.artifactId === artifact.id)?.review.report?.results.find(r => r.artifactId === artifact.id));
  const replan = () => { setDraft({ contentMode: run.contentMode, brollCount: run.brollCount, title: run.title, script: run.script, direction: run.direction, characterId: run.characterId, style: run.style, ...photoOutput(run), planningMode: 'codex', mode: 'photos', scenario: 'normal' }); newForm(); };
  return <>
    <header className={styles.header}><div><Text variant="caption" tone="secondary">{run.contentMode === 'broll' ? ui("Креативные B-roll · фото") : ui("Серия фотографий")} · {run.style === 'cinema' ? 'Cinematic' : 'Phone / UGC'} · {photoOutput(run).resolution} · {photoOutput(run).aspectRatio}{run.character && ` · ${run.character.name}`}</Text><Text as="h1" variant="title-m">{run.title}</Text></div><div className={styles.headerActions}>{run.photos?.status !== 'complete' && <Button variant="border" disabled={busy} onClick={() => void act({ type: run.paused ? 'resume' : 'pause' })}>{run.paused ? ui("Снять паузу") : ui("Пауза")}</Button>}</div></header>
    <ol className={styles.productionPath} aria-label={ui("Путь серии")}>{[ui("План"), ui("Опорный кадр"), ui("Фотографии"), ui("Твой выбор"), ui("Готово")].map((label, i) => <li key={label} aria-current={step === i ? 'step' : undefined} data-complete={step > i}><span>{String(i + 1).padStart(2, '0')}</span>{label}</li>)}</ol>
    <section className={`${styles.productionFocus} ${eligible.length ? styles.milestoneFocus : ''}`} aria-label={ui("Следующий шаг")}>
      <div role="status"><Text as="h2" variant="title-s">{title}</Text><Text variant="label" tone="secondary">{note}</Text></div>
      {!run.planned && <Preparation run={run} />}
      {run.planned && !run.photos && <><Text variant="label">{run.scenePlan?.artDirection?.concept ?? run.scenePlan?.scene.title}</Text><details className={styles.detail}><summary>{ui("Персонаж: ")}{run.character?.name ?? ui("не выбран")} {ui(" · изменить")}</summary><CharacterField compact value={run.characterId ?? null} name={run.character?.name} disabled={busy} onChange={setCharacter} /></details>{!run.character && <Text variant="caption">{ui("Soul ID не выбран — фотографии будут без привязки к твоей внешности.")}</Text>}</>}
      {run.planned && !run.photos && hasStoryEvents(run.scenePlan) && <details className={styles.detail}><summary>{run.contentMode === 'broll' ? ui("Идеи B-roll") : ui("События по сценарию")} {ui(" · кадров: ")}{run.shots.length} {ui(" · сцен: ")}{run.scenePlan!.scenes!.length}</summary><div className={styles.shotPlan}>{run.scenePlan!.shots.map(shot => <article className={styles.planShot} key={shot.id}><Text variant="label" medium>{shot.title}</Text><>{shot.scriptExcerpt && <blockquote className={styles.scriptQuote}>{shot.scriptExcerpt}</blockquote>}{shot.concept && <Text variant="label">{shot.concept}</Text>}</><Text variant="label">{shot.action}</Text><Text variant="caption" tone="secondary">{sceneForShot(run.scenePlan!, shot).title} · {shot.framing}</Text></article>)}</div></details>}
      {run.planned && !run.photos && !hasStoryEvents(run.scenePlan) && <><Text variant="caption" tone="secondary">{ui("Это прежний план с общей сценой. Для отдельных событий и локаций нужна новая режиссура; сценарий и фото сохранятся.")}</Text><div><Button variant="border" disabled={busy} onClick={replan}>{ui("Новая режиссура по этому сценарию")}</Button></div></>}
      <PhotoStart run={run} />
      {master && <div className={styles.masterStrip}><button type="button" className={styles.thumbnail} onClick={() => setInspect(master.id)} aria-label={ui("Открыть опорный кадр")}><img src={master.url} alt={ui("Опорный кадр")} /></button><div><Text variant="label" medium>{ui("Опорный кадр · ")}{masterAttempts(run)} / 3</Text><Text variant="caption" tone="secondary">{masterApproved(run) ? run.masterReview?.criteriaVersion !== LOGIC_CRITERIA ? ui("Одежда и логика требуют перепроверки") : hasStoryEvents(run.scenePlan) ? ui("Образ проверен · у кадров своя композиция") : ui("Задаёт образ и сцену для серии") : masterRejected(run) ? ui("Не прошёл проверку — открой кадр, чтобы увидеть причину") : ['failed', 'interrupted'].includes(run.masterReview?.status ?? '') ? ui("Проверка остановилась — повтори её без пересоздания фото") : ui("Проверяется")}</Text><Button variant="ghost" onClick={() => setInspect(master.id)}>{ui("Рассмотреть")}</Button></div></div>}
      {master && ['failed', 'interrupted'].includes(run.masterReview?.status ?? '') && <div className={styles.costControls} role="status">
        <Text variant="label" medium>{ui("Опорный кадр сохранён, но проверка остановилась")}</Text>
        <Text variant="caption" tone="secondary">{ui("Остальные кадры не запускались. Подключи AI и повтори проверку ниже — новая платная генерация не создаётся. После успешной проверки продолжение серии подтверждается отдельно.")}</Text>
      </div>}
      <PhotoReview run={run} scope="master" />
      {masterRejected(run) && !canRegenerateMaster(run) && <ReusePlan run={run} />}
      {masterApproved(run) && ['failed', 'interrupted'].includes(run.review?.status ?? '') && <PhotoReview run={run} />}
      {failures.map(item => <div className={styles.costControls} key={item.tag}>
        <Text variant="caption">{item.key === 'scene' ? ui("Опорный кадр") : run.shots.find(s => s.id === item.key)?.title}: {item.error}</Text>
        {item.jobId && (item.status === 'download_failed' || item.errorCode === 'POLL_TIMEOUT') && <div><Button variant="border" disabled={busy} onClick={() => void photoCommand('photos/retry', { jobId: item.jobId })}>{ui("Повторить ")}{item.status === 'download_failed' ? ui("скачивание") : ui("проверку статуса")} {ui(" · без генерации")}</Button></div>}
      </div>)}
      {eligible.length > 0 && <PhotoSelection run={run} ids={selection} onDone={() => setSelected([])} onLoading={setSelecting} />}
      {run.shots.length > 0 && <Text variant="caption">{ui("Принято ")}{accepted} {ui(" из ")}{run.shots.length}. {accepted < run.shots.length ? ui("Без принятого фото: {0}.", run.shots.length - accepted) : ui("Все запланированные позиции закрыты.")}</Text>}
      {accepted > 0 && <div className={styles.headerActions}><Button variant="primary" loading={handoffBusy} onClick={() => {
        setHandoffBusy(true); setDownloadError(null);
        void (async () => {
          if (!await useCanvas.getState().flush()) throw new Error('Сначала сохрани открытый Canvas.');
          const flow = await seriesApi<{id:string}>(`/api/production/${run.id}/canvas`, {});
          await useCanvas.getState().loadFlows();
          if (!await useCanvas.getState().openFlow(flow.id, true)) throw new Error('Не удалось обновить Canvas. Правки сохранены; повтори переход.');
          window.location.hash = '/canvas';
        })().catch(e => setDownloadError(e instanceof Error ? e.message : 'Не удалось открыть Canvas.')).finally(() => setHandoffBusy(false));
      }}>{ui("Продолжить в Canvas")}</Button><Button variant="border" loading={downloading} onClick={() => {
        const ids = run.shots.flatMap(s => { const mediaId = currentArtifact(run, s.acceptedPhotoId)?.mediaId; return mediaId ? [mediaId] : []; });
        setDownloading(true); setDownloadError(null);
        void useGen.getState().exportMedia(ids).catch(e => setDownloadError(String(e))).finally(() => setDownloading(false));
      }}>{ui("Скачать принятые фото · ")}{accepted}</Button></div>}
      {downloadError && <Text role="alert">{downloadError}</Text>}
    </section>
    <section className={styles.productionResults} aria-label={ui("Изображения серии")}>
      <div className={styles.header}><Text as="h2" variant="title-s">{ui("Фотографии ")}<Text as="span" variant="caption" tone="secondary">{run.shots.filter(s => s.photoId).length} / {run.shots.length || '—'}</Text></Text>{eligible.length > 0 && <div className={styles.headerActions}><Button variant="ghost" disabled={busy || selecting || run.paused} onClick={() => setSelected(eligible)}>{ui("Выбрать все")}</Button></div>}</div>

      {run.shots.length > 0 ? <div className={styles.grid}>{run.shots.map(shot => {
        const photo = currentArtifact(run, shot.photoId);
        if (!photo) return <article className={styles.asset} key={shot.id}><div className={styles.resultEmpty}><Text variant="label" tone="secondary">{shot.error ? ui("Требует внимания") : ui("Ожидаем фотографию")}</Text></div><div className={styles.assetBody}><Text variant="label" medium>{shot.title}</Text><Text variant="caption" tone="secondary">{run.scenePlan?.shots.find(s => s.id === shot.id)?.scriptExcerpt ?? shot.action}</Text></div></article>;
        return <article className={styles.asset} key={photo.id}><button type="button" className={`${styles.thumbnail} ${styles.photoThumbnail}`} onClick={() => setInspect(photo.id)} aria-label={ui("Открыть {0}", shot.title)}><img src={photo.url} alt={shot.title} /></button><div className={styles.assetBody}><div className={styles.assetTitle}><Text variant="label" medium>{shot.title}</Text>{eligible.includes(photo.id) && <input type="checkbox" aria-label={ui("Принять {0}", shot.title)} checked={selection.includes(photo.id)} disabled={busy || selecting || run.paused} onChange={() => setSelected(selection.includes(photo.id) ? selection.filter(id => id !== photo.id) : [...selection, photo.id])} />}</div>{run.scenePlan?.shots.find(s => s.id === shot.id)?.scriptExcerpt && <Text variant="caption" tone="secondary">{run.scenePlan.shots.find(s => s.id === shot.id)!.scriptExcerpt}</Text>}{shot.acceptedPhotoId ? <Tag tone="success">{ui("Принято")}</Tag> : <PhotoVerdict compact result={reviewedPhoto(run, photo.id)} />}<a className={styles.download} href={photo.url} download>{ui("Скачать фото")}</a></div></article>;
      })}</div> : <div className={styles.resultEmpty}><Text variant="label" tone="secondary">{ui("Здесь появятся кадры серии после проверки опорного изображения.")}</Text></div>}
    </section>
    <details className={styles.productionDetails}><summary>{ui("Детали производства")}</summary><div className={styles.detailsBody}>
      <details className={styles.detail}><summary>{run.contentMode === 'broll' ? ui("Визуальный вектор и идеи B-roll") : ui("Сценарий, сцена и план кадров")}</summary>{run.script && <pre>{run.script}</pre>}<pre>{run.direction}</pre><Preparation run={run} /></details>
      <details className={styles.detail}><summary>{ui("Внешность и prompts")}</summary>{run.appearance?.error && <Text>{run.appearance.error}</Text>}{run.appearance?.output && <><Text>{run.appearance.output.profile.summaryRu}</Text><pre>{JSON.stringify(run.appearance.output.profile, null, 2)}</pre></>}<pre>{boundPrompts(run)?.masterPrompt}</pre>{boundPrompts(run)?.shots.map(shot => <pre key={shot.shotId}>{shot.shotId}: {shot.imagePrompt}</pre>)}</details>
      <PhotoReview run={run} allowComplete /><details className={styles.detail}><summary>{ui("Задачи и проверки")}</summary>{run.photos?.items.map(item => <div className={styles.photoJob} key={item.tag}><div><Text variant="label">{item.key === 'scene' ? ui("Опорный кадр") : run.shots.find(s => s.id === item.key)?.title}</Text><Text variant="caption">{item.taskId} {item.error}</Text></div><Tag>{ui(STATUS[item.status])}</Tag></div>)}{[run.appearance, run.masterReview, run.review].filter(Boolean).map((state, i) => <pre key={i}>{JSON.stringify(state, null, 2)}</pre>)}</details>
      {!!run.photos?.masterHistory?.length && <details className={styles.detail}><summary>{ui("Предыдущие опорные кадры · ")}{run.photos.masterHistory.length}</summary><div className={styles.grid}>{run.photos.masterHistory.map((history, i) => { const old = currentArtifact(run, history.artifactId); return old && <article key={old.id} className={styles.asset}><button className={styles.thumbnail} onClick={() => setInspect(old.id)} aria-label={ui("Открыть попытку {0}", i + 1)}><img src={old.url} alt={ui("Опорный кадр, попытка {0}", i + 1)} /></button><div className={styles.assetBody}><Text variant="caption">{history.review.report?.results[0]?.reason}</Text></div></article>; })}</div></details>}
      {accepted > 0 && <a className={styles.download} href={`/api/production/${run.id}/manifest`} download>{ui("Скачать описание серии")}</a>}
      {run.retouch && <details className={styles.detail}><summary>{ui("Автоправки · версии и проверки")}</summary><pre>{JSON.stringify(run.retouch, null, 2)}</pre></details>}
      <details className={styles.detail}><summary>{ui("История · ")}{run.events.length}</summary><ol className={styles.events}>{run.events.map((event, i) => <li key={i}><time>{new Date(event.at).toLocaleTimeString('ru-RU')}</time>{event.message}</li>)}</ol></details>
      <Button variant="border" disabled={busy} onClick={replan}>{ui("Изменить замысел — открыть заполненный brief")}</Button><Text variant="caption" tone="secondary">{ui("Новая версия плана создаётся отдельно. Текущая серия и фото сохраняются.")}</Text>
      {failures.some(i => i.status === 'failed' || i.status === 'unknown') && <ReusePlan run={run} />}
    </div></details>
    <Dialog open={!!artifact} onOpenChange={open => { if (!open) setInspect(null); }} size="l" title={artifact?.shotId === 'scene' ? ui("Опорный кадр") : run.shots.find(s => s.id === artifact?.shotId)?.title ?? ui("Фотография")} description={ui("Фото и результат проверки")}>
      {artifact && <div className={styles.inspect}><img className={styles.preview} src={artifact.url} alt={artifact.shotId === 'scene' ? ui("Опорный кадр") : ui("Фотография серии")} /><div className={styles.inspectData}><PhotoVerdict result={inspectReview || undefined} /><a className={styles.download} href={artifact.url} download>{ui("Скачать эту версию")}</a>{artifact.sourceId && currentArtifact(run, artifact.sourceId) && <Button variant="border" onClick={() => setInspect(artifact.sourceId)}>{ui("Посмотреть до правки")}</Button>}<details className={styles.detail}><summary>{ui("Prompt и данные задачи")}</summary><Text variant="caption">{artifact.model} · {artifact.taskId} {ui(" · оценка ")}{photoPrice(artifact.cost)}</Text><Text variant="caption">{artifact.qcNote}</Text><pre>{artifact.prompt}</pre></details></div></div>}
    </Dialog>
  </>;
}
