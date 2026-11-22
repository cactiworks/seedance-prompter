import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeVideo, runFfmpeg } from '../gen/ffmpeg.ts';
import { imageSize } from '../gen/imageSize.ts';

const MAX_BYTES = 150 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 180;
const MAX_SOURCE_PIXELS = 40_000_000;
const SAMPLE_SIDE = 32;
const SAMPLE_BYTES = SAMPLE_SIDE * SAMPLE_SIDE * 3;
const MAX_SCAN_BYTES = 192 * 1024 * 1024;
const MAX_TIMING_BYTES = 8 * 1024 * 1024;
const CUT_DIFFERENCE = 0.13;
const ACTION_DIFFERENCE = 0.115;
const ACTION_SPACING_US = 600_000;
const DUPLICATE_DIFFERENCE = 0.035;
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

interface ScanFrame {
  index: number;
  timeUs: number;
}

interface Candidate {
  frame: ScanFrame;
  colors: Uint8Array;
  score: number;
}

function difference(left: Uint8Array, right: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < left.length; i++) total += Math.abs(left[i]! - right[i]!);
  return total / (left.length * 255);
}

/** Average color within each 4×4 block keeps duplicates cheap to compare across shots. */
function signature(pixels: Uint8Array): Uint8Array {
  const blockSize = 4;
  const blocksPerRow = SAMPLE_SIDE / blockSize;
  const result = new Uint8Array(blocksPerRow * blocksPerRow * 3);
  for (let block = 0; block < result.length / 3; block++) {
    const start = (Math.floor(block / blocksPerRow) * blockSize * SAMPLE_SIDE + block % blocksPerRow * blockSize) * 3;
    for (let channel = 0; channel < 3; channel++) {
      let sum = 0;
      for (let row = 0; row < blockSize; row++) {
        for (let column = 0; column < blockSize; column++) {
          sum += pixels[start + (row * SAMPLE_SIDE + column) * 3 + channel]!;
        }
      }
      result[block * 3 + channel] = Math.round(sum / (blockSize * blockSize));
    }
  }
  return result;
}

function nearDuplicate(left: Uint8Array, right: Uint8Array): boolean {
  const limit = left.length * 255 * DUPLICATE_DIFFERENCE;
  let total = 0;
  for (let i = 0; i < left.length; i++) {
    total += Math.abs(left[i]! - right[i]!);
    if (total > limit) return false;
  }
  return true;
}

/** Favor frames with defined edges, rejecting black and blown-out fades. */
function quality(pixels: Uint8Array): number | undefined {
  let total = 0;
  let edges = 0;
  const stride = SAMPLE_SIDE * 3;
  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i]!;
    total += value;
    if (i % stride >= 3) edges += Math.abs(value - pixels[i - 3]!);
    if (i >= stride) edges += Math.abs(value - pixels[i - stride]!);
  }
  const average = total / SAMPLE_BYTES;
  return average > 8 && average < 247 ? edges : undefined;
}

async function selectFrames(rawFile: string, timestamps: number[]): Promise<ScanFrame[]> {
  const candidates: Candidate[] = [];
  let best: { indices: number[]; score: number; pixels: Buffer } | undefined;
  let segmentStartUs = 0;
  const previous = Buffer.alloc(SAMPLE_BYTES);
  const file = await open(rawFile);

  async function finishSegment() {
    if (!best) return;
    const index = best.indices[Math.floor(best.indices.length / 2)]!;
    if (index !== best.indices[0]) {
      const { bytesRead } = await file.read(best.pixels, 0, SAMPLE_BYTES, index * SAMPLE_BYTES);
      if (bytesRead !== SAMPLE_BYTES) throw new Error('Incomplete frame scan.');
    }
    candidates.push({ frame: { index, timeUs: timestamps[index]! }, colors: signature(best.pixels), score: best.score });
    best = undefined;
  }

  const batch = Buffer.alloc(SAMPLE_BYTES * 64);
  try {
    let index = 0;
    while (index < timestamps.length) {
      const length = Math.min(batch.length, (timestamps.length - index) * SAMPLE_BYTES);
      const { bytesRead } = await file.read(batch, 0, length, index * SAMPLE_BYTES);
      if (bytesRead !== length) throw new Error('Incomplete frame scan.');
      for (let offset = 0; offset < length; offset += SAMPLE_BYTES, index++) {
        const pixels = batch.subarray(offset, offset + SAMPLE_BYTES);
        const timeUs = timestamps[index]!;
        const cut = index > 0 && difference(previous, pixels) > CUT_DIFFERENCE;
        const action = best && timeUs - segmentStartUs >= ACTION_SPACING_US && difference(best.pixels, pixels) > ACTION_DIFFERENCE;
        if (cut || action) {
          await finishSegment();
          segmentStartUs = timeUs;
        }
        const score = quality(pixels);
        if (score !== undefined) {
          if (!best || score > best.score) best = { indices: [index], score, pixels: Buffer.from(pixels) };
          else if (score === best.score) best.indices.push(index);
        }
        pixels.copy(previous);
      }
    }
    await finishSegment();
  } finally {
    await file.close();
  }
  if (!candidates.length) throw new ReferenceLibraryError(422, 'В ролике нет кадров с различимым изображением.');
  const distinct: Candidate[] = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score || a.frame.index - b.frame.index)) {
    if (!distinct.some(prior => nearDuplicate(prior.colors, candidate.colors))) distinct.push(candidate);
  }
  return distinct.map(item => item.frame).sort((a, b) => a.index - b.index);
}

/** Split the index lookup so the filter needs logarithmic work per decoded frame. */
function indexFilter(frames: ScanFrame[], start = 0, end = frames.length): string {
  if (end - start === 1) return `eq(n,${frames[start]!.index})`;
  const middle = Math.floor((start + end) / 2);
  return `if(lt(n,${frames[middle]!.index}),${indexFilter(frames, start, middle)},${indexFilter(frames, middle, end)})`;
}

const videoInputs = (source: string, format: MediaFormat) => [
  '-nostdin', '-protocol_whitelist', 'file', '-threads', '2', '-xerror', '-err_detect', 'explode', '-f', format, '-i', source,
];

async function extractVideo(input: string[], directory: string) {
  const clockFile = path.join(directory, 'samples.crc');
  const rawFile = path.join(directory, 'samples.rgb');
  const filter = `[0:v:0]setpts=PTS-STARTPTS,scale=${SAMPLE_SIDE}:${SAMPLE_SIDE},format=rgb24,split=2[samples][clock]`;
  await runFfmpeg([
    ...input, '-filter_complex_threads', '2', '-filter_complex', filter,
    '-map', '[samples]', '-fps_mode', 'passthrough', '-c:v', 'rawvideo', '-threads', '1', '-fs', String(MAX_SCAN_BYTES), '-f', 'rawvideo', rawFile,
    '-map', '[clock]', '-fps_mode', 'passthrough', '-enc_time_base', '1:1000000', '-c:v', 'rawvideo', '-threads', '1', '-fs', String(MAX_TIMING_BYTES), '-f', 'framecrc', clockFile,
  ]);
  const [timing, raw] = await Promise.all([stat(clockFile), stat(rawFile)]);
  if (raw.size >= MAX_SCAN_BYTES || timing.size >= MAX_TIMING_BYTES) {
    throw new ReferenceLibraryError(422, 'Слишком большой объём декодированных кадров. Уменьши частоту кадров видео.');
  }
  const clock = await readFile(clockFile, 'utf8');
  const timestamps = clock.split('\n').filter(line => line.startsWith('0,')).map(line => Number(line.split(',')[2]));
  if (raw.size !== timestamps.length * SAMPLE_BYTES || timestamps.some(time => !Number.isSafeInteger(time) || time < 0)) {
    throw new Error('Invalid frame scan.');
  }
  const frames = await selectFrames(rawFile, timestamps);
  const selectFile = path.join(directory, 'select.txt');
  await writeFile(selectFile, `select='${indexFilter(frames)}',${BOUNDED_JPEG}`);
  await runFfmpeg([
    ...input, '-filter_threads', '2', '-map', '0:v:0', '-map_metadata', '-1', '-map_chapters', '-1',
    '-filter_script:v', selectFile,
    '-c:v', 'mjpeg', '-threads', '2', '-q:v', '3', '-fps_mode', 'passthrough',
    '-start_number', '0', path.join(directory, 'frame-%d.jpg'),
  ]);
  const files = new Set(await readdir(directory));
  return frames.map((frame, index) => {
    const file = `frame-${index}.jpg`;
    if (!files.has(file)) throw new Error('Missing selected frame.');
    return { file, timeMs: Math.round(frame.timeUs / 1000) };
  });
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
      return await extractVideo(input, directory);
    } else {
      requireSize(imageSize(scanned));
    }
    const file = 'frame-cover.jpg';
    await runFfmpeg([
      ...input, '-map', '0:v:0', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', BOUNDED_JPEG, '-frames:v', '1', '-c:v', 'mjpeg', '-threads', '2', '-q:v', '3', '-update', '1', path.join(directory, file),
    ]);
    if (!(await readdir(directory)).includes(file)) throw new Error('Empty frame.');
    return [{ file, timeMs: null }];
  } catch (error) {
    if (error instanceof ReferenceLibraryError) throw error;
    throw new ReferenceLibraryError(422, 'Не удалось прочитать файл и извлечь кадры.');
  }
}
