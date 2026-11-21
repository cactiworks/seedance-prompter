import { createHash } from 'node:crypto';
import { open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { probeVideo, runFfmpeg } from '../gen/ffmpeg.ts';
import { imageSize } from '../gen/imageSize.ts';

const MAX_BYTES = 150 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 180;
const MAX_SOURCE_PIXELS = 40_000_000;
const MAX_FRAMES = 8;
const SAMPLE_FPS = 4;
const SAMPLE_SIDE = 32;
const SAMPLE_BYTES = SAMPLE_SIDE * SAMPLE_SIDE * 3;
const BOUNDED_JPEG = "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease";

const formats = {
  '.jpg': 'jpeg_pipe', '.jpeg': 'jpeg_pipe', '.png': 'png_pipe', '.webp': 'webp_pipe',
  '.mp4': 'mov', '.mov': 'mov', '.webm': 'matroska',
} as const;
const extensionsByMime: Record<string, keyof typeof formats> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
};
type MediaFormat = typeof formats[keyof typeof formats];

export class ReferenceLibraryError extends Error {
  readonly status: 409 | 413 | 415 | 422 | 503;
  readonly messageRu: string;
  constructor(status: ReferenceLibraryError['status'], messageRu: string) {
    super(messageRu);
    this.status = status;
    this.messageRu = messageRu;
  }
}

export function referenceInput(name: string, mime: string | undefined) {
  const cleanName = name.replaceAll('\\', '/').split('/').at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '').trim() ?? '';
  const extension = path.extname(cleanName).toLowerCase();
  const claimed = Object.hasOwn(formats, extension)
    ? extension as keyof typeof formats
    : extensionsByMime[mime?.split(';')[0]?.trim().toLowerCase() ?? ''];
  const format = claimed && formats[claimed];
  if (!format) throw new ReferenceLibraryError(415, 'Подходят JPG, PNG, WebP, MP4, MOV и WebM.');
  return { name: cleanName.slice(0, 160) || `Референс${claimed}`, format };
}

export async function writeReferenceInput(file: string, body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) throw new ReferenceLibraryError(422, 'Файл пуст.');
  const handle = await open(file, 'wx', 0o600);
  const reader = body.getReader();
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_BYTES) throw new ReferenceLibraryError(413, 'Файл больше 150 МБ.');
      hash.update(result.value);
      await handle.writeFile(result.value);
    }
    if (!bytes) throw new ReferenceLibraryError(422, 'Файл пуст.');
    return hash.digest('hex');
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    await handle.close();
  }
}

interface Sample {
  time: number;
  pixels: Uint8Array;
}

function difference(left: Uint8Array, right: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < SAMPLE_BYTES; i++) total += Math.abs(left[i]! - right[i]!);
  return total / (SAMPLE_BYTES * 255);
}

function usable(sample: Sample): boolean {
  const average = sample.pixels.reduce((sum, value) => sum + value, 0) / SAMPLE_BYTES;
  return average > 8 && average < 247;
}

function selectTimes(samples: Sample[], cuts: number[], duration: number): number[] {
  const visible = samples.filter(usable);
  if (!samples.length) return [duration / 2];
  if (!visible.length) throw new ReferenceLibraryError(422, 'В ролике нет кадров с различимым изображением.');
  const boundaries = [0, ...cuts.filter((time, index) => time > 0 && time < duration && time > (cuts[index - 1] ?? -1)), duration];
  const representatives = boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1]!;
    const middle = (start + end) / 2;
    const within = visible.filter(sample => sample.time >= start && sample.time < end);
    const closest = within.reduce<Sample | undefined>((best, sample) =>
      !best || Math.abs(sample.time - middle) < Math.abs(best.time - middle) ? sample : best, undefined);
    return closest ? [closest] : [];
  });
  const poolSize = Math.min(representatives.length, MAX_FRAMES * 4);
  const review = representatives.length > poolSize
    ? Array.from({ length: poolSize }, (_, i) => representatives[Math.round(i * (representatives.length - 1) / (poolSize - 1))]!)
    : representatives;
  const distinct: Sample[] = [];
  for (const sample of review) {
    if (distinct.every(prior => difference(prior.pixels, sample.pixels) > 0.035)) distinct.push(sample);
  }
  const picked = distinct.length > MAX_FRAMES
    ? Array.from({ length: MAX_FRAMES }, (_, i) => distinct[Math.round(i * (distinct.length - 1) / (MAX_FRAMES - 1))]!)
    : distinct;
  if (!picked.length) picked.push(visible[Math.floor(visible.length / 2)]!);

  // Add a changed pose, action or composition within a shot if a scene cut did not cover it.
  while (picked.length < MAX_FRAMES) {
    let candidate: Sample | undefined;
    let best = 0.115;
    for (const sample of visible) {
      if (picked.some(prior => Math.abs(prior.time - sample.time) < 0.6)) continue;
      const score = Math.min(...picked.map(prior => difference(prior.pixels, sample.pixels)));
      if (score > best) {
        best = score;
        candidate = sample;
      }
    }
    if (!candidate) break;
    picked.push(candidate);
  }
  return picked.map(sample => sample.time).sort((a, b) => a - b);
}

const videoInputs = (source: string, format: MediaFormat) => [
  '-nostdin', '-protocol_whitelist', 'file', '-threads', '2', '-xerror', '-err_detect', 'explode', '-f', format, '-i', source,
];

async function extractVideo(input: string[], directory: string, duration: number) {
  const cutFile = path.join(directory, 'cuts.txt');
  const rawFile = path.join(directory, 'samples.rgb');
  const filter = `[0:v:0]setpts=PTS-STARTPTS,scale=${SAMPLE_SIDE}:${SAMPLE_SIDE},split=2[a][b];[a]scdet=threshold=10:sc_pass=1[cuts];[b]fps=${SAMPLE_FPS},format=rgb24[samples]`;
  await runFfmpeg([
    ...input, '-filter_complex_threads', '2', '-filter_complex', filter,
    '-map', '[cuts]', '-fps_mode', 'passthrough', '-enc_time_base', '1:1000', '-f', 'framecrc', cutFile,
    '-map', '[samples]', '-frames:v', String(MAX_VIDEO_SECONDS * SAMPLE_FPS + 1), '-c:v', 'rawvideo', '-threads', '1', '-f', 'rawvideo', rawFile,
  ]);
  const [cutLog, raw] = await Promise.all([readFile(cutFile, 'utf8'), readFile(rawFile)]);
  const cuts = cutLog.split('\n').filter(line => /^0,/.test(line)).map(line => Number(line.split(',')[2]) / 1000);
  const samples = Array.from({ length: Math.floor(raw.length / SAMPLE_BYTES) }, (_, index) => ({
    time: Math.min(index / SAMPLE_FPS, duration * 0.99),
    pixels: raw.subarray(index * SAMPLE_BYTES, (index + 1) * SAMPLE_BYTES),
  }));
  const thresholds = selectTimes(samples, cuts, duration).map(time => time.toFixed(6));
  const select = thresholds.map(time => `gte(t,${time})*(isnan(prev_pts)+lt(prev_pts*TB,${time}))`).join('+');
  await runFfmpeg([
    ...input, '-filter_threads', '2', '-map', '0:v:0', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', `setpts=PTS-STARTPTS,select='${select}',${BOUNDED_JPEG}`,
    '-c:v', 'mjpeg', '-threads', '2', '-q:v', '3', '-fps_mode', 'passthrough', '-enc_time_base', '1:1000',
    '-frame_pts', '1', path.join(directory, 'frame-%d.jpg'),
  ]);
  return (await readdir(directory)).flatMap(name => {
    const timestamp = /^frame-(\d+)\.jpg$/.exec(name);
    return timestamp ? [{ file: name, timeMs: Number(timestamp[1]) }] : [];
  }).sort((a, b) => a.timeMs - b.timeMs);
}

function matchesHeader(header: Buffer, format: MediaFormat) {
  const box = header.toString('ascii', 4, 8);
  switch (format) {
    case 'mov': return ['ftyp', 'wide', 'moov', 'mdat', 'free', 'skip'].includes(box);
    case 'matroska': return header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case 'jpeg_pipe': return header[0] === 0xff && header[1] === 0xd8;
    case 'png_pipe': return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'webp_pipe': return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
  }
}

function requireSize(size: { width: number | null; height: number | null } | null) {
  if (!size?.width || !size.height || size.width * size.height > MAX_SOURCE_PIXELS) {
    throw new ReferenceLibraryError(422, 'Источник должен содержать изображение размером до 40 Мп.');
  }
}

export async function extractReferenceFrames(source: string, format: MediaFormat, directory: string): Promise<{ file: string; timeMs: number | null }[]> {
  const file = await open(source, 'r');
  const header = Buffer.alloc(512 * 1024);
  const bytesRead = await file.read(header).then(result => result.bytesRead).finally(() => file.close());
  const scanned = header.subarray(0, bytesRead);
  if (!matchesHeader(scanned, format)) throw new ReferenceLibraryError(422, 'Содержимое файла не соответствует формату.');
  const input = videoInputs(source, format);
  try {
    if (format === 'mov' || format === 'matroska') {
      const info = await probeVideo(source);
      requireSize(info);
      if (info.durationSec > MAX_VIDEO_SECONDS) throw new ReferenceLibraryError(422, 'Видео должно быть не длиннее трёх минут.');
      const frames = await extractVideo(input, directory, info.durationSec);
      if (frames.length) return frames;
      // Very short or unevenly timed videos still get a cover frame.
    } else {
      requireSize(imageSize(scanned));
    }
    const file = 'frame-cover.jpg';
    await runFfmpeg([
      ...input, '-map', '0:v:0', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', BOUNDED_JPEG, '-frames:v', '1', '-c:v', 'mjpeg', '-threads', '2', '-q:v', '3', '-update', '1', path.join(directory, file),
    ]);
    if (!(await readdir(directory)).includes(file)) throw new Error('Empty frame.');
    return [{ file, timeMs: format === 'mov' || format === 'matroska' ? 0 : null }];
  } catch (error) {
    if (error instanceof ReferenceLibraryError) throw error;
    throw new ReferenceLibraryError(422, 'Не удалось прочитать файл и извлечь кадры.');
  }
}
