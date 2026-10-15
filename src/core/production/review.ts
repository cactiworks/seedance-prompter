import { z } from 'zod';
import type { ProductionRun } from './model.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const check = z.enum(['pass', 'fail', 'uncertain', 'not_visible']);
export const ReviewResultSchema = z.object({
  artifactId: text(120), verdict: z.enum(['keep', 'reject', 'uncertain']), reason: text(700),
  checks: z.object({ face: check, likeness: check, hands: check, continuity: check, shotMatch: check, visualInterest: check }).strict(),
  observations: z.array(z.object({ region: text(120), evidence: text(500) }).strict()).min(1).max(6),
}).strict();
export const ReviewReportSchema = z.object({ summary: text(1400), results: z.array(ReviewResultSchema).min(1).max(9) }).strict();
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export const ReviewStateSchema = z.object({
  status: z.enum(['pending', 'running', 'complete', 'failed', 'interrupted']), requestId: z.uuid(),
  consentedAt: z.string(), artifactIds: z.array(z.string()), identityCount: z.number().int().min(0).max(2),
  report: ReviewReportSchema.nullable(), error: z.string().nullable(),
  model: z.string().nullable(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable(),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export const ReviewStartSchema = z.object({ rev: z.number().int().nonnegative(), requestId: z.uuid(), consent: z.literal(true) }).strict();
export const pendingReview = (requestId: string, now: number): ReviewState => ({
  status: 'pending', requestId, consentedAt: new Date(now).toISOString(), artifactIds: [], identityCount: 0,
  report: null, error: null, model: null, inputTokens: null, outputTokens: null,
});
export const reviewArtifacts = (run: ProductionRun) => run.artifacts.filter((a) => a.kind === 'photo' && a.mediaId && (a.id === run.photos?.masterArtifactId || run.shots.some((s) => s.photoId === a.id)));
export const reviewedPhoto = (run: ProductionRun, id: string) => run.review?.status === 'complete' && run.review.artifactIds.includes(id)
  ? run.review.report?.results.find((r) => r.artifactId === id) : undefined;
/** Do not accept fabricated/missing IDs, contradictions or a face comparison without a reference. */
export function validateReview(report: ReviewReport, ids: string[], identityCount: number): ReviewReport {
  const results = report.results.map((r) => r.artifactId);
  if (results.length !== ids.length || new Set(results).size !== ids.length || ids.some((id) => !results.includes(id))) throw new Error('Критик вернул неполный список кадров.');
  return { ...report, results: report.results.map((r) => {
    const checks = { ...r.checks };
    if (['continuity', 'shotMatch', 'visualInterest'].some((key) => checks[key as keyof typeof checks] === 'not_visible')) throw new Error('Критик пропустил обязательный критерий.');
    if (checks.face === 'not_visible') checks.likeness = 'not_visible';
    else if (identityCount === 0 || checks.likeness === 'not_visible') checks.likeness = 'uncertain';
    const verdict = Object.values(checks).includes('fail') ? 'reject' : Object.values(checks).includes('uncertain') && r.verdict === 'keep' ? 'uncertain' : r.verdict;
    return { ...r, checks, verdict };
  }) };
}
