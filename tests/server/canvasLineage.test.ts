import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGenRuntime, SubmitRequestSchema } from '../../src/server/gen/runtime.ts';
import type { GenProvider } from '../../src/server/gen/provider.ts';

describe('Canvas generation lineage', () => {
  it('keeps the approved AI version on the job and the downloaded media after restart', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'sp-canvas-lineage-'));
    let now = Date.parse('2026-11-17T10:00:00Z');
    const provider: GenProvider = {
      id: 'higgsfield', hasKey: () => true,
      upload: async () => 'https://example.test/upload',
      submit: async () => 'task-1',
      poll: async () => ({ state: 'success', providerState: 'done', urls: ['https://example.test/result.png'], creditsConsumed: 0.006, failMsg: null }),
      freshUrl: async () => null,
    };
    const image = await readFile(path.join(import.meta.dirname, '../../src/web/public/production-mock/shot-1.png'));
    const fetchImage = (async () => new Response(image, { headers: { 'content-type': 'image/png' } })) as typeof fetch;
    const options = { dataDir, providers: { higgsfield: provider }, now: () => now, fetch: fetchImage };
    try {
      const runtime = createGenRuntime(options);
      const canvas = { flowId: 'f-example', nodeId: 'n-photo', aiNodeId: 'n-ai', ideaVersionId: 'idea-1', promptVersionId: 'prompt-2', inputFingerprint: 'immutable-inputs' };
      const submitted = await runtime.submit({ modelId: 'higgsfield/soul-2', prompt: 'A ceramic vase in soft daylight.', params: { resolution: '1080p' }, confirmCredits: 0.006, canvas });
      const job = submitted.jobs[0]!;
      expect(job.canvas).toEqual(canvas);
      now += 60_000;
      await runtime.tick();
      const restarted = createGenRuntime(options);
      const saved = await restarted.jobs.get(job.id);
      expect(saved?.status).toBe('saved');
      expect(saved?.canvas).toEqual(canvas);
      const media = await restarted.library.get(saved!.mediaIds[0]!);
      expect(media?.canvas).toEqual(canvas);
      expect(media?.prompt).toBe(job.prompt);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('accepts legacy requests and rejects an empty Canvas binding', () => {
    expect(SubmitRequestSchema.safeParse({ modelId: 'higgsfield/soul-2', prompt: 'A vase.' }).success).toBe(true);
    expect(SubmitRequestSchema.safeParse({ modelId: 'higgsfield/soul-2', prompt: 'A vase.', canvas: { flowId: '', nodeId: 'n-photo' } }).success).toBe(false);
  });
});
