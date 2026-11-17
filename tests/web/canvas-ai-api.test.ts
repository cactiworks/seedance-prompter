import { afterEach, expect, it, vi } from 'vitest';
import { canvasAiApi, CanvasAiApiError } from '../../src/web/canvas/canvasAiApi.ts';

afterEach(() => vi.unstubAllGlobals());

it('preserves PREVIEW_CHANGED for consent reset and never retries a rejected start', async () => {
  const send = vi.fn(async () => new Response(JSON.stringify({ error: 'PREVIEW_CHANGED', messageRu: 'Набор изображений изменился. Проверь его заново.' }), { status: 409, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', send);
  const error = await canvasAiApi('/api/canvas-ai/runs', { previewDigest: 'previous-preview', consent: true }).catch(e => e);
  expect(error).toBeInstanceOf(CanvasAiApiError);
  if (!(error instanceof CanvasAiApiError)) throw new Error('Expected a typed Canvas AI error.');
  expect(error.code).toBe('PREVIEW_CHANGED');
  expect(error.message).toBe('Набор изображений изменился. Проверь его заново.');
  expect(send).toHaveBeenCalledTimes(1);
});

it('passes the exact reviewed digest in a manually requested retry', async () => {
  const send = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ run: { id: 'new-attempt' } }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', send);
  await canvasAiApi('/api/canvas-ai/runs/old/retry', { previewDigest: 'reviewed-media-digest', consent: true });
  const request = send.mock.calls[0]?.[1];
  expect(JSON.parse(String(request?.body)).previewDigest).toBe('reviewed-media-digest');
  expect(send).toHaveBeenCalledTimes(1);
});
