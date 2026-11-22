import { z } from 'zod';
import { FlowSchema } from '../../core/model/canvas.ts';
import { CanvasAiRunSchema, type CanvasAiRun } from '../../core/model/canvasAi.ts';
export { CanvasAiRunSchema, CanvasAiSnapshotSchema, CanvasAiCallSchema } from '../../core/model/canvasAi.ts';
export type { CanvasAiRun, CanvasAiSnapshot } from '../../core/model/canvasAi.ts';

export const StoredCanvasAiRunSchema = CanvasAiRunSchema.extend({
  codexAccountId: z.string().optional(), flowSnapshot: FlowSchema,
  llmInput: z.object({ system: z.string(), user: z.string(), model: z.string(), effort: z.enum(['low', 'medium', 'high']).optional() }).optional(),
});
export type StoredCanvasAiRun = z.infer<typeof StoredCanvasAiRunSchema>;
export const publicRun = (stored: StoredCanvasAiRun): CanvasAiRun => CanvasAiRunSchema.parse(stored);

export class CanvasAiError extends Error {
  readonly status: 404 | 409 | 422;
  readonly code: string;
  constructor(code: string, messageRu: string, status: 404 | 409 | 422 = 422) { super(messageRu); this.code = code; this.status = status; }
}
