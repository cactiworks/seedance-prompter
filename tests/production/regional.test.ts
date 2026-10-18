import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createGenRuntime } from '../../src/server/gen/runtime.ts';
import { imageSize } from '../../src/server/gen/imageSize.ts';
import { runFfmpeg } from '../../src/server/gen/ffmpeg.ts';
import { retainOutsideRegions } from '../../src/server/production/regional.ts';

it.each([[100, 100, 1], [160, 90, 2]])('preserves %ix%i source dimensions and outside pixels after a %ix repair', async (width, height, scale) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'regional-pixels-'));
  const gen = createGenRuntime({ dataDir: dir, providers: {} });
  try {
    const meta = { kind: 'image' as const, jobId: 'fixture', taskId: null, provider: 'fixture', modelId: 'fixture', providerModel: 'fixture', prompt: '', params: {}, refs: [], origin: null, sessionId: null, index: 0, sourceUrl: 'local:fixture', creditsConsumed: null, createdAt: new Date(0).toISOString() };
    const images = [];
    for (const color of ['red', 'blue']) {
      const file = path.join(dir, `${color}.png`);
      await runFfmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${width * (color === 'blue' ? scale : 1)}x${height * (color === 'blue' ? scale : 1)}`, '-frames:v', '1', file]);
      images.push(await gen.library.importFile(file, 'png', meta));
    }
    const result = await retainOutsideRegions(gen, images[0]!, images[1]!, [{ x1: 200, y1: 300, x2: 400, y2: 500 }]);
    expect(imageSize(await gen.library.readBytes(result))).toEqual({ width, height });
    const decoded = [];
    for (const [i, item] of [images[0]!, images[1]!, result].entries()) {
      const file = path.join(dir, `decoded-${i}.rgb`);
      await runFfmpeg(['-i', gen.library.pathOf(item), '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', file]);
      decoded.push(await readFile(file));
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const expected = x >= Math.floor(width * 0.2) && x < Math.ceil(width * 0.4) && y >= Math.floor(height * 0.3) && y < Math.ceil(height * 0.5) ? decoded[1]! : decoded[0]!;
      expect(decoded[2]!.subarray(offset, offset + 3)).toEqual(expected.subarray(offset, offset + 3));
    }
  } finally { gen.stop(); await rm(dir, { recursive: true, force: true }); }
});
