import { studioFetch } from '../remoteFetch.ts';
import type { CanvasAiRun, CanvasAiPreview } from '../../core/model/canvasAi.ts';
import { FlowSchema, type Flow } from '../../core/model/canvas.ts';

export interface CanvasAiResponse { run: CanvasAiRun; flow: Flow }

export class CanvasAiApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Read-only polling and explicitly clicked mutations share the current browser's AI account. */
export async function canvasAiApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await studioFetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'x-sp-client': '1', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { messageRu?: string; errorRu?: string; error?: string };
    throw new CanvasAiApiError(error.error ?? `HTTP_${response.status}`, error.messageRu ?? error.errorRu ?? error.error ?? `HTTP ${response.status}`);
  }
  return await response.json() as T;
}

export async function currentCanvasFlow(id: string): Promise<Flow> {
  return FlowSchema.parse(await canvasAiApi<unknown>(`/api/canvas/flows/${encodeURIComponent(id)}`));
}

export const canvasAiRuns = (flowId: string, nodeId: string): Promise<CanvasAiRun[]> =>
  canvasAiApi(`/api/canvas-ai/runs?flowId=${encodeURIComponent(flowId)}&nodeId=${encodeURIComponent(nodeId)}`);

export const canvasAiPreview = (flowId: string, nodeId: string): Promise<CanvasAiPreview> =>
  canvasAiApi(`/api/canvas-ai/preview?flowId=${encodeURIComponent(flowId)}&nodeId=${encodeURIComponent(nodeId)}`);
