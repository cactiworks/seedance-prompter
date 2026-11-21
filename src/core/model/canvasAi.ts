import { z } from 'zod';
import { CanvasAiVersionSchema } from './canvas.ts';
import { GenParamsSchema, JobRefSchema } from './media.ts';
import { MAX_REFERENCE_SELECTIONS, ReferenceSelectionSchema } from '../references.ts';

export const CanvasAiSnapshotSchema = z.object({
  taskRu: z.string(), contexts: z.array(z.object({ nodeId: z.string(), text: z.string() })),
  refs: z.array(JobRefSchema), generationRefs: z.array(JobRefSchema),
  target: z.object({ id: z.string(), kind: z.enum(['image', 'video']), modelId: z.string(), params: GenParamsSchema }),
  identity: z.object({ characterId: z.string(), name: z.string(), referenceId: z.string(), uploadIds: z.array(z.string()).max(6) }).nullable(),
  attachments: z.array(z.object({ file: z.string(), mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']), sha256: z.string(), role: z.enum(['context', 'generation', 'identity', 'library']), label: z.string() })),
  approvedIdeaVersionId: z.string().nullable(), modelCardHash: z.string(), contextDigest: z.string(),
  libraryRefs: z.array(z.object({
    selection: ReferenceSelectionSchema, sourceName: z.string(), timeMs: z.number().nullable(), visible: z.string(), technique: z.string(), transfer: z.string(), imageSha256: z.string(),
  })).max(MAX_REFERENCE_SELECTIONS).optional(),
});
export const CanvasAiCallSchema = z.object({
  stage: z.enum(['idea', 'prompt']), status: z.enum(['running', 'complete', 'failed', 'cancelled', 'interrupted']),
  startedAt: z.string(), finishedAt: z.string().nullable(), errorRu: z.string().nullable(),
  meta: z.object({ durationMs: z.number(), model: z.string().nullable(), turns: z.number().nullable(), inputTokens: z.number(), outputTokens: z.number() }).nullable(),
});
export const CanvasAiRunSchema = z.object({
  id: z.string(), flowId: z.string(), nodeId: z.string(), requestId: z.uuid(), requestDigest: z.string(),
  stage: z.enum(['idea', 'prompt']), status: z.enum(['running', 'ready', 'approved', 'failed', 'cancelled', 'interrupted']),
  revision: z.number().int().positive(), inputFingerprint: z.string(), feedbackRu: z.string(),
  summaryRu: z.string().default(''), assumptionsRu: z.array(z.string()).default([]), referenceNotesRu: z.array(z.string()).default([]),
  version: CanvasAiVersionSchema.nullable(), versions: z.array(CanvasAiVersionSchema).default([]), parentRunId: z.string().nullable(),
  supersedesRunId: z.string().nullable().default(null),
  snapshot: CanvasAiSnapshotSchema, calls: z.array(CanvasAiCallSchema), errorRu: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type CanvasAiRun = z.infer<typeof CanvasAiRunSchema>;
export type CanvasAiSnapshot = z.infer<typeof CanvasAiSnapshotSchema>;

/** The exact saved inputs shown before an AI call, with no account or inference. */
export const CanvasAiPreviewSchema = z.object({
  flowId: z.string(), flowRev: z.number().int().nonnegative(), inputFingerprint: z.string(),
  snapshot: CanvasAiSnapshotSchema, warningsRu: z.array(z.string()),
});
export type CanvasAiPreview = z.infer<typeof CanvasAiPreviewSchema>;
