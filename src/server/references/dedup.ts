import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { imageSize } from '../gen/imageSize.ts';
import { ReferenceLibraryError } from './media.ts';
import { sha256 } from './quality.ts';

export const REFERENCE_DEDUP_METHOD = 'visual-near-duplicate-v1';
export const ReferenceFingerprintSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{16}$/), colors: z.string(), detail: z.string(), sharpness: z.number().nonnegative(),
  width: z.number().int().positive(), height: z.number().int().positive(),
});
export type ReferenceFingerprint = z.infer<typeof ReferenceFingerprintSchema>;
export const StoredDedupDecisionSchema = z.object({
  status: z.enum(['keep', 'duplicate']), imageSha256: z.string(), reviewId: z.string(),
  fingerprint: ReferenceFingerprintSchema, duplicateOf: z.string().optional(),
  reason: z.string(), method: z.literal(REFERENCE_DEDUP_METHOD), at: z.string(),
  retainedBecauseReferenced: z.boolean().optional(),
  purged: z.boolean().optional(),
});
export type StoredDedupDecision = z.infer<typeof StoredDedupDecisionSchema>;
export const ReferenceDedupStateSchema = z.object({
  id: z.string(), inputDigest: z.string(), method: z.literal(REFERENCE_DEDUP_METHOD), at: z.string(),
  frames: z.record(z.string(), StoredDedupDecisionSchema),
});
export type ReferenceDedupState = z.infer<typeof ReferenceDedupStateSchema>;
export interface DedupInput {
  id: string; imageSha256: string; reviewId: string; imagePath?: string;
  previous?: StoredDedupDecision;
}
export interface FingerprintedReference extends DedupInput { fingerprint: ReferenceFingerprint }
export interface DedupProgress { completed: number; total: number }

const execute = promisify(execFile);
const side = 32;
const frameBytes = side * side * 3;
const cosines = Array.from({ length: 8 }, (_, frequency) =>
  Array.from({ length: side }, (_, position) => Math.cos((2 * position + 1) * frequency * Math.PI / (2 * side))));

function fingerprint(rgb: Buffer, size: { width: number; height: number }): ReferenceFingerprint {
  const gray = Array.from({ length: side * side }, (_, index) =>
    rgb[index * 3]! * 0.299 + rgb[index * 3 + 1]! * 0.587 + rgb[index * 3 + 2]! * 0.114);
  const intermediate = Array.from({ length: 8 * side }, (_, index) => {
    const frequency = Math.floor(index / side), row = index % side;
    return cosines[frequency]!.reduce((sum, cosine, column) => sum + gray[row * side + column]! * cosine, 0);
  });
  const coefficients = Array.from({ length: 64 }, (_, index) => {
    const horizontal = Math.floor(index / 8), vertical = index % 8;
    const coefficient = cosines[vertical]!.reduce((sum, cosine, row) => sum + intermediate[horizontal * side + row]! * cosine, 0);
    return Math.abs(coefficient) < 0.000001 ? 0 : coefficient;
  });
  const strongest = Math.max(...coefficients.slice(1).map(Math.abs));
  const stable = coefficients.map((value, index) => index === 0 || Math.abs(value) >= strongest * 0.02 ? value : 0);
  const median = [...stable.slice(1)].sort((left, right) => left - right)[31]!;
  const bits = stable.reduce((hash, value, index) => hash | (index > 0 && value > median ? 1n << BigInt(index) : 0n), 0n);
  const colors = Buffer.alloc(8 * 8 * 3);
  for (let block = 0; block < 64; block++) {
    for (let channel = 0; channel < 3; channel++) {
      let total = 0;
      for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
        total += rgb[((Math.floor(block / 8) * 4 + row) * side + block % 8 * 4 + column) * 3 + channel]!;
      }
      colors[block * 3 + channel] = Math.round(total / 16);
    }
  }
  let sharpness = 0;
  for (let row = 1; row < side - 1; row++) for (let column = 1; column < side - 1; column++) {
    const position = row * side + column;
    const laplacian = 4 * gray[position]! - gray[position - 1]! - gray[position + 1]! - gray[position - side]! - gray[position + side]!;
    sharpness += laplacian * laplacian;
  }
  return { hash: bits.toString(16).padStart(16, '0'), colors: colors.toString('base64'), detail: Buffer.from(gray.map(Math.round)).toString('base64'),
    sharpness: sharpness / ((side - 2) ** 2), ...size };
}

export function visualNearDuplicate(left: ReferenceFingerprint, right: ReferenceFingerprint): boolean {
  if (Math.abs((left.width / left.height) / (right.width / right.height) - 1) > 0.01) return false;
  let different = BigInt(`0x${left.hash}`) ^ BigInt(`0x${right.hash}`), distance = 0;
  while (different) { if (++distance > 4) return false; different &= different - 1n; }
  const first = Buffer.from(left.colors, 'base64'), second = Buffer.from(right.colors, 'base64');
  if (first.length !== 192 || second.length !== 192) return false;
  let total = 0, squared = 0;
  for (let index = 0; index < first.length; index++) {
    const difference = Math.abs(first[index]! - second[index]!);
    if (difference > 25) return false;
    total += difference; squared += difference * difference;
  }
  if (total / first.length > 4.5 || Math.sqrt(squared / first.length) > 7) return false;
  const firstDetail = Buffer.from(left.detail, 'base64'), secondDetail = Buffer.from(right.detail, 'base64');
  if (firstDetail.length !== 1024 || secondDetail.length !== 1024) return false;
  let detailSquared = 0;
  for (let index = 0; index < firstDetail.length; index++) {
    const difference = Math.abs(firstDetail[index]! - secondDetail[index]!);
    if (difference > 32) return false;
    detailSquared += difference * difference;
  }
  return Math.sqrt(detailSquared / firstDetail.length) <= 6;
}

export async function referenceFingerprints(root: string, inputs: DedupInput[], signal: AbortSignal,
  onProgress: (progress: DedupProgress) => Promise<void>): Promise<FingerprintedReference[]> {
  const ready: FingerprintedReference[] = [];
  const missing: DedupInput[] = [];
  for (const input of inputs) {
    if (input.previous?.imageSha256 === input.imageSha256) ready.push({ ...input, fingerprint: input.previous.fingerprint });
    else missing.push(input);
  }
  await onProgress({ completed: ready.length, total: inputs.length });
  for (let offset = 0; offset < missing.length; offset += 64) {
    signal.throwIfAborted();
    const batch = missing.slice(offset, offset + 64);
    const staging = await mkdtemp(path.join(root, '.dedup-'));
    try {
      const sizes = await Promise.all(batch.map(async (input, index) => {
        if (!input.imagePath) throw new ReferenceLibraryError(409, 'Для сравнения дублей нужно восстановить недоступный кадр.');
        const bytes = await readFile(input.imagePath);
        if (sha256(bytes) !== input.imageSha256) throw new ReferenceLibraryError(409, 'Кадр изменился во время сравнения дублей.');
        const size = imageSize(bytes);
        if (!size) throw new ReferenceLibraryError(422, 'Не удалось прочитать размер кадра для сравнения.');
        await writeFile(path.join(staging, `${index}.jpg`), bytes, { mode: 0o600 });
        return size;
      }));
      await writeFile(path.join(staging, 'inputs.txt'), batch.map((_, index) => `file '${index}.jpg'`).join('\n'));
      const binary = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(existsSync) ?? 'ffmpeg';
      await execute(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2',
        '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '0', '-i', path.join(staging, 'inputs.txt'),
        '-vf', 'scale=32:32,format=rgb24', '-fps_mode', 'passthrough', '-threads', '1', '-f', 'rawvideo', path.join(staging, 'pixels.rgb')],
      { timeout: 60_000, signal, maxBuffer: 64 * 1024 });
      signal.throwIfAborted();
      const pixels = await readFile(path.join(staging, 'pixels.rgb'));
      if (pixels.length !== batch.length * frameBytes) throw new ReferenceLibraryError(422, 'Сравнение кадров вернуло неверное число изображений.');
      batch.forEach((input, index) => ready.push({ ...input, fingerprint: fingerprint(pixels.subarray(index * frameBytes, (index + 1) * frameBytes), sizes[index]!) }));
      await onProgress({ completed: ready.length, total: inputs.length });
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  return ready;
}

export async function groupReferenceDuplicates(inputs: FingerprintedReference[], signal: AbortSignal) {
  const units = new Map(inputs.filter(input => input.previous?.status !== 'duplicate').map(input => [input.id, [input]]));
  for (const input of inputs.filter(input => input.previous?.status === 'duplicate')) {
    const members = units.get(input.previous!.duplicateOf ?? '');
    if (!members || !members.every(member => visualNearDuplicate(member.fingerprint, input.fingerprint))) {
      throw new ReferenceLibraryError(409, 'Представитель сохранённого дубля изменился. Восстанови исходный кадр перед продолжением.');
    }
    members.push(input);
  }
  const ordered = [...units.values()].sort((left, right) => right[0]!.fingerprint.sharpness - left[0]!.fingerprint.sharpness ||
    right[0]!.fingerprint.width * right[0]!.fingerprint.height - left[0]!.fingerprint.width * left[0]!.fingerprint.height || left[0]!.id.localeCompare(right[0]!.id));
  const groups: FingerprintedReference[][] = [];
  for (const [index, members] of ordered.entries()) {
    signal.throwIfAborted();
    const group = groups.find(group => members.every(member => group.every(prior =>
      member.imageSha256 === prior.imageSha256 || visualNearDuplicate(member.fingerprint, prior.fingerprint))));
    if (group) group.push(...members); else groups.push([...members]);
    if (index % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  return groups;
}
