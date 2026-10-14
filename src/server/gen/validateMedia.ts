import { readFile } from 'node:fs/promises';
import { imageSize } from './imageSize.ts';
import { probeVideo, runFfmpeg } from './ffmpeg.ts';

/** Check decodability before publishing an imported/processed file in the library. */
export async function validateMediaFile(file: string, kind: 'image' | 'video'): Promise<void> {
  if (kind === 'video') await probeVideo(file);
  else { const size = imageSize(await readFile(file)); if (size === null || size.width < 1 || size.height < 1) throw new Error('Не удалось прочитать изображение.'); }
  await runFfmpeg(['-xerror', '-err_detect', 'explode', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-']);
}
