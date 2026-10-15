import { z } from 'zod';
import type { ProductionRun } from './model.ts';
import { appearanceReady, MAX_IDENTITY_REFS } from './appearance.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const check = z.enum(['pass', 'fail', 'uncertain', 'not_visible', 'not_applicable']);
export const ReviewResultSchema = z.object({
  artifactId: text(120), verdict: z.enum(['keep', 'reject', 'uncertain']), reason: text(700),
  checks: z.object({ face: check, likeness: check, character: check.optional(), hands: check, continuity: check, shotMatch: check, visualInterest: check }).strict(),
  observations: z.array(z.object({ region: text(120), evidence: text(500) }).strict()).min(1).max(6),
}).strict();
export const ReviewReportSchema = z.object({ summary: text(1400), results: z.array(ReviewResultSchema).min(1).max(9) }).strict();
export const GeneratedReviewReportSchema = ReviewReportSchema.extend({ results: z.array(ReviewResultSchema.extend({ checks: ReviewResultSchema.shape.checks.extend({ character: check }) })).min(1).max(9) });
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export const ReviewStateSchema = z.object({
  status: z.enum(['pending', 'running', 'complete', 'failed', 'interrupted']), requestId: z.uuid(),
  consentedAt: z.string(), artifactIds: z.array(z.string()), identityCount: z.number().int().min(0).max(MAX_IDENTITY_REFS),
  referenceLimit: z.number().int().min(1).max(MAX_IDENTITY_REFS).optional(),
  appearanceRequestId: z.string().nullable().optional(),
  report: ReviewReportSchema.nullable(), error: z.string().nullable(),
  model: z.string().nullable(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable(),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export const ReviewStartSchema = z.object({ rev: z.number().int().nonnegative(), requestId: z.uuid(), consent: z.literal(true), scope: z.enum(['master', 'series']).optional(), referenceLimit: z.literal(6).optional() }).strict();
export const pendingReview = (requestId: string, now: number): ReviewState => ({
  status: 'pending', requestId, consentedAt: new Date(now).toISOString(), artifactIds: [], identityCount: 0,
  report: null, error: null, model: null, inputTokens: null, outputTokens: null,
});
export const reviewArtifacts = (run: ProductionRun) => run.artifacts.filter((a) => a.kind === 'photo' && a.mediaId && (a.id === run.photos?.masterArtifactId || run.shots.some((s) => s.photoId === a.id)));
export const reviewedPhoto = (run: ProductionRun, id: string) => {
  const review = id === run.photos?.masterArtifactId ? run.masterReview ?? run.review : run.review;
  return review?.status === 'complete' && review.artifactIds.includes(id) ? review.report?.results.find(r => r.artifactId === id) : undefined;
};
/** Fail closed, including legacy reports without a whole-character check. */
export function masterApproved(run: ProductionRun): boolean {
  const id = run.photos?.masterArtifactId;
  const review = run.masterReview;
  const result = review?.report?.results.find(r => r.artifactId === id);
  return !!id && appearanceReady(run) && review?.status === 'complete' && review.artifactIds.length === 1 && review.artifactIds[0] === id
    && review.appearanceRequestId === (run.character ? run.appearance?.requestId : null)
    && (!run.character || review.identityCount > 0) && result?.verdict === 'keep'
    && result.checks.character === 'pass' && result.checks.face === 'pass'
    && result.checks.continuity === 'pass' && result.checks.shotMatch === 'pass' && result.checks.visualInterest === 'pass'
    && ['pass', 'not_visible'].includes(result.checks.hands)
    && result.checks.likeness === (run.character ? 'pass' : 'not_applicable');
}
/** Do not accept fabricated/missing IDs, contradictions or a face comparison without a reference. */
export function validateReview(report: ReviewReport, ids: string[], identityCount: number, identityRequired = true): ReviewReport {
  const results = report.results.map((r) => r.artifactId);
  if (results.length !== ids.length || new Set(results).size !== ids.length || ids.some((id) => !results.includes(id))) throw new Error('Критик вернул неполный список кадров.');
  return { ...report, results: report.results.map((r) => {
    const checks = { ...r.checks };
    if (['continuity', 'shotMatch', 'visualInterest'].some((key) => checks[key as keyof typeof checks] === 'not_visible') || Object.entries(checks).some(([key, value]) => value === 'not_applicable' && (key !== 'likeness' || identityRequired))) throw new Error('Критик пропустил обязательный критерий.');
    if (!identityRequired) checks.likeness = 'not_applicable';
    else if (checks.face === 'not_visible') checks.likeness = 'not_visible';
    else if (identityCount === 0 || checks.likeness === 'not_visible') checks.likeness = 'uncertain';
    const verdict = Object.values(checks).includes('fail') ? 'reject' : Object.values(checks).includes('uncertain') && r.verdict === 'keep' ? 'uncertain' : r.verdict;
    return { ...r, checks, verdict };
  }) };
}
