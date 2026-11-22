import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LlmRequest, LlmResult } from '../../src/server/llm/codexCli/provider.ts';
import type { Runner } from '../../src/server/llm/tasks/write.ts';
import { runFfmpeg } from '../../src/server/gen/ffmpeg.ts';
import { createReferenceLibrary } from '../../src/server/references/library.ts';
import { referenceRoutes } from '../../src/server/references/routes.ts';

const workdirs: string[] = [];
const notes = {
  visible: 'The subject stands in red light',
  technique: 'A red silhouette separates the subject from the blue background',
  transfer: 'Light the silhouette with a contrasting color',
  subject: 'Person', pose: '', composition: 'Centered', angle: 'Front view',
  lighting: 'Rim lighting', color: 'Red and blue', texture: '', styling: '',
};
function body(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 7));
      controller.enqueue(bytes.subarray(7));
      controller.close();
    },
  });
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'reference-library-test-'));
  workdirs.push(dir);
  const root = path.join(dir, 'references');
  return { dir, root, library: createReferenceLibrary(root) };
}
async function picture(dir: string, color: string) {
  const output = path.join(dir, `${color}.png`);
  await runFfmpeg(['-f', 'lavfi', '-i', `color=${color}:s=160x90:r=10`, '-frames:v', '1', '-threads', '1', '-update', '1', output]);
  return readFile(output);
}
afterEach(async () => {
  await Promise.all(workdirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('streams images, preserves the first import and removes temporary originals', async () => {
  const { dir, root, library } = await fixture();
  const bytes = await picture(dir, 'red');
  const results = await Promise.all([
    library.importFile('first.png', body(bytes)),
    library.importFile('second.png', body(bytes)),
  ]);
  expect(results[0]).toEqual(results[1]);
  const [card] = results[0]!;
  expect(card).toMatchObject({ timeMs: null, folder: null, analysis: null, version: 1 });
  const image = (await library.imagePath(card!.id, 'all'))!;
  expect((await readFile(image)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect((await readdir(path.dirname(image))).sort()).toEqual(['cards.json', 'frame-cover.jpg']);
  expect(await readdir(path.join(root, 'sources'))).toHaveLength(1);
  expect(await createReferenceLibrary(root).list('all')).toEqual([card]);
  expect(await createReferenceLibrary(root).list()).toEqual([]);
  await expect(library.importFile('broken.png', body(Buffer.from('broken')))).rejects.toMatchObject({ status: 422 });
  expect(await library.list('all')).toEqual([card]);
});

it('extracts distinct shot frames with decoded timestamps rather than retaining cadence or near duplicates', async () => {
  const { dir, library } = await fixture();
  const video = path.join(dir, 'two-shots.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=2',
    '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=10:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-threads', '1', video,
  ]);
  const cards = await library.importFile('two-shots.mp4', body(await readFile(video)));
  expect(cards).toHaveLength(2);
  expect(cards.map(card => card.timeMs)).toEqual([1000, 3000]);
  const colors = await Promise.all(cards.map(async card => {
    const input = (await library.imagePath(card.id, 'all'))!;
    const out = path.join(dir, `pixel-${card.timeMs}.rgb`);
    await runFfmpeg(['-i', input, '-vf', 'scale=1:1,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', out]);
    return readFile(out);
  }));
  expect(colors[0]?.[0]).toBeGreaterThan(220);
  expect(colors[1]?.[2]).toBeGreaterThan(220);
});

async function manyShotVideo(dir: string): Promise<string> {
  const video = path.join(dir, 'many-shots.mp4');
  const colors = ['red', 'lime', 'blue', 'yellow', 'magenta', 'cyan', 'orange', 'purple', 'teal', 'navy', 'chartreuse'];
  const shots = [...colors.map(color => ({ color, duration: 0.5 })),
    { color: 'red', duration: 0.05 }, { color: 'pink', duration: 0.05 }, { color: 'red', duration: 0.4 }];
  const inputs = shots.flatMap(({ color, duration }) => ['-f', 'lavfi', '-i', `color=${color}:s=160x90:r=20:d=${duration}`]);
  const sequence = shots.map((_, index) => `[${index}:v]`).join('');
  await runFfmpeg([
    ...inputs, '-filter_complex', `${sequence}concat=n=${shots.length}:v=1:a=0`,
    '-c:v', 'libx264', '-threads', '1', video,
  ]);
  return video;
}

it('scans every frame through a late single-frame insert and serves cards past index 9 after reload', async () => {
  const { dir, root, library } = await fixture();
  const bytes = await readFile(await manyShotVideo(dir));
  const cards = await library.importFile('many-shots.mp4', body(bytes));
  expect(cards).toHaveLength(12);
  const late = cards.at(-1)!;
  expect(late).toMatchObject({ timeMs: 5550, analysis: null, version: 1 });
  expect(late.id).toMatch(/-11$/);

  const reopened = createReferenceLibrary(root);
  expect(await reopened.list('all')).toEqual(cards);
  expect(await reopened.importFile('duplicate.mp4', body(bytes))).toEqual(cards);
  const app = referenceRoutes(root, reopened, async () => { throw new Error('Import and image read must not use AI.'); }, {});
  expect((await app.request(`/cards/${late.id}/image`)).status).toBe(404);
  const response = await app.request(`/cards/${late.id}/image?scope=all`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/jpeg');
  expect(new Uint8Array(await response.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
  const jpeg = (await reopened.imagePath(late.id, 'all'))!;
  const pink = path.join(dir, 'pink.rgb');
  await runFfmpeg(['-i', jpeg, '-vf', 'scale=1:1,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', pink]);
  const pixel = await readFile(pink);
  expect(pixel[0]).toBeGreaterThan(200);
  expect(pixel[2]).toBeGreaterThan(150);
});

it('extends a legacy eight-card video only on re-upload and preserves its names, IDs, images and analysis versions', async () => {
  const { dir, root, library } = await fixture();
  const video = await manyShotVideo(dir);
  const bytes = await readFile(video);
  const id = createHash('sha256').update(bytes).digest('hex');
  const source = path.join(root, 'sources', id);
  const upgrade = path.join(source, 'scan-v2');
  await mkdir(upgrade, { recursive: true });
  // A process interrupted between directory and manifest publication leaves no
  // visible cards. The retry must replace its unreferenced JPEGs safely.
  await writeFile(path.join(upgrade, 'frame-5550.jpg'), 'an unreferenced JPEG from a failed scan');
  const original = path.join(dir, 'first.jpg');
  await runFfmpeg(['-i', video, '-frames:v', '1', '-update', '1', original]);
  const jpeg = await readFile(original);
  const frames = Array.from({ length: 8 }, (_, index) => {
    const timeMs = 250 + index * 500;
    return { file: `frame-${timeMs}.jpg`, timeMs, versions: [
      { folder: null, tags: [], analysis: null },
      { folder: 'camera', tags: ['контровой свет'], analysis: { ...notes, visible: 'Старый разбор' } },
    ] };
  });
  await Promise.all(frames.map(frame => writeFile(path.join(source, frame.file), jpeg)));
  await writeFile(path.join(source, 'cards.json'), JSON.stringify({ name: 'original.mp4', frames }));
  const prior = await library.list('all');
  expect(prior).toHaveLength(8);
  const first = prior[0]!;
  const firstVersion = await library.get(first.id, 1, 'all');
  const firstPath = await library.imagePath(first.id, 'all');

  const [refreshed, repeated] = await Promise.all([
    library.importFile('same-content.mov', body(bytes)),
    library.importFile('same-content-again.mp4', body(bytes)),
  ]);
  expect(refreshed).toEqual(repeated);
  expect(refreshed).toHaveLength(12);
  expect(refreshed.slice(0, 8)).toEqual(prior);
  expect(refreshed.at(-1)).toMatchObject({ sourceName: 'original.mp4', timeMs: 5550, analysis: null, version: 1 });
  const reopened = createReferenceLibrary(root);
  expect(await reopened.list('all')).toEqual(refreshed);
  expect(await reopened.get(first.id, 1, 'all')).toEqual(firstVersion);
  expect(await reopened.imagePath(first.id, 'all')).toBe(firstPath);
  expect(await readFile(firstPath!)).toEqual(jpeg);
  const latePath = await reopened.imagePath(refreshed.at(-1)!.id, 'all');
  expect((await readFile(latePath!)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(await reopened.importFile('same-content-later.mp4', body(bytes))).toEqual(refreshed);
});

it('keeps one representative for a static clip', async () => {
  const { dir, library } = await fixture();
  const file = path.join(dir, 'static.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=160x90:r=50:d=3', '-c:v', 'libx264', '-threads', '1', file]);
  const cards = await library.importFile('static.mp4', body(await readFile(file)));
  expect(cards).toHaveLength(1);
  expect(cards[0]!.timeMs).toBe(1500);
});

it('chooses a clear frame within a stable composition', async () => {
  const { dir, library } = await fixture();
  const file = path.join(dir, 'focus-change.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=steelblue:s=160x90:r=20:d=3',
    '-vf', "drawgrid=w=24:h=18:t=2:c=white,boxblur=6:2:enable='lt(t,1)+gte(t,2)'",
    '-c:v', 'libx264', '-threads', '1', file,
  ]);
  const cards = await library.importFile('focus-change.mp4', body(await readFile(file)));
  expect(cards).toHaveLength(1);
  expect(cards[0]!.timeMs).toBeGreaterThanOrEqual(1000);
  expect(cards[0]!.timeMs).toBeLessThan(2000);
});

it('omits blank videos and cleans their staged originals', async () => {
  const { dir, root, library } = await fixture();
  const file = path.join(dir, 'blank.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=black:s=160x90:r=10:d=2', '-c:v', 'libx264', '-threads', '1', file]);
  await expect(library.importFile('blank.mp4', body(await readFile(file)))).rejects.toMatchObject({ status: 422 });
  expect(await library.list()).toEqual([]);
  expect(await readdir(path.join(root, 'sources'))).toEqual([]);
});

function reply<T>(request: LlmRequest): LlmResult<T> {
  const { imageIdsInOrder, candidateIds } = JSON.parse(request.user) as { imageIdsInOrder: string[]; candidateIds?: string[] };
  if (request.taskRu === 'Проверка качества референсов') return {
    data: { frames: candidateIds!.map(id => ({ id, status: 'keep', reasonCode: 'useful', reason: 'Выразительная композиция.', duplicateOf: null })) } as T,
    meta: { durationMs: 1, model: 'mock', turns: 1, inputTokens: 0, outputTokens: 0 },
  };
  return {
    data: { frames: imageIdsInOrder.map(id => ({ id, folder: 'camera', tags: ['lighting'], analysis: notes })) } as T,
    meta: { durationMs: 1, model: 'mock', turns: 1, inputTokens: 100, outputTokens: 20 },
  };
}

it('commits completed batches and manually retries the remaining frames after stop', async () => {
  const { dir, root, library } = await fixture();
  for (const color of ['red', 'blue', 'green', 'yellow', 'cyan']) {
    await library.importFile(`${color}.png`, body(await picture(dir, color)));
  }
  const first = (await library.list('all'))[0]!;
  const changed = await library.edit(first.id, { folder: 'details', tags: ['мой тег', 'Мой тег'] });
  const sizes: number[] = [];
  const runner: Runner = async request => {
    if (request.taskRu === 'Проверка качества референсов') return reply(request);
    sizes.push(request.images?.length ?? 0);
    if (sizes.length === 2) await new Promise<void>((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return reply(request);
  };
  await expect(library.startAnalysis(runner, 4)).rejects.toMatchObject({ status: 409 });
  expect(await library.startAnalysis(runner, 5)).toMatchObject({ status: 'running', total: 5 });
  await vi.waitFor(() => expect(sizes).toEqual([4, 1]));
  expect(await library.stopAnalysis()).toMatchObject({ status: 'stopped', completed: 4, inputTokens: 100, outputTokens: 20 });
  expect((await library.get(first.id))?.folder).toBe('details');
  expect((await library.get(first.id))?.tags).toEqual(['мой тег']);
  expect(await library.get(first.id, changed!.version)).toBeUndefined();
  expect(await library.get(first.id, changed!.version, 'all')).toMatchObject({ id: changed!.id, version: changed!.version, tags: changed!.tags });

  const reopened = createReferenceLibrary(root);
  expect(await reopened.startAnalysis(async request => {
    expect(request.images).toHaveLength(1);
    return reply(request);
  }, 1)).toMatchObject({ status: 'running', total: 1 });
  await vi.waitFor(async () => expect(await reopened.analysisStatus()).toMatchObject({ status: 'done', completed: 1, kept: 1 }));
  expect((await reopened.list()).every(card => card.analysis?.visible === notes.visible)).toBe(true);
});

it('does not publish an invalid model batch or retry without a click', async () => {
  const { dir, library } = await fixture();
  const [card] = await library.importFile('red.png', body(await picture(dir, 'red')));
  const runner: Runner = async <T>(request: LlmRequest) => request.taskRu === 'Проверка качества референсов' ? reply<T>(request) : ({
    data: { frames: [{ id: 'foreign-card', folder: 'camera', tags: [], analysis: notes }] } as T,
    meta: { durationMs: 1, model: 'mock', turns: 1, inputTokens: 12, outputTokens: 4 },
  });
  await library.startAnalysis(runner);
  await vi.waitFor(async () => expect(await library.analysisStatus()).toMatchObject({ status: 'error', completed: 0, inputTokens: 12 }));
  expect(await library.get(card!.id)).toBeUndefined();
  expect(await library.get(card!.id, undefined, 'all')).toMatchObject({ analysis: null, eligible: false });
});

it('rejects non-English prose on a correctly identified frame before saving it', async () => {
  const { dir, library } = await fixture();
  const [card] = await library.importFile('red.png', body(await picture(dir, 'red')));
  const runner: Runner = async <T>(request: LlmRequest) => request.taskRu === 'Проверка качества референсов' ? reply<T>(request) : ({
    ...reply<T>(request),
    data: { frames: [{ id: card!.id, folder: 'camera', tags: ['lighting'], analysis: { ...notes, visible: 'Красный силуэт' } }] } as T,
  });
  await library.startAnalysis(runner);
  await vi.waitFor(async () => expect(await library.analysisStatus()).toMatchObject({ status: 'error', completed: 0 }));
  expect(await library.get(card!.id)).toBeUndefined();
});

it('stops promptly while a provider call is waiting and ignores its late result', async () => {
  const { dir, library } = await fixture();
  const [card] = await library.importFile('red.png', body(await picture(dir, 'red')));
  let finish: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  await library.startAnalysis(<T>(request: LlmRequest) => request.taskRu === 'Проверка качества референсов' ? Promise.resolve(reply<T>(request)) : new Promise<LlmResult<T>>(resolve => {
    signal = request.signal;
    finish = () => resolve(reply<T>(request));
  }));
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(await library.stopAnalysis()).toMatchObject({ status: 'stopped', completed: 0 });
  expect(signal?.aborted).toBe(true);
  finish!();
  expect(await library.get(card!.id)).toBeUndefined();
  expect(await library.get(card!.id, undefined, 'all')).toMatchObject({ analysis: null, eligible: false });
});
