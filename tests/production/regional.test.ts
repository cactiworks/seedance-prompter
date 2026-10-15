import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createGenRuntime } from '../../src/server/gen/runtime.ts';
import { runFfmpeg } from '../../src/server/gen/ffmpeg.ts';
import { retainOutsideRegions } from '../../src/server/production/regional.ts';

it('keeps every pixel outside the selected region even if Seedream changes the entire image', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'regional-pixels-'));
  const gen = createGenRuntime({ dataDir: dir, providers: {} });
  try {
    const meta = { kind: 'image' as const, jobId: 'fixture', taskId: null, provider: 'fixture', modelId: 'fixture', providerModel: 'fixture', prompt: '', params: {}, refs: [], origin: null, sessionId: null, index: 0, sourceUrl: 'local:fixture', creditsConsumed: null, createdAt: new Date(0).toISOString() };
    const images = [];
    for (const color of ['red', 'blue']) {
      const file = path.join(dir, `${color}.png`);
      await runFfmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=100x100`, '-frames:v', '1', file]);
      images.push(await gen.library.importFile(file, 'png', meta));
    }
    const result = await retainOutsideRegions(gen, images[0]!, images[1]!, [{ x1: 200, y1: 300, x2: 400, y2: 500 }]);
    const decoded = [];
    for (const [i, item] of [images[0]!, images[1]!, result].entries()) {
      const file = path.join(dir, `decoded-${i}.rgb`);
      await runFfmpeg(['-i', gen.library.pathOf(item), '-f', 'rawvideo', '-pix_fmt', 'rgb24', file]);
      decoded.push(await readFile(file));
    }
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const offset = (y * 100 + x) * 3;
      const expected = x >= 20 && x < 40 && y >= 30 && y < 50 ? decoded[1]! : decoded[0]!;
      expect(decoded[2]!.subarray(offset, offset + 3)).toEqual(expected.subarray(offset, offset + 3));
    }
  } finally { gen.stop(); await rm(dir, { recursive: true, force: true }); }
});
