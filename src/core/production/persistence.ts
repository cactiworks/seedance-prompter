import { z } from 'zod';
import { RetouchStateSchema } from './retouch.ts';
import { CreateRunSchema, STEP_ORDER } from './model.ts';
import { PromptPlanSchema, SceneDraftSchema } from './plan.ts';
import { PhotoStateSchema } from './photos.ts';
import { ReviewStateSchema } from './review.ts';
import { AppearanceStateSchema } from './appearance.ts';

const nullableText = z.string().nullable();
/** Validate persisted records before the scheduler or UI touches nested data. */
export const StoredRunSchema = CreateRunSchema.extend({
  retouch: RetouchStateSchema.optional(),
  photos: PhotoStateSchema.optional(), review: ReviewStateSchema.optional(), masterReview: ReviewStateSchema.optional(), appearance: AppearanceStateSchema.optional(), planSourceId: z.string().optional(),
  id: z.string(), rev: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
  paused: z.boolean(), planned: z.boolean(), dueAt: z.number(),
  shots: z.array(z.object({
    id: z.string(), title: z.string(), framing: z.string(), action: z.string(), step: z.enum(STEP_ORDER),
    photoId: nullableText, videoId: nullableText, finalId: nullableText,
    acceptedPhotoId: nullableText, acceptedVideoId: nullableText,
    dueAt: z.number(), error: nullableText, editNote: z.string(), editSourceId: nullableText,
  })),
  artifacts: z.array(z.object({
    id: z.string(), shotId: z.string(), kind: z.enum(['photo', 'video', 'final']), version: z.number(), sourceId: nullableText,
    url: z.string(), poster: z.string(), prompt: z.string(), model: z.string(), taskId: z.string(), createdAt: z.string(),
    qc: z.enum(['pending', 'pass', 'repair', 'review']), qcNote: z.string(), note: z.string(), cost: z.number().nonnegative(),
    mediaId: z.string().optional(), generationJobId: z.string().optional(), providerModel: z.string().optional(),
  })),
  approvals: z.array(z.object({ kind: z.enum(['photo', 'video']), artifactId: z.string(), at: z.string() })),
  events: z.array(z.object({ at: z.string(), message: z.string() })),
  scenePlan: SceneDraftSchema.extend({ shots: z.array(SceneDraftSchema.shape.shots.element.extend({ id: z.string() })).min(1).max(8) }).optional(),
  promptPlan: PromptPlanSchema.optional(),
  preparation: z.object({
    status: z.enum(['running', 'failed', 'interrupted', 'complete']), stage: z.enum(['scene', 'prompts']),
    attempt: z.number().int(), startedAt: z.string(), error: nullableText,
    calls: z.array(z.object({ stage: z.enum(['scene', 'prompts']), at: z.string(), status: z.enum(['accepted', 'rejected', 'failed']), model: nullableText, durationMs: z.number(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), message: nullableText })),
  }).optional(),
}).passthrough();
