import { useState } from 'react';
import type { ProductionRun } from '../../core/production/model.ts';
import { masterApproved, DETAIL_CRITERIA, dismissedChecks, originalPhotoReview, reviewedPhoto, REVIEW_CHECK_LABELS, type ReviewCheck, type ReviewResult } from '../../core/production/review.ts';
import { canAcceptReviewedPhoto, reviewDecisionBlocked } from '../../core/production/reviewDecisions.ts';
import { appearanceReady } from '../../core/production/appearance.ts';
import { Button, Tag, Text } from '../ui/components/index.ts';
import { useProduction } from './store.ts';
import styles from './Production.module.css';

export const VERDICT = { keep: 'Рекомендован', uncertain: 'Проверь вручную', reject: 'Есть замечание' };
const CHECKS = REVIEW_CHECK_LABELS;
const RESULT = { pass: 'без видимых проблем', variation: 'допустимое отклонение', fail: 'существенная проблема', uncertain: 'не уверен', not_visible: 'вне кадра', not_applicable: 'привязка к внешности не задана' };
export function PhotoVerdict({ result, compact = false, ownerDecision = false, originalResult }: { result?: ReviewResult; compact?: boolean; ownerDecision?: boolean; originalResult?: ReviewResult }) {
  if (!result) return <Text variant="caption" tone="secondary">Проверяется</Text>;
  const original = originalResult ?? result;
  return <><Tag tone={result.verdict === 'keep' ? 'success' : 'warning'}>{ownerDecision && result.verdict === 'keep' ? 'Замечания сняты' : VERDICT[result.verdict]}</Tag>{(!compact || result.verdict !== 'keep') && <Text variant="caption">{result.reason}</Text>}
    {!compact && <details className={styles.detail}><summary>{ownerDecision ? 'Исходный отчёт критика' : 'Что увидел критик'}</summary><ul className={styles.planNotes}>
      {Object.entries(original.checks).map(([key, value]) => <li key={key}>{CHECKS[key as keyof typeof CHECKS]}: {RESULT[value]}</li>)}
      {original.faceDetail && <li>Глаз слева на фото: {RESULT[original.faceDetail.leftEye]}; справа: {RESULT[original.faceDetail.rightEye]}; рот: {RESULT[original.faceDetail.mouth]}.</li>}
      {original.observations.map((observation, i) => <li key={i}>{observation.region}: {observation.evidence}</li>)}
    </ul></details>}</>;
}
export function PhotoReviewDecisions({ run, artifactId }: { run: ProductionRun; artifactId: string }) {
  const { act, busy, error } = useProduction();
  const result = originalPhotoReview(run, artifactId);
  const effective = reviewedPhoto(run, artifactId);
  const dismissed = dismissedChecks(run, artifactId);
  const checks = result ? (Object.keys(result.checks) as ReviewCheck[]).filter(key => ['fail', 'uncertain'].includes(result.checks[key] ?? '') || dismissed.includes(key)) : [];
  const blocked = reviewDecisionBlocked(run);
  if (!result || !checks.length || (artifactId !== run.photos?.masterArtifactId && !run.shots.some(s => s.photoId === artifactId))) return null;
  return <section className={styles.reviewDecisions} aria-label="Решение по замечаниям">
    <Text variant="label" medium>Что исправлять</Text>
    <Text variant="caption" tone="secondary">Если замечание не мешает результату, нажми «Не исправлять». Решение сохранится для этой версии фото.</Text>
    {checks.map(check => <div className={styles.reviewIssue} key={check}>
      <div><Text variant="label" medium>{CHECKS[check]}</Text><Text variant="caption" tone={dismissed.includes(check) ? 'secondary' : 'primary'}>{result.observations.filter(o => o.check === check).map(o => `${o.region}: ${o.evidence}`).join(' ') || result.reason}</Text>{dismissed.includes(check) && <Text variant="caption" tone="secondary">Снято тобой · исправление не требуется</Text>}</div>
      <Button variant="ghost" disabled={busy || blocked} aria-label={`${dismissed.includes(check) ? 'Вернуть замечание' : 'Не исправлять'}: ${CHECKS[check]}`} onClick={() => void act({ type: 'setReviewDismissal', artifactId, check, dismissed: !dismissed.includes(check) })}>{dismissed.includes(check) ? 'Вернуть замечание' : 'Не исправлять'}</Button>
    </div>)}
    {blocked && <Text variant="caption" tone="secondary">Дождись текущих задач или поставь серию на паузу. Незавершённую отправку сначала нужно проверить.</Text>}
    {error && <Text variant="caption" role="alert">{error}</Text>}
    {canAcceptReviewedPhoto(run, artifactId) && <Button variant="border" disabled={busy} onClick={() => void act({ type: 'acceptReviewedPhoto', artifactId })}>Принять без правок</Button>}
    {dismissed.length > 0 && effective?.verdict === 'keep' && artifactId === run.photos?.masterArtifactId && masterApproved(run) && <Text variant="caption">Опорный кадр принят с твоими решениями. Продолжить создание фото можно из серии после подтверждения стоимости.</Text>}
  </section>;
}
export function PhotoReview({ run, scope = 'series', allowComplete = false }: { run: ProductionRun; scope?: 'master' | 'series'; allowComplete?: boolean }) {
  const { photoCommand, busy } = useProduction();
  const [consent, setConsent] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const master = scope === 'master';
  const state = master ? run.masterReview : run.review;
  const activeMedia = run.photos?.status === 'running' || run.photos?.items.some(i => ['submitting', 'queued', 'running', 'downloading'].includes(i.status));
  const hasPhotos = master ? !!run.photos?.masterArtifactId && appearanceReady(run) : run.shots.some(s => s.photoId);
  if (run.retouch?.status === 'running') return null;
  if (['running', 'pending'].includes(state?.status ?? '') || activeMedia || !hasPhotos) return null;
  const outdated = state?.status === 'complete' && state.criteriaVersion !== DETAIL_CRITERIA;
  if (master && state?.status === 'complete' && masterApproved(run)) return null;
  if (state?.status === 'complete' && !outdated && !allowComplete && (!master || masterApproved(run))) return null;
  return <details className={styles.detail} open={state?.status !== 'complete'}>
    <summary>{outdated ? master ? 'Перепроверить детали master' : 'Перепроверить детали крупным планом' : master ? 'Перепроверить этот кадр без генерации' : 'Повторить отбор фотографий'}</summary>
    {outdated && <Text variant="caption">Предыдущий отбор был без отдельных фрагментов и проверки каждого глаза. Сохранённые фото можно проверить заново; генерация не запускается.</Text>}
    {master && state?.status === 'complete' && <Text variant="caption">{state.criteriaVersion ? 'Кадр будет проверен заново; фото не перегенерируются.' : 'Короткие рукава и мелкие отличия одежды теперь допустимы. Кадр будет проверен заново; фото не перегенерируются.'}</Text>}
    <Text variant="caption" tone="secondary">Критик увидит общий кадр и четыре крупных фрагмента каждого исходника. Проверит глаза, рот, руки, фоновые лица и текст; художественные отклонения оценивает отдельно.</Text>
    <label className={styles.check}><input type="checkbox" checked={consent} disabled={busy || run.paused} onChange={e => setConsent(e.target.checked)} />Разрешаю отправить {master ? 'master' : 'фото серии'} с крупными фрагментами и до шести фото Soul ID в Codex / OpenAI. Один вызов из квоты ChatGPT; крупные фрагменты увеличивают расход.</label>
    <Button variant="border" disabled={!consent || busy || run.paused} onClick={() => void photoCommand('review', { rev: run.rev, requestId, consent: true, scope, referenceLimit: 6 }).then(ok => { if (ok) { setConsent(false); setRequestId(crypto.randomUUID()); } })}>{master ? 'Перепроверить master' : 'Проверить фотографии'}</Button>
  </details>;
}
