import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../gen/ffmpeg.ts';
import type { ImageInput } from '../llm/codexCli/args.ts';

/** Overlap keeps eyes, hands and letters at tile boundaries in a neighbouring view. */
export const DETAIL_VIEWS = [
  { view: 'top-left', box: { x: 0, y: 0, w: 0.6, h: 0.6 } },
  { view: 'top-right', box: { x: 0.4, y: 0, w: 0.6, h: 0.6 } },
  { view: 'bottom-left', box: { x: 0, y: 0.4, w: 0.6, h: 0.6 } },
  { view: 'bottom-right', box: { x: 0.4, y: 0.4, w: 0.6, h: 0.6 } },
] as const;
const boundedScale = "scale=w='min(1568,iw)':h='min(1568,ih)':force_original_aspect_ratio=decrease";

/** Same source pixels, no AI enhancement or sharpening. One decode process, five bounded views. */
export async function inspectionViews(bytes: Uint8Array): Promise<ImageInput[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'production-inspection-'));
  try {
    const input = path.join(dir, 'input'); await writeFile(input, bytes, { mode: 0o600 });
    const filters = [boundedScale, ...DETAIL_VIEWS.map(({ box: b }) => `crop=trunc(iw*${b.w}):trunc(ih*${b.h}):trunc(iw*${b.x}):trunc(ih*${b.y}),${boundedScale}`)];
    const outputs = filters.map((_, i) => path.join(dir, `${i}.jpg`));
    await runFfmpeg(['-i', input, ...filters.flatMap((filter, i) => ['-map', '0:v:0', '-vf', filter, '-frames:v', '1', '-q:v', '2', outputs[i]!])]);
    return await Promise.all(outputs.map(async file => ({ mediaType: 'image/jpeg' as const, base64: (await readFile(file)).toString('base64') })));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Local, bounded vision copies; no URLs, secret values or external uploads. */
export async function visionCopy(bytes: Uint8Array): Promise<ImageInput> {
  const dir = await mkdtemp(path.join(tmpdir(), 'production-review-image-'));
  try {
    const input = path.join(dir, 'input'); const output = path.join(dir, 'vision.jpg');
    await writeFile(input, bytes, { mode: 0o600 });
    await runFfmpeg(['-i', input, '-vf', boundedScale, '-frames:v', '1', '-q:v', '2', output]);
    return { mediaType: 'image/jpeg', base64: (await readFile(output)).toString('base64') };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
