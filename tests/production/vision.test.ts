import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { imageSize } from '../../src/server/gen/imageSize.ts';
import { runFfmpeg } from '../../src/server/gen/ffmpeg.ts';
import { inspectionViews } from '../../src/server/production/vision.ts';

it.each([[200, 300], [2000, 3000]])('creates original-pixel overlapping views bounded at 1568 without enlarging %ix%i', async (width, height) => {
  const colors = [[240, 20, 20], [20, 240, 20], [20, 20, 240], [240, 240, 20]];
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)]!;
    pixels.set(color, (y * width + x) * 3);
  }
  const views = await inspectionViews(Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
  expect(views).toHaveLength(5);
  const dir = await mkdtemp(path.join(tmpdir(), 'vision-proof-'));
  try {
    for (let i = 0; i < views.length; i++) {
      const bytes = Buffer.from(views[i]!.base64, 'base64'); const size = imageSize(bytes)!;
      expect(size.width).toBeLessThanOrEqual(Math.min(1568, width * (i ? .6 : 1)));
      expect(size.height).toBeLessThanOrEqual(Math.min(1568, height * (i ? .6 : 1)));
      expect(size.width / size.height).toBeCloseTo(width / height, 2);
      if (!i) continue;
      await writeFile(path.join(dir, 'view.jpg'), bytes);
      await runFfmpeg(['-i', path.join(dir, 'view.jpg'), '-vf', 'format=rgb24,crop=1:1:iw/2:ih/2', '-frames:v', '1', '-f', 'rawvideo', path.join(dir, 'center.rgb')]);
      const center = await readFile(path.join(dir, 'center.rgb'));
      for (let c = 0; c < 3; c++) expect(Math.abs(center[c]! - colors[i - 1]![c]!)).toBeLessThan(12);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
