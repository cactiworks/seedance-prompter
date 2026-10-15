import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../gen/ffmpeg.ts';
import type { ImageInput } from '../llm/codexCli/args.ts';

/** Local, bounded vision copies; no URLs, secret values or external uploads. */
export async function visionCopy(bytes: Uint8Array): Promise<ImageInput> {
  const dir = await mkdtemp(path.join(tmpdir(), 'production-review-image-'));
  try {
    const input = path.join(dir, 'input'); const output = path.join(dir, 'vision.jpg');
    await writeFile(input, bytes, { mode: 0o600 });
    await runFfmpeg(['-i', input, '-vf', "scale=w='min(1568,iw)':h='min(1568,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', '-q:v', '2', output]);
    return { mediaType: 'image/jpeg', base64: (await readFile(output)).toString('base64') };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
