import { z } from 'zod';
import { estimate, findModel, paramsFor } from '../gen/models.ts';
import { buildRegionPrompt } from '../gen/regionEdit.ts';
import type { ProductionRun } from './model.ts';
import { GeneratedReviewResultSchema, LogicReviewResultSchema, logicReviewPassed, validateLogicResult, validateReview } from './review.ts';
import { photoOutput, type PhotoOutput } from './output.ts';

export const RETOUCH_MODEL = 'kie/seedream-5-pro';
// The compositor returns the source pixel dimensions; 2K is only the edit working size.
export const retouchParams = (run: Partial<PhotoOutput>) => ({ resolution: '2K', aspectRatio: photoOutput(run).aspectRatio });
export const MAX_RETOUCH_ATTEMPTS = 3;
const box = z.object({ x1: z.number().int().min(0).max(999), y1: z.number().int().min(0).max(999), x2: z.number().int().min(0).max(999), y2: z.number().int().min(0).max(999) }).strict();
export const RetouchAuditSchema = z.object({
  result: GeneratedReviewResultSchema,
  preserved: z.enum(['pass', 'fail', 'uncertain']),
  fixes: z.array(z.object({
    check: z.enum(['character', 'face', 'likeness', 'hands', 'identityLeakage', 'text', 'wardrobe', 'sceneLogic']),
    box, instructionEn: z.string().trim().min(10).max(550), reason: z.string().trim().min(1).max(220),
  }).strict()).max(6),
}).strict();
export const GeneratedRetouchAuditSchema = RetouchAuditSchema.extend({ result: LogicReviewResultSchema });
export type RetouchAudit = z.infer<typeof RetouchAuditSchema>;
export const RetouchItemSchema = z.object({
  shotId: z.string(), originalId: z.string(), currentId: z.string(),
  status: z.enum(['pending', 'checking', 'planned', 'generating', 'blocked', 'complete']),
  error: z.string().nullable(), audit: RetouchAuditSchema.nullable(),
  history: z.array(z.object({ artifactId: z.string(), audit: RetouchAuditSchema })),
  attempts: z.array(z.object({ tag: z.string(), sourceId: z.string(), jobId: z.string().nullable(), artifactId: z.string().nullable(), prompt: z.string(), status: z.string(), errorCode: z.string().nullable().optional() })).max(MAX_RETOUCH_ATTEMPTS),
});
export type RetouchItem = z.infer<typeof RetouchItemSchema>;
export const RetouchStateSchema = z.object({
  status: z.enum(['running', 'stopped', 'complete']), requestId: z.uuid(), requests: z.array(z.uuid()),
  selected: z.array(z.string()).min(1), items: z.array(RetouchItemSchema),
  uploadIds: z.array(z.string()).max(2), appearanceRequestId: z.string().nullable(),
  remainingUsd: z.number().nonnegative(), perEditUsd: z.number().nonnegative(),
});
export type RetouchState = z.infer<typeof RetouchStateSchema>;
export const RetouchStartSchema = z.object({
  rev: z.number().int().nonnegative(), requestId: z.uuid(), ids: z.array(z.string()).min(1),
  confirmUsd: z.number().nonnegative(), consent: z.literal(true),
}).strict();
export type RetouchStart = z.infer<typeof RetouchStartSchema>;
export const retouchPrice = (refs: number, run: Partial<PhotoOutput>) => { const model = findModel(RETOUCH_MODEL)!; return estimate(model, paramsFor(model, retouchParams(run)), 1, refs); };
export function quoteRetouch(run: ProductionRun, ids: string[]) {
  const uploads = run.retouch?.uploadIds ?? (run.character ? run.appearance?.uploadIds.slice(0, 2) ?? [] : []);
  const attempts = ids.map(id => run.retouch?.items.find(i => i.currentId === id || i.originalId === id)?.attempts.length ?? 0);
  const count = attempts.reduce((sum, n) => sum + MAX_RETOUCH_ATTEMPTS - n, 0);
  const price = retouchPrice(1 + uploads.length, run);
  return { rev: run.rev, usd: Number((count * price.usd).toFixed(6)), perEditUsd: price.usd, count, checks: ids.length + count, referenceCount: uploads.length };
}
export function validateRetouchAudit(data: RetouchAudit, id: string, identities: number, identityRequired: boolean): RetouchAudit {
  validateLogicResult(data.result);
  const result = validateReview({ summary: 'Проверка деталей', results: [data.result] }, [id], identities, identityRequired).results[0]!;
  for (const fix of data.fixes) {
    const b = fix.box;
    if (b.x2 <= b.x1 || b.y2 <= b.y1 || (b.x2 - b.x1) * (b.y2 - b.y1) > 300_000) throw new Error('Область правки слишком велика или некорректна.');
    if (result.checks[fix.check] !== 'fail') throw new Error('Правка должна соответствовать обнаруженному дефекту.');
    if (/[<>]|\bhttps?:|\bImage\s*\d|\bignore\b/i.test(fix.instructionEn)) throw new Error('Инструкция не должна менять ссылки или границы правки.');
  }
  const regions = [...new Map(data.fixes.map(f => [JSON.stringify(f.box), f.box])).values()];
  if (regions.reduce((sum, b) => sum + (b.x2 - b.x1) * (b.y2 - b.y1), 0) > 600_000) throw new Error('Правка охватывает слишком большую часть кадра.');
  return { ...data, result: GeneratedReviewResultSchema.parse(result) };
}
export const auditPassed = (audit: RetouchAudit) => logicReviewPassed(audit.result) && audit.preserved === 'pass' && audit.fixes.length === 0;
export function repairable(audit: RetouchAudit): boolean {
  const failures = Object.entries(audit.result.checks).filter(([, value]) => value === 'fail').map(([key]) => key);
  return audit.preserved === 'pass' && audit.fixes.length > 0 && failures.length > 0
    && !Object.values(audit.result.checks).includes('uncertain')
    && failures.every(key => audit.fixes.some(f => f.check === key));
}
export function retouchPrompt(audit: RetouchAudit): string {
  const edits = audit.fixes.map(f => buildRegionPrompt([f.box], f.instructionEn)).join('\n');
  // Each instruction has its own box; never apply a combined face instruction to every region.
  return `${edits}\nPreserve the main subject's identity, action, framing, clothing, scene and all readable text outside the marked areas. Identity references, when supplied after Image 1, describe ONLY the main subject; other people and printed portraits must retain distinct unrelated appearances.`;
}
