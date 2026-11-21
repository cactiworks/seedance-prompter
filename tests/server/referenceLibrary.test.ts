import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LlmRequest, LlmResult } from '../../src/server/llm/codexCli/provider.ts';
import type { Runner } from '../../src/server/llm/tasks/write.ts';
import { runFfmpeg } from '../../src/server/gen/ffmpeg.ts';
import { createReferenceLibrary } from '../../src/server/references/library.ts';

const workdirs: string[] = [];
const notes = {
  visible: 'Герой в красном свете',
  technique: 'Красный силуэт отделяется от синего фона',
  transfer: 'Подсвети края объекта контрастным цветом',
  subject: 'Герой', pose: '', composition: 'По центру', angle: 'Фронтально',
  lighting: 'Контровой свет', color: 'Красный и синий', texture: '', styling: '',
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
  const image = (await library.imagePath(card!.id))!;
  expect((await readFile(image)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect((await readdir(path.dirname(image))).sort()).toEqual(['cards.json', 'frame-cover.jpg']);
  expect(await readdir(path.join(root, 'sources'))).toHaveLength(1);
  expect(await createReferenceLibrary(root).list()).toEqual([card]);
  await expect(library.importFile('broken.png', body(Buffer.from('broken')))).rejects.toMatchObject({ status: 422 });
  expect(await library.list()).toEqual([card]);
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
    const input = (await library.imagePath(card.id))!;
    const out = path.join(dir, `pixel-${card.timeMs}.rgb`);
    await runFfmpeg(['-i', input, '-vf', 'scale=1:1,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', out]);
    return readFile(out);
  }));
  expect(colors[0]?.[0]).toBeGreaterThan(220);
  expect(colors[1]?.[2]).toBeGreaterThan(220);
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
  const { imageIdsInOrder } = JSON.parse(request.user) as { imageIdsInOrder: string[] };
  return {
    data: { frames: imageIdsInOrder.map(id => ({ id, folder: 'camera', tags: ['свет'], analysis: notes })) } as T,
    meta: { durationMs: 1, model: 'mock', turns: 1, inputTokens: 100, outputTokens: 20 },
  };
}

it('commits completed batches and manually retries the remaining frames after stop', async () => {
  const { dir, root, library } = await fixture();
  for (const color of ['red', 'blue', 'green', 'yellow', 'cyan']) {
    await library.importFile(`${color}.png`, body(await picture(dir, color)));
  }
  const first = (await library.list())[0]!;
  const changed = await library.edit(first.id, { folder: 'details', tags: ['мой тег', 'Мой тег'] });
  const sizes: number[] = [];
  const runner: Runner = async request => {
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
  expect(await library.get(first.id, changed!.version)).toEqual(changed);

  const reopened = createReferenceLibrary(root);
  expect(await reopened.startAnalysis(async request => {
    expect(request.images).toHaveLength(1);
    return reply(request);
  }, 1)).toMatchObject({ status: 'running', total: 1 });
  await vi.waitFor(async () => expect(await reopened.analysisStatus()).toMatchObject({ status: 'done', completed: 1 }));
  expect((await reopened.list()).every(card => card.analysis?.visible === notes.visible)).toBe(true);
});

it('does not publish an invalid model batch or retry without a click', async () => {
  const { dir, library } = await fixture();
  const [card] = await library.importFile('red.png', body(await picture(dir, 'red')));
  const runner: Runner = async <T>() => ({
    data: { frames: [{ id: 'foreign-card', folder: 'camera', tags: [], analysis: notes }] } as T,
    meta: { durationMs: 1, model: 'mock', turns: 1, inputTokens: 12, outputTokens: 4 },
  });
  await library.startAnalysis(runner);
  await vi.waitFor(async () => expect(await library.analysisStatus()).toMatchObject({ status: 'error', completed: 0, inputTokens: 12 }));
  expect(await library.get(card!.id)).toEqual(card);
});

it('stops promptly while a provider call is waiting and ignores its late result', async () => {
  const { dir, library } = await fixture();
  const [card] = await library.importFile('red.png', body(await picture(dir, 'red')));
  let finish: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  await library.startAnalysis(<T>(request: LlmRequest) => new Promise<LlmResult<T>>(resolve => {
    signal = request.signal;
    finish = () => resolve(reply<T>(request));
  }));
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(await library.stopAnalysis()).toMatchObject({ status: 'stopped', completed: 0 });
  expect(signal?.aborted).toBe(true);
  finish!();
  expect(await library.get(card!.id)).toEqual(card);
});
