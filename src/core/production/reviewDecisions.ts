import { currentArtifact, type ProductionRun, type RunAction } from './model.ts';
import { ProductionError, record } from './engine.ts';
import { dismissedChecks, originalPhotoReview, reviewedPhoto, REVIEW_CHECK_LABELS } from './review.ts';

/** Changing a review must never race an in-flight review, dispatch or download. */
export function reviewDecisionBlocked(run: ProductionRun): boolean {
  return run.mode !== 'photos' || !run.photos || run.photos.status === 'running' || run.retouch?.status === 'running'
    || [run.preparation, run.appearance, run.masterReview, run.review].some(s => s?.status === 'running' || s?.status === 'pending')
    || run.photos.items.some(i => ['submitting', 'queued', 'running', 'downloading', 'unknown', 'download_failed'].includes(i.status))
    || !!run.retouch?.items.some(i => i.attempts.some(a => !a.artifactId && a.status !== 'cancelled' && !(a.status === 'failed' && a.errorCode !== 'POLL_TIMEOUT')));
}
export function canAcceptReviewedPhoto(run: ProductionRun, id: string): boolean {
  const item = run.retouch?.items.find(i => i.currentId === id);
  return !reviewDecisionBlocked(run) && dismissedChecks(run, id).length > 0
    && !!currentArtifact(run, id)?.mediaId && run.shots.some(s => s.photoId === id && s.step === 'photoReview' && !s.acceptedPhotoId)
    && reviewedPhoto(run, id)?.verdict === 'keep' && (!item || (item.audit?.result.artifactId === id && item.audit.preserved === 'pass'));
}
function updateCompletion(run: ProductionRun) {
  if (run.retouch) {
    run.retouch.status = run.retouch.selected.every(key => run.retouch!.items.some(i => i.shotId === key && i.status === 'complete')) ? 'complete' : 'stopped';
  }
  run.photos!.status = run.shots.every(s => s.step === 'ready' && s.acceptedPhotoId === s.photoId) ? 'complete' : 'review';
}
export function applyReviewDecision(run: ProductionRun, action: Extract<RunAction, { type: 'setReviewDismissal' | 'acceptReviewedPhoto' }>, now: number): void {
  if (reviewDecisionBlocked(run)) throw new ProductionError('INVALID', 'Дождись текущих задач или поставь серию на паузу. Незавершённую отправку сначала нужно проверить.');
  const id = action.artifactId;
  const result = originalPhotoReview(run, id);
  const shot = run.shots.find(s => s.photoId === id);
  const artifact = currentArtifact(run, id);
  if ((!shot && run.photos?.masterArtifactId !== id) || !artifact?.mediaId || !result) throw new ProductionError('INVALID', 'Замечания доступны только для текущей версии фото с завершённой проверкой.');
  if (action.type === 'setReviewDismissal') {
    const exists = dismissedChecks(run, id).includes(action.check);
    if (action.dismissed && !['fail', 'uncertain'].includes(result.checks[action.check] ?? '')) throw new ProductionError('INVALID', 'У этой проверки нет замечания.');
    if (action.dismissed === exists) return;
    run.reviewDismissals = (run.reviewDismissals ?? []).filter(d => d.artifactId !== id || d.check !== action.check);
    if (action.dismissed) run.reviewDismissals.push({ artifactId: id, check: action.check, at: new Date(now).toISOString() });
    if (!action.dismissed && shot?.acceptedPhotoId === id && reviewedPhoto(run, id)?.verdict !== 'keep') {
      shot.acceptedPhotoId = null; shot.step = 'photoReview'; shot.error = null;
      artifact.qc = 'review'; artifact.qcNote = 'Владелец вернул замечание. Кадр снова ожидает решения.';
      const item = run.retouch?.items.find(i => i.currentId === id);
      if (item) { item.status = 'blocked'; item.error = artifact.qcNote; }
      updateCompletion(run);
    }
    record(run, now, `${shot?.title ?? 'Опорный кадр'}: ${action.dismissed ? 'владелец решил не исправлять' : 'владелец вернул замечание'} «${REVIEW_CHECK_LABELS[action.check]}». Решение относится только к версии ${id}.`);
    return;
  }
  if (!canAcceptReviewedPhoto(run, id) || !shot) throw new ProductionError('INVALID', 'Сначала разбери оставшиеся замечания и проверку сохранности кадра.');
  shot.acceptedPhotoId = id; shot.step = 'ready'; shot.error = null;
  artifact.qc = 'review'; artifact.qcNote = 'Принято владельцем без правок после снятия замечаний. Исходный отчёт критика сохранён.';
  const item = run.retouch?.items.find(i => i.currentId === id);
  if (item) { item.status = 'complete'; item.error = null; }
  run.approvals.push({ kind: 'photo', artifactId: id, at: new Date(now).toISOString() });
  updateCompletion(run);
  record(run, now, `${shot.title}: принято владельцем без правок. Новые генерации и проверки не запускались.`);
}
