import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Box } from '../../core/gen/regionEdit.ts';
import type { MediaItem } from '../../core/model/media.ts';
import type { GenRuntime } from '../gen/runtime.ts';
import { imageSize } from '../gen/imageSize.ts';
import { runFfmpeg } from '../gen/ffmpeg.ts';

/** A provider may change the whole image. Only pixels inside approved boxes enter the new version. */
export async function retainOutsideRegions(gen: GenRuntime, source: MediaItem, edited: MediaItem, boxes: Box[]): Promise<MediaItem> {
  const size = imageSize(await gen.library.readBytes(source));
  const next = imageSize(await gen.library.readBytes(edited));
  if (!size || !next || Math.abs(size.width / size.height - next.width / next.height) > 0.02) throw new Error('Пропорции правки изменились.');
  const dir = await mkdtemp(path.join(tmpdir(), 'production-regional-'));
  try {
    const output = path.join(dir, 'result.png');
    const filters = [`[0:v]format=rgba[base0]`, `[1:v]scale=${size.width}:${size.height},format=rgba,split=${boxes.length}${boxes.map((_, i) => `[edit${i}]`).join('')}`];
    boxes.forEach((box, i) => {
      const x = Math.floor(box.x1 * size.width / 1000), y = Math.floor(box.y1 * size.height / 1000);
      const w = Math.max(1, Math.ceil(box.x2 * size.width / 1000) - x), h = Math.max(1, Math.ceil(box.y2 * size.height / 1000) - y);
      filters.push(`[edit${i}]crop=${w}:${h}:${x}:${y}[patch${i}]`, `[base${i}][patch${i}]overlay=${x}:${y}:format=rgb[base${i + 1}]`);
    });
    await runFfmpeg(['-i', gen.library.pathOf(source), '-i', gen.library.pathOf(edited), '-filter_complex', filters.join(';'), '-map', `[base${boxes.length}]`, '-frames:v', '1', '-threads', '1', output]);
    return await gen.library.importFile(output, 'png', { ...edited, provider: 'local', sourceUrl: `local:regional:${source.id}:${edited.id}`, creditsConsumed: null });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
