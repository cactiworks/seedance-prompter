import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runFfmpeg } from '../../src/server/gen/ffmpeg.ts';
import { REFERENCE_DEDUP_METHOD, groupReferenceDuplicates, visualNearDuplicate, type ReferenceFingerprint } from '../../src/server/references/dedup.ts';
import { createReferenceLibrary } from '../../src/server/references/library.ts';
import { REFERENCE_QUALITY_PROMPT_HASH, REFERENCE_QUALITY_VERSION, sha256 } from '../../src/server/references/quality.ts';

const readBarrier = vi.hoisted(() => ({ file: '', pause: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args);
    if (String(args[0]) === readBarrier.file && readBarrier.pause) {
      const pause = readBarrier.pause; readBarrier.pause = undefined; await pause();
    }
    return result;
  } };
});

const directories: string[] = [];
const analysis = { visible: 'A clear composition', technique: 'Visible framing', transfer: 'Use the framing',
  subject: '', pose: '', composition: '', angle: '', lighting: '', color: '', texture: '', styling: '' };

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'reference-dedup-')); directories.push(dir);
  const root = path.join(dir, 'references');
  await mkdir(root);
  const picture = async (name: string, filter: string) => {
    const file = path.join(dir, `${name}.jpg`);
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=steelblue:s=320x180:r=1', '-vf', filter,
      '-frames:v', '1', '-q:v', '2', '-threads', '1', '-update', '1', file]);
    return readFile(file);
  };
  const add = async (key: string, bytes: Buffer) => {
    const sourceId = key.repeat(64), imageSha256 = sha256(bytes), reviewId = `review-${key}`;
    const source = path.join(root, 'sources', sourceId);
    await mkdir(source, { recursive: true });
    const image = path.join(source, 'frame-0.jpg'); await writeFile(image, bytes);
    const manifest = { name: `${key}.mp4`, scanVersion: 2,
      qualityCohort: { id: `cohort-${key}`, status: 'complete', criteriaVersion: REFERENCE_QUALITY_VERSION,
        promptHash: REFERENCE_QUALITY_PROMPT_HASH,
        imageDigest: sha256(JSON.stringify([{ file: 'frame-0.jpg', timeMs: 0, imageSha256 }])) },
      frames: [{ file: 'frame-0.jpg', timeMs: 0,
        quality: { status: 'keep', reasonCode: 'useful', reason: 'Полезная композиция.', reviewId,
          criteriaVersion: REFERENCE_QUALITY_VERSION, imageSha256, promptHash: REFERENCE_QUALITY_PROMPT_HASH,
          model: 'previous-paid-qc', at: '2026-11-22T12:00:00.000Z' },
        versions: [{ folder: 'camera', tags: ['framing'], analysis, analysisBinding: { imageSha256, reviewId } }] }],
    };
    await writeFile(path.join(source, 'cards.json'), JSON.stringify(manifest));
    return { id: `rf-${sourceId}-0`, source, image, manifest: await readFile(path.join(source, 'cards.json'), 'utf8') };
  };
  return { dir, root, picture, add, library: createReferenceLibrary(root) };
}

afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('preserves the completed QC prompt and criteria while adding free curation', () => {
  expect(REFERENCE_QUALITY_VERSION).toBe(1);
  expect(REFERENCE_QUALITY_PROMPT_HASH).toBe('14ad7d2ec97942ac7c32dc76388dee27210c2571d41218016fccf09d0a48ee81');
});

it('returns a fresh edit result while concurrent readers finish an older coalesced scan', async () => {
  const { picture, add, library } = await fixture();
  const entry = await add('a', await picture('edit', 'drawgrid=w=40:h=30:t=3:c=white'));
  await library.list('all');
  let release: () => void = () => undefined;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let reached = false;
  const manifest = path.join(entry.source, 'cards.json');
  readBarrier.file = manifest;
  readBarrier.pause = async () => { reached = true; await paused; };
  const reading = library.list('all');
  await vi.waitFor(() => expect(reached).toBe(true));
  const editing = library.edit(entry.id, { tags: ['updated'] });
  await vi.waitFor(async () => {
    const source = JSON.parse(await readFile(manifest, 'utf8'));
    expect(source.frames[0].versions.at(-1).tags).toEqual(['updated']);
  });
  release();
  expect(await editing).toMatchObject({ version: 2, tags: ['updated'] });
  expect((await reading)[0]).toMatchObject({ version: 1, tags: ['framing'] });
}, 2000);

it('curates duplicates across sources, replaces a weaker keeper and redirects older tombstones directly', async () => {
  const { dir, root, picture, add, library } = await fixture();
  const sharp = await picture('sharp', 'drawgrid=w=40:h=30:t=3:c=white');
  const blurredFile = path.join(dir, 'blurred.jpg');
  await runFfmpeg(['-i', path.join(dir, 'sharp.jpg'), '-vf', 'boxblur=2:1', '-frames:v', '1', '-q:v', '2', '-threads', '1', '-update', '1', blurredFile]);
  const blurred = await readFile(blurredFile);
  const old = await add('a', blurred);
  await library.curateDuplicates(new AbortController().signal);
  expect((await library.list()).map(card => card.id)).toEqual([old.id]);
  const better = await add('b', sharp);
  expect(await library.list()).toEqual([]);
  const result = await library.curateDuplicates(new AbortController().signal);
  expect(result.duplicateIds).toEqual([old.id]);
  expect((await library.list()).map(card => card.id)).toEqual([better.id]);
  expect(await library.get(old.id, 1, 'all')).toMatchObject({ quality: { status: 'keep' }, dedup: { status: 'duplicate', duplicateOf: better.id } });
  expect(await readdir(old.source)).toEqual(['cards.json']);
  expect(await readFile(path.join(old.source, 'cards.json'), 'utf8')).toBe(old.manifest);
  const third = await add('c', sharp);
  await library.curateDuplicates(new AbortController().signal);
  const decisions = (await library.qualityAudit()).decisions.filter(card => card.dedup?.status === 'duplicate');
  expect(decisions.map(card => card.id).sort()).toEqual([old.id, third.id].sort());
  expect(decisions.every(card => card.dedup?.duplicateOf === better.id)).toBe(true);
  expect(await library.qualityAudit()).toMatchObject({ kept: 3, duplicates: 2, eligible: 1, pendingWork: 0 });
  expect((await createReferenceLibrary(root).list()).map(card => card.id)).toEqual([better.id]);
});

it('keeps distinct compositions with the same palette and does not merge transitive similarity chains', async () => {
  const { picture, add, library } = await fixture();
  const left = await add('a', await picture('left', 'drawbox=x=10:y=50:w=60:h=80:color=white:t=fill'));
  const right = await add('b', await picture('right', 'drawbox=x=230:y=50:w=60:h=80:color=white:t=fill'));
  await library.curateDuplicates(new AbortController().signal);
  expect((await library.list()).map(card => card.id).sort()).toEqual([left.id, right.id].sort());
  const fingerprint = (color: number, sharpness: number): ReferenceFingerprint => ({
    hash: '0000000000000000', colors: Buffer.alloc(192, color).toString('base64'), detail: Buffer.alloc(1024, color).toString('base64'), width: 320, height: 180, sharpness,
  });
  const first = fingerprint(100, 3), middle = fingerprint(104, 2), last = fingerprint(108, 1);
  expect(visualNearDuplicate(first, middle)).toBe(true);
  expect(visualNearDuplicate(middle, last)).toBe(true);
  expect(visualNearDuplicate(first, last)).toBe(false);
  const groups = await groupReferenceDuplicates([first, middle, last].map((value, index) => ({
    id: String(index), imageSha256: String(index), reviewId: 'qc', fingerprint: value,
  })), new AbortController().signal);
  expect(groups.map(group => group.map(card => card.id))).toEqual([['0', '1'], ['2']]);
  const historical = await groupReferenceDuplicates([first, middle, last].map((value, index) => ({
    id: String(index), imageSha256: String(index), reviewId: 'qc', fingerprint: value,
    previous: index === 2 ? { status: 'duplicate' as const, duplicateOf: '1', fingerprint: last, imageSha256: '2', reviewId: 'qc',
      reason: 'Previous duplicate', method: REFERENCE_DEDUP_METHOD, at: '2026-11-22T00:00:00.000Z' } : undefined,
  })), new AbortController().signal);
  expect(historical.map(group => group.map(card => card.id))).toEqual([['0'], ['1', '2']]);
});

it('retains referenced duplicate images, removes them after unlinking and never loses their stable IDs', async () => {
  const { dir, root, picture, add, library } = await fixture();
  const bytes = await picture('same', 'drawgrid=w=40:h=30:t=3:c=white');
  const winner = await add('a', bytes), loser = await add('b', bytes);
  const history = path.join(dir, 'canvas', 'history.json'); await mkdir(path.dirname(history));
  await writeFile(history, JSON.stringify({ libraryRefs: [{ id: loser.id, version: 1 }] }));
  await library.curateDuplicates(new AbortController().signal);
  expect(await library.get(loser.id)).toBeUndefined();
  expect(await library.get(loser.id, 1, 'all')).toMatchObject({ dedup: { duplicateOf: winner.id, retainedBecauseReferenced: true } });
  expect(await readdir(loser.source)).toContain('frame-0.jpg');
  await rm(loser.image);
  const lostReference = createReferenceLibrary(root);
  expect(await lostReference.get(loser.id, 1, 'all')).toMatchObject({ quality: { status: 'pending' }, dedup: undefined });
  await writeFile(loser.image, bytes);
  await rm(history);
  const reopened = createReferenceLibrary(root);
  expect((await reopened.list()).map(card => card.id)).toEqual([winner.id]);
  expect(await readdir(loser.source)).toEqual(['cards.json']);
  expect(await reopened.get(loser.id, 1, 'all')).toMatchObject({ dedup: { status: 'duplicate', duplicateOf: winner.id, retainedBecauseReferenced: false } });
  expect(await reopened.qualityAudit()).toMatchObject({ kept: 2, duplicates: 1, pendingWork: 0 });
  const changedBytes = Buffer.concat([bytes, Buffer.from('replacement after curation')]);
  await writeFile(loser.image, changedBytes);
  const changed = createReferenceLibrary(root);
  await changed.list('all');
  expect(await readFile(loser.image)).toEqual(changedBytes);
  expect(await changed.get(loser.id)).toBeUndefined();
  expect(await changed.get(loser.id, 1, 'all')).toMatchObject({ quality: { status: 'pending' }, dedup: undefined });
  expect(await changed.qualityAudit()).toMatchObject({ pendingWork: 2 });
});

it('fails closed on cancellation and changed bytes while preserving cached analyses for a later free pass', async () => {
  const { root, picture, add, library } = await fixture();
  const bytes = await picture('picture', 'drawgrid=w=40:h=30:t=3:c=white');
  const entry = await add('a', bytes);
  const cancelled = new AbortController();
  await expect(library.curateDuplicates(cancelled.signal, async progress => { if (progress.completed === 0) cancelled.abort(); })).rejects.toMatchObject({ name: 'AbortError' });
  expect(await library.list()).toEqual([]);
  expect((await readdir(root)).some(name => name.startsWith('.dedup-'))).toBe(false);
  await expect(library.curateDuplicates(new AbortController().signal, async progress => {
    if (progress.completed > 0) await writeFile(entry.image, Buffer.concat([bytes, Buffer.from('changed')]));
  })).rejects.toMatchObject({ status: 409 });
  expect(await library.list()).toEqual([]);
  await writeFile(entry.image, bytes);
  const restarted = createReferenceLibrary(root);
  expect(await restarted.list()).toEqual([]);
  await restarted.curateDuplicates(new AbortController().signal);
  expect(await restarted.get(entry.id, 1)).toMatchObject({ analysis, eligible: true });
  expect(await restarted.qualityAudit()).toMatchObject({ pendingWork: 0, eligible: 1 });
});
