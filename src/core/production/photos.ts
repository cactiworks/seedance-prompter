import { z } from 'zod';
import { estimate, findModel, paramsFor } from '../gen/models.ts';
import { JOB_STATUSES } from '../model/media.ts';
import type { ProductionRun } from './model.ts';
import { masterApproved, pendingReview, ReviewStateSchema } from './review.ts';

export const PHOTO_MODEL = 'higgsfield/soul-2';
export const PHOTO_PARAMS = { resolution: '1080p', aspectRatio: '9:16', enhancePrompt: false };
export const MAX_MASTER_ATTEMPTS = 3;
export const PhotoStartSchema = z.object({
  rev: z.number().int().nonnegative(), requestId: z.uuid(), confirmUsd: z.number().nonnegative(), refsConsent: z.literal(true), reviewConsent: z.literal(true), masterGateConsent: z.literal(true),
  masterRetryConsent: z.literal(true).optional(), retryMaster: z.literal(true).optional(),
}).strict();
export type PhotoStart = z.infer<typeof PhotoStartSchema>;
const PhotoItemSchema = z.object({
  key: z.string(), tag: z.string(), jobId: z.string().nullable(), taskId: z.string().nullable(),
  status: z.enum(['pending', ...JOB_STATUSES]), mediaId: z.string().nullable(), error: z.string().nullable(), errorCode: z.string().nullable(),
});
export const PhotoStateSchema = z.object({
  status: z.enum(['running', 'stopped', 'review', 'complete']),
  identityId: z.string().nullable(), masterArtifactId: z.string().nullable(),
  requests: z.array(z.object({ id: z.uuid(), usd: z.number(), at: z.string() })),
  items: z.array(PhotoItemSchema),
  masterHistory: z.array(z.object({ item: PhotoItemSchema, artifactId: z.string(), review: ReviewStateSchema })).max(2).optional(),
  budget: z.object({ remainingUsd: z.number().nonnegative(), perImageUsd: z.number().nonnegative(), masterLimit: z.union([z.literal(1), z.literal(3)]) }).optional(),
});
export type PhotoState = z.infer<typeof PhotoStateSchema>;
export const masterAttempts = (run: ProductionRun) => (run.photos?.masterHistory?.length ?? 0) + Number(!!run.photos?.items.some(i => i.key === 'scene' && i.status !== 'pending'));
export const masterRejected = (run: ProductionRun) => run.masterReview?.status === 'complete' && !masterApproved(run);
export function canRegenerateMaster(run: ProductionRun): boolean {
  return masterRejected(run) && masterAttempts(run) < MAX_MASTER_ATTEMPTS && !!run.photos?.masterArtifactId
    && run.photos.items.some(i => i.key === 'scene' && i.status === 'saved' && i.mediaId)
    && run.photos.items.every(i => i.key === 'scene' || i.status === 'pending');
}
/** Called only inside the store lock after checking explicit or still-active budget consent. */
export function replaceRejectedMaster(run: ProductionRun, requestId: string, now: number): void {
  if (!canRegenerateMaster(run)) throw new Error('Повтор master сейчас недоступен.');
  const state = run.photos!;
  const index = state.items.findIndex(i => i.key === 'scene');
  (state.masterHistory ??= []).push({ item: { ...state.items[index]! }, artifactId: state.masterArtifactId!, review: structuredClone(run.masterReview!) });
  state.items[index] = { key: 'scene', tag: `production:${run.id}:${requestId}:scene`, jobId: null, taskId: null, status: 'pending', mediaId: null, error: null, errorCode: null };
  state.masterArtifactId = null;
  // Automatic retries inherit the accepted inspection scope; a new explicit start upgrades it.
  run.masterReview = { ...pendingReview(requestId, now), criteriaVersion: run.masterReview!.criteriaVersion, referenceLimit: run.masterReview!.referenceLimit };
}
export interface PhotoQuote { rev: number; count: number; sceneCount: number; reserveCount: number; shotCount: number; usd: number; baseUsd: number; perImageUsd: number; characterName: string | null }
/** Upper estimate for the remaining work plus optional master attempts; unused reserve is not submitted. */
export function quotePhotos(run: ProductionRun, options: { retries?: boolean; retryMaster?: boolean } = {}): PhotoQuote {
  const items = run.photos?.items.filter((i) => i.status === 'pending');
  const sceneCount = options.retryMaster ? 1 : items ? Number(items.some((i) => i.key === 'scene')) : 1;
  const shotCount = items ? items.filter(i => i.key !== 'scene').length : run.shots.length;
  const reserveCount = options.retries && !masterApproved(run) && (!run.photos || run.photos.items.every(i => i.key === 'scene' || i.status === 'pending'))
    ? Math.max(0, MAX_MASTER_ATTEMPTS - masterAttempts(run) - sceneCount) : 0;
  const model = findModel(PHOTO_MODEL)!;
  const perImageUsd = estimate(model, paramsFor(model, PHOTO_PARAMS), 1, 0).usd;
  const count = sceneCount + shotCount + reserveCount;
  return { rev: run.rev, count, sceneCount, reserveCount, shotCount, perImageUsd,
    usd: Number((count * perImageUsd).toFixed(6)), baseUsd: Number(((sceneCount + shotCount) * perImageUsd).toFixed(6)), characterName: run.character?.name ?? null };
}
export const photoPrice = (usd: number): string => `$${usd.toFixed(3)}`;
