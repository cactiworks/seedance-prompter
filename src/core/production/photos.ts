import { z } from 'zod';
import { estimate, findModel, paramsFor } from '../gen/models.ts';
import { JOB_STATUSES } from '../model/media.ts';
import type { ProductionRun } from './model.ts';

export const PHOTO_MODEL = 'higgsfield/soul-2';
export const PHOTO_PARAMS = { resolution: '1080p', aspectRatio: '9:16', enhancePrompt: false };
export const PhotoStartSchema = z.object({
  rev: z.number().int().nonnegative(), requestId: z.uuid(), confirmUsd: z.number().nonnegative(), refsConsent: z.literal(true), reviewConsent: z.literal(true), masterGateConsent: z.literal(true),
}).strict();
export type PhotoStart = z.infer<typeof PhotoStartSchema>;
export const PhotoStateSchema = z.object({
  status: z.enum(['running', 'stopped', 'review', 'complete']),
  identityId: z.string().nullable(), masterArtifactId: z.string().nullable(),
  requests: z.array(z.object({ id: z.uuid(), usd: z.number(), at: z.string() })),
  items: z.array(z.object({
    key: z.string(), tag: z.string(), jobId: z.string().nullable(), taskId: z.string().nullable(),
    status: z.enum(['pending', ...JOB_STATUSES]), mediaId: z.string().nullable(), error: z.string().nullable(), errorCode: z.string().nullable(),
  })),
});
export type PhotoState = z.infer<typeof PhotoStateSchema>;
export interface PhotoQuote { rev: number; count: number; sceneCount: number; shotCount: number; usd: number; perImageUsd: number; characterName: string | null }
/** Same catalogue estimate as the generation cost gate, never a claimed provider debit. */
export function quotePhotos(run: ProductionRun): PhotoQuote {
  const items = run.photos?.items.filter((i) => i.status === 'pending');
  const sceneCount = items ? Number(items.some((i) => i.key === 'scene')) : 1;
  const shotCount = items ? items.length - sceneCount : run.shots.length;
  const model = findModel(PHOTO_MODEL)!;
  const perImageUsd = estimate(model, paramsFor(model, PHOTO_PARAMS), 1, 0).usd;
  return { rev: run.rev, count: sceneCount + shotCount, sceneCount, shotCount, perImageUsd,
    usd: Number(((sceneCount + shotCount) * perImageUsd).toFixed(6)), characterName: run.character?.name ?? null };
}
export const photoPrice = (usd: number): string => `$${usd.toFixed(3)}`;
