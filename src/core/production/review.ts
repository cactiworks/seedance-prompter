import { z } from 'zod';
import type { ProductionRun } from './model.ts';
import { appearanceReady, MAX_IDENTITY_REFS } from './appearance.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const check = z.enum(['pass', 'variation', 'fail', 'uncertain', 'not_visible', 'not_applicable']);
const detailCheck = z.enum(['pass', 'fail', 'uncertain', 'not_visible']);
const faceDetail = z.object({ leftEye: detailCheck, rightEye: detailCheck, mouth: detailCheck }).strict();
const observation = z.object({ check: z.enum(['face', 'character', 'hands', 'identityLeakage', 'text', 'likeness', 'continuity', 'shotMatch', 'visualInterest']).optional(), region: text(120), evidence: text(500) }).strict();
export const DETAIL_CRITERIA = 'details-v4' as const;
const DETAIL_EVIDENCE = ['face', 'character', 'hands', 'identityLeakage', 'text'] as const;
export const ReviewResultSchema = z.object({
  artifactId: text(120), verdict: z.enum(['keep', 'reject', 'uncertain']), reason: text(700),
  checks: z.object({ face: check, likeness: check, character: check.optional(), hands: check, identityLeakage: check.optional(), text: check.optional(), continuity: check, shotMatch: check, visualInterest: check }).strict(),
  faceDetail: faceDetail.optional(),
  observations: z.array(observation).min(1).max(10),
}).strict();
export const ReviewReportSchema = z.object({ summary: text(1400), results: z.array(ReviewResultSchema).min(1).max(9) }).strict();
export const GeneratedReviewResultSchema = ReviewResultSchema.extend({ checks: ReviewResultSchema.shape.checks.extend({ character: check, identityLeakage: check, text: check }) });
export const GeneratedReviewReportSchema = ReviewReportSchema.extend({ results: z.array(GeneratedReviewResultSchema).min(1).max(9) });
export const DetailedReviewReportSchema = ReviewReportSchema.extend({ results: z.array(GeneratedReviewResultSchema.extend({ faceDetail, observations: z.array(observation.extend({ check: observation.shape.check.unwrap() })).min(5).max(10) })).min(1).max(9) });
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export const ReviewCheckSchema = ReviewResultSchema.shape.checks.keyof();
export type ReviewCheck = z.infer<typeof ReviewCheckSchema>;
export const ReviewDismissalSchema = z.object({ artifactId: text(120), check: ReviewCheckSchema, at: z.string() });
export type ReviewDismissal = z.infer<typeof ReviewDismissalSchema>;
export const REVIEW_CHECK_LABELS: Record<ReviewCheck, string> = { face: 'Лицо', likeness: 'Сходство лица', character: 'Персонаж целиком', hands: 'Руки', identityLeakage: 'Лицо на других людях', text: 'Текст в кадре', continuity: 'Единство сцены', shotMatch: 'Соответствие кадру', visualInterest: 'Выразительность' };
export const dismissedChecks = (run: ProductionRun, id: string) => (run.reviewDismissals ?? []).filter(d => d.artifactId === id).map(d => d.check);
/** Owner decisions affect workflow only; the critic's original report stays intact. */
export function applyReviewDismissals(run: ProductionRun, result: ReviewResult): ReviewResult {
  const dismissed = dismissedChecks(run, result.artifactId).filter(key => ['fail', 'uncertain'].includes(result.checks[key] ?? ''));
  if (!dismissed.length) return result;
  const checks = { ...result.checks };
  for (const key of dismissed) checks[key] = key === 'likeness' && !run.character ? 'not_applicable' : 'pass';
  const verdict = Object.values(checks).includes('fail') ? 'reject' : Object.values(checks).includes('uncertain') ? 'uncertain' : 'keep';
  const issue = result.observations.find(o => o.check && ['fail', 'uncertain'].includes(checks[o.check] ?? ''));
  return { ...result, checks, verdict, reason: verdict === 'keep' ? 'Замечания сняты владельцем для этой версии фото.' : issue ? `${issue.region}: ${issue.evidence}` : 'Остались замечания критика. Открой фото, чтобы проверить их.' };
}
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export const ReviewStateSchema = z.object({
  status: z.enum(['pending', 'running', 'complete', 'failed', 'interrupted']), requestId: z.uuid(),
  consentedAt: z.string(), artifactIds: z.array(z.string()), identityCount: z.number().int().min(0).max(MAX_IDENTITY_REFS),
  referenceLimit: z.number().int().min(1).max(MAX_IDENTITY_REFS).optional(),
  appearanceRequestId: z.string().nullable().optional(),
  criteriaVersion: z.enum(['creator-v2', 'details-v3', DETAIL_CRITERIA]).optional(),
  report: ReviewReportSchema.nullable(), error: z.string().nullable(),
  model: z.string().nullable(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable(),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export const ReviewStartSchema = z.object({ rev: z.number().int().nonnegative(), requestId: z.uuid(), consent: z.literal(true), scope: z.enum(['master', 'series']).optional(), referenceLimit: z.literal(6).optional() }).strict();
export const pendingReview = (requestId: string, now: number): ReviewState => ({
  criteriaVersion: DETAIL_CRITERIA, status: 'pending', requestId, consentedAt: new Date(now).toISOString(), artifactIds: [], identityCount: 0,
  report: null, error: null, model: null, inputTokens: null, outputTokens: null,
});
export const reviewArtifacts = (run: ProductionRun) => run.artifacts.filter((a) => a.kind === 'photo' && a.mediaId && (a.id === run.photos?.masterArtifactId || run.shots.some((s) => s.photoId === a.id)));
export const originalPhotoReview = (run: ProductionRun, id: string) => {
  const repaired = run.retouch?.items.find(i => i.currentId === id && i.audit?.result.artifactId === id)?.audit?.result;
  if (repaired) return repaired;
  const review = id === run.photos?.masterArtifactId ? run.masterReview ?? run.review : run.review;
  return review?.status === 'complete' && review.artifactIds.includes(id) ? review.report?.results.find(r => r.artifactId === id) : undefined;
};
export const reviewedPhoto = (run: ProductionRun, id: string) => {
  const result = originalPhotoReview(run, id);
  return result ? applyReviewDismissals(run, result) : undefined;
};
/** Fail closed, including legacy reports without a whole-character check. */
export function masterApproved(run: ProductionRun): boolean {
  const id = run.photos?.masterArtifactId;
  const review = run.masterReview;
  const original = review?.report?.results.find(r => r.artifactId === id);
  const result = original && applyReviewDismissals(run, original);
  return !!id && appearanceReady(run) && review?.status === 'complete' && review.artifactIds.length === 1 && review.artifactIds[0] === id
    && review.appearanceRequestId === (run.character ? run.appearance?.requestId : null)
    && (!run.character || review.identityCount > 0) && result?.verdict === 'keep'
    && result.checks.character === 'pass' && result.checks.face === 'pass'
    && ['pass', 'variation'].includes(result.checks.continuity) && ['pass', 'variation'].includes(result.checks.shotMatch) && ['pass', 'variation'].includes(result.checks.visualInterest)
    && ['pass', 'not_visible'].includes(result.checks.hands)
    && (!['details-v3', DETAIL_CRITERIA].includes(review.criteriaVersion ?? '') || (result.checks.identityLeakage === 'pass' && ['pass', 'not_visible'].includes(result.checks.text ?? '')))
    && (review.criteriaVersion !== DETAIL_CRITERIA || (!!result.faceDetail && (dismissedChecks(run, id).includes('face') || (Object.values(result.faceDetail).some(v => v === 'pass') && Object.values(result.faceDetail).every(v => ['pass', 'not_visible'].includes(v)))) && DETAIL_EVIDENCE.every(key => result.observations.some(o => o.check === key))))
    && result.checks.likeness === (run.character ? 'pass' : 'not_applicable');
}
/** Do not accept fabricated/missing IDs, contradictions or a face comparison without a reference. */
export function validateReview(report: ReviewReport, ids: string[], identityCount: number, identityRequired = true): ReviewReport {
  const results = report.results.map((r) => r.artifactId);
  if (results.length !== ids.length || new Set(results).size !== ids.length || ids.some((id) => !results.includes(id))) throw new Error('Критик вернул неполный список кадров.');
  return { ...report, results: report.results.map((r) => {
    const checks = { ...r.checks };
    if (r.faceDetail) {
      const values = Object.values(r.faceDetail);
      if (values.includes('fail')) checks.face = 'fail';
      else if (values.includes('uncertain') && checks.face !== 'fail') checks.face = 'uncertain';
      else if (values.every(v => v === 'not_visible') && checks.face === 'pass') checks.face = 'uncertain';
    }
    if (Object.entries(checks).some(([key, value]) => value === 'variation' && !['continuity', 'shotMatch', 'visualInterest'].includes(key))) throw new Error('Допустимое отклонение не заменяет проверку внешности и анатомии.');
    if (['continuity', 'shotMatch', 'visualInterest', 'identityLeakage'].some((key) => checks[key as keyof typeof checks] === 'not_visible') || Object.entries(checks).some(([key, value]) => value === 'not_applicable' && (key !== 'likeness' || identityRequired))) throw new Error('Критик пропустил обязательный критерий.');
    if (!identityRequired) checks.likeness = 'not_applicable';
    else if (checks.face === 'not_visible') checks.likeness = 'not_visible';
    else if (identityCount === 0 || checks.likeness === 'not_visible') checks.likeness = 'uncertain';
    const verdict = Object.values(checks).includes('fail') ? 'reject' : Object.values(checks).includes('uncertain') && r.verdict === 'keep' ? 'uncertain' : r.verdict;
    const issue = r.observations.find(o => o.check && ['fail', 'uncertain'].includes(checks[o.check] ?? ''));
    const reason = verdict !== r.verdict && issue ? `${issue.region}: ${issue.evidence}`.slice(0, 700) : r.reason;
    return { ...r, checks, verdict, reason };
  }) };
}

/** A general compliment cannot substitute for the five explicit detail inspections. */
export function validateDetailedReview(report: ReviewReport, ids: string[], identityCount: number, identityRequired: boolean, faceExpected: string[] = []): ReviewReport {
  const detailed = DetailedReviewReportSchema.parse(report);
  for (const result of detailed.results) {
    if (DETAIL_EVIDENCE.some(key => !result.observations.some(o => o.check === key))) throw new Error('Критик не описал обязательные области проверки.');
    if (faceExpected.includes(result.artifactId) && (result.checks.face === 'not_visible' || Object.values(result.faceDetail).every(v => v === 'not_visible'))) {
      result.checks.face = 'uncertain'; result.checks.shotMatch = 'uncertain'; result.verdict = result.verdict === 'reject' ? 'reject' : 'uncertain';
      result.reason = 'Лицо главного героя не удалось проверить. Нужен читаемый кадр или ручная проверка.';
    }
  }
  return validateReview(detailed, ids, identityCount, identityRequired);
}
