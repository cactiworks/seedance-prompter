import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CanvasNodeSchema } from '../../src/core/model/canvas.ts';
import type { ReferenceCard } from '../../src/core/references.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import { runFfmpeg } from '../../src/server/gen/ffmpeg.ts';
import type { LlmRequest, LlmResult } from '../../src/server/llm/codexCli/provider.ts';
import type { Runner } from '../../src/server/llm/tasks/write.ts';
import { createReferenceChat } from '../../src/server/references/chat.ts';
import { createReferenceLibrary, type ReferenceLibrary } from '../../src/server/references/library.ts';
import { REFERENCE_QUALITY_PROMPT_HASH, REFERENCE_QUALITY_VERSION, sha256 } from '../../src/server/references/quality.ts';
import { referenceRoutes } from '../../src/server/references/routes.ts';
import { createFlows } from '../../src/server/storage/flows.ts';

const roots: string[] = [];
const libraries: ReferenceLibrary[] = [];
const notes = {
  visible: 'A graphic composition', technique: 'Contrasting color blocks', transfer: 'Separate shapes with contrasting colors',
  subject: 'Graphic', pose: '', composition: 'Layered', angle: '', lighting: '', color: 'Red', texture: '', styling: '',
};
const meta = { durationMs: 1, model: 'fake-qc', turns: 1, inputTokens: 20, outputTokens: 10 };
const keep = (id: string) => ({ id, status: 'keep', reasonCode: 'useful', reason: 'Полезная композиция.', duplicateOf: null });
const reject = (id: string) => ({ id, status: 'reject', reasonCode: 'information_card', reason: 'Служебный текст без визуального приёма.', duplicateOf: null });
const uncertain = (id: string) => ({ id, status: 'uncertain', reasonCode: 'unclear', reason: 'Нельзя уверенно оценить приём.', duplicateOf: null });
const input = (request: LlmRequest) => JSON.parse(request.user) as { imageIdsInOrder: string[]; candidateIds: string[]; anchorIds: string[] };
function response<T>(request: LlmRequest): LlmResult<T> {
  return {
    data: { frames: request.taskRu === 'Проверка качества референсов'
      ? input(request).candidateIds.map(keep)
      : input(request).imageIdsInOrder.map(id => ({ id, folder: 'graphics', tags: ['color'], analysis: notes })) } as T,
    meta,
  };
}

async function fixture(count = 3, legacy = true) {
  const dir = await mkdtemp(path.join(tmpdir(), 'reference-quality-'));
  roots.push(dir);
  const root = path.join(dir, 'references');
  const sourceId = sha256('labelled-source');
  const source = path.join(root, 'sources', sourceId);
  await mkdir(source, { recursive: true });
  const original = path.join(dir, 'input.jpg');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=red:s=160x90:r=1', '-frames:v', '1', '-threads', '1', '-update', '1', original]);
  const jpeg = await readFile(original);
  const frames = Array.from({ length: count }, (_, index) => ({
    file: `frame-${index}.jpg`, timeMs: index * 1000,
    versions: [{ folder: null, tags: [], analysis: null }, ...(legacy ? [{ folder: 'camera', tags: ['legacy'], analysis: notes }] : [])],
  }));
  await Promise.all(frames.map(frame => writeFile(path.join(source, frame.file), jpeg)));
  await writeFile(path.join(source, 'cards.json'), JSON.stringify({ name: 'labelled.mp4', scanVersion: 2, frames }));
  const library = createReferenceLibrary(root);
  libraries.push(library);
  const cards = await library.list('all');
  const routes = referenceRoutes(path.join(root, 'chat'), library, async () => { throw new Error('A read must not call AI.'); }, {});
  return { dir, root, sourceId, source, jpeg, frames, cards, library, routes };
}
async function finish(library: ReferenceLibrary, status = 'done') {
  await vi.waitFor(async () => expect(await library.analysisStatus()).toMatchObject({ status }));
}
afterEach(async () => {
  await Promise.all(libraries.splice(0).map(library => library.stopAnalysis()));
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('quarantines legacy analyses and only publishes freshly analyzed keep decisions, preserving pinned history', async () => {
  const { dir, source, cards, library, routes } = await fixture();
  const [accepted, discarded, unknown] = cards as [ReferenceCard, ReferenceCard, ReferenceCard];
  await mkdir(path.join(dir, 'canvas'), { recursive: true });
  await writeFile(path.join(dir, 'canvas', 'f-protected.json'), JSON.stringify({ libraryRefs: [{ id: discarded.id, version: 2 }] }));
  expect(await library.list()).toEqual([]);
  expect(await library.get(accepted.id, 2)).toBeUndefined();
  expect((await routes.request(`/cards/${accepted.id}/image`)).status).toBe(404);
  expect((await routes.request(`/cards/${accepted.id}/image?scope=all`)).status).toBe(200);
  const chat = createReferenceChat(path.join(dir, 'references', 'chat'), library);
  await expect(chat.setSelection('test', [{ id: accepted.id, version: 2, role: 'композиция' }])).rejects.toMatchObject({ status: 422 });
  const unusedRunner = vi.fn();
  await chat.search('test', { brief: '', query: 'композиция' }, unusedRunner);
  expect(unusedRunner).not.toHaveBeenCalled();

  let release: (() => void) | undefined;
  const analyzed: string[] = [];
  const run: Runner = async <T>(request: LlmRequest) => {
    if (request.taskRu === 'Проверка качества референсов') return {
      data: { frames: [keep(accepted.id), reject(discarded.id), uncertain(unknown.id)] } as T, meta,
    };
    analyzed.push(...input(request).imageIdsInOrder);
    await new Promise<void>(resolve => { release = resolve; });
    return response<T>(request);
  };
  const audit = await library.qualityAudit();
  await library.startAnalysis(run, 3, { scopeDigest: audit.scopeDigest });
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(await library.list()).toEqual([]);
  expect(await library.get(accepted.id, 2)).toBeUndefined();
  expect(await library.readEligibleImage(accepted.id, 2)).toBeUndefined();
  expect(await library.qualityAudit()).toMatchObject({ pending: 0, kept: 1, rejected: 1, uncertain: 1, eligible: 0, retainedReferenced: 1 });
  release!();
  await finish(library);
  expect(analyzed).toEqual([accepted.id]);
  expect(await library.list()).toMatchObject([{ id: accepted.id, version: 3, eligible: true }]);
  expect(await library.get(accepted.id, 2)).toBeUndefined();
  expect(await library.get(discarded.id, 2, 'all')).toMatchObject({ id: discarded.id, version: 2, analysis: notes });
  expect(await library.readEligibleImage(discarded.id, 2)).toBeUndefined();
  expect(await readdir(source)).toContain('frame-1.jpg');
  const complete = await library.qualityAudit();
  expect(complete).toMatchObject({ total: 3, pendingWork: 0, eligible: 1, rejected: 1, uncertain: 1 });
  expect(complete.decisions[0]).toMatchObject({ criteriaVersion: REFERENCE_QUALITY_VERSION, promptHash: REFERENCE_QUALITY_PROMPT_HASH, model: 'fake-qc', imageSha256: expect.stringMatching(/^[a-f0-9]{64}$/), at: expect.any(String) });
});

it('holds the whole source behind its barrier through bounded QC batches, cancellation, late answers and restart', async () => {
  const { root, library } = await fixture(12);
  let qualityCalls = 0;
  let late: (() => void) | undefined;
  const run: Runner = async <T>(request: LlmRequest) => {
    expect(request.images!.length).toBeLessThanOrEqual(12);
    if (request.taskRu !== 'Проверка качества референсов') throw new Error('Templates must wait for the full cohort.');
    qualityCalls++;
    if (qualityCalls === 2) await new Promise<void>(resolve => { late = resolve; });
    return response<T>(request);
  };
  await library.startAnalysis(run, 12);
  await vi.waitFor(() => expect(late).toBeDefined());
  expect(await library.list()).toEqual([]);
  expect((await library.qualityAudit()).pending).toBe(12);
  await library.stopAnalysis();
  late!();
  expect(await library.list()).toEqual([]);
  const reopened = createReferenceLibrary(root);
  libraries.push(reopened);
  expect(await reopened.analysisStatus()).toMatchObject({ status: 'stopped', completed: 0 });
  expect(qualityCalls).toBe(2);
  await reopened.startAnalysis(async request => {
    expect(request.images!.length).toBeLessThanOrEqual(12);
    return response(request);
  }, 12);
  await finish(reopened);
  expect(await reopened.list()).toHaveLength(12);
});

it.each(['foreign', 'missing', 'repeated', 'cycle', 'unseen'] as const)('rejects %s QC output before template analysis or publication', async failure => {
  const { library, cards } = await fixture(2);
  let templates = 0;
  const run: Runner = async <T>(request: LlmRequest) => {
    if (request.taskRu !== 'Проверка качества референсов') { templates++; return response<T>(request); }
    const frames = failure === 'foreign' ? [keep('foreign'), keep(cards[1]!.id)]
      : failure === 'missing' ? [keep(cards[0]!.id)]
      : failure === 'repeated' ? [keep(cards[0]!.id), keep(cards[0]!.id)]
      : failure === 'cycle' ? cards.map((card, index) => ({ ...reject(card.id), reasonCode: 'duplicate', duplicateOf: cards[1 - index]!.id }))
      : [{ ...reject(cards[0]!.id), reasonCode: 'duplicate', duplicateOf: 'unseen-keep' }, keep(cards[1]!.id)];
    return { data: { frames } as T, meta };
  };
  await library.startAnalysis(run, 2);
  await finish(library, 'error');
  expect(templates).toBe(0);
  expect(await library.list()).toEqual([]);
  expect(await library.analysisStatus()).toMatchObject({ inputTokens: 20, outputTokens: 10, completed: 0 });
});

it.each(['quality', 'analysis'] as const)('fails closed when image bytes change during %s inference', async phase => {
  const { source, jpeg, cards, library } = await fixture(1);
  let templates = 0;
  const run: Runner = async <T>(request: LlmRequest) => {
    const quality = request.taskRu === 'Проверка качества референсов';
    if (!quality) templates++;
    if ((phase === 'quality' && quality) || (phase === 'analysis' && !quality)) {
      await writeFile(path.join(source, 'frame-0.jpg'), Buffer.concat([jpeg, Buffer.from('changed bytes')]));
    }
    return response<T>(request);
  };
  await library.startAnalysis(run, 1);
  await finish(library, 'error');
  expect(templates).toBe(phase === 'analysis' ? 1 : 0);
  expect(await library.list()).toEqual([]);
  expect(await library.readEligibleImage(cards[0]!.id, 2)).toBeUndefined();
  expect((await library.qualityAudit()).pending).toBe(1);
});

it('deletes unreferenced rejected JPEGs and never resurrects their stable tombstones on reimport', async () => {
  const { root, jpeg, library } = await fixture(1, false);
  const body = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(jpeg); controller.close(); } });
  const [card] = await library.importFile('end-card.jpg', body());
  const run: Runner = async <T>(request: LlmRequest) => ({ data: { frames: input(request).candidateIds.map(reject) } as T, meta });
  await library.startAnalysis(run, 2);
  await finish(library);
  const directory = path.join(root, 'sources', sha256(jpeg));
  expect(await readdir(directory)).toEqual(['cards.json']);
  const [again] = await library.importFile('same-content.jpg', body());
  expect(again).toMatchObject({ id: card!.id, quality: { status: 'reject' }, eligible: false });
  expect(await readdir(directory)).toEqual(['cards.json']);
  expect(await library.get(card!.id)).toBeUndefined();
  await writeFile(path.join(directory, 'frame-cover.jpg'), jpeg);
  const reopened = createReferenceLibrary(root);
  expect(await reopened.list()).toEqual([]);
  expect(await readdir(directory)).toEqual(['cards.json']);
  expect(await reopened.get(card!.id, undefined, 'all')).toMatchObject({ quality: { status: 'reject' } });
});

it('initializes rejected cleanup before the first edit lock after restart', async () => {
  const { root, source, library, cards, jpeg } = await fixture(2);
  await library.startAnalysis(async <T>(request: LlmRequest) => request.taskRu === 'Проверка качества референсов'
    ? { data: { frames: input(request).candidateIds.map((id, index) => index === 0 ? keep(id) : reject(id)) } as T, meta }
    : response<T>(request), 2);
  await finish(library);
  await writeFile(path.join(source, 'frame-1.jpg'), jpeg);
  const restarted = createReferenceLibrary(root);
  const edited = await restarted.edit(cards[0]!.id, { tags: ['updated'] });
  expect(edited?.tags).toEqual(['updated']);
  expect(await readdir(source)).not.toContain('frame-1.jpg');
  expect(await restarted.list()).toHaveLength(1);
}, 2000);

it.each(['canvas', 'canvas-ai', 'references/chat'] as const)('retains rejected media referenced from %s while denying new use', async folder => {
  const { dir, source, library, cards } = await fixture(1);
  await mkdir(path.join(dir, folder), { recursive: true });
  await writeFile(path.join(dir, folder, 'retained.json'), JSON.stringify({ selection: [{ id: cards[0]!.id, version: 2 }] }));
  await library.startAnalysis(async <T>(request: LlmRequest) => ({ data: { frames: input(request).candidateIds.map(reject) } as T, meta }), 1);
  await finish(library);
  expect(await readdir(source)).toContain('frame-0.jpg');
  expect(await library.get(cards[0]!.id, 2)).toBeUndefined();
  expect(await library.get(cards[0]!.id, 2, 'all')).toMatchObject({ analysis: notes, quality: { status: 'reject', retainedBecauseReferenced: true } });
});

it('rechecks uncertain decisions only after an explicit retry click and rejects a stale owner scope before AI', async () => {
  const { library, source } = await fixture(1);
  await library.startAnalysis(async <T>(request: LlmRequest) => ({ data: { frames: input(request).candidateIds.map(uncertain) } as T, meta }), 1);
  await finish(library);
  const unused = vi.fn();
  expect(await library.startAnalysis(unused)).toMatchObject({ status: 'done', total: 0 });
  expect(unused).not.toHaveBeenCalled();
  const audit = await library.qualityAudit();
  expect(audit).toMatchObject({ pendingWork: 0, uncertain: 1 });
  const manifest = path.join(source, 'cards.json');
  const stored = JSON.parse(await readFile(manifest, 'utf8'));
  stored.frames[0].versions.push({ folder: 'graphics', tags: ['manual'], analysis: notes });
  await writeFile(manifest, JSON.stringify(stored));
  await expect(library.startAnalysis(unused, 1, { scopeDigest: audit.scopeDigest, retryUncertain: true })).rejects.toMatchObject({ status: 409 });
  expect(unused).not.toHaveBeenCalled();
  const current = await library.qualityAudit();
  await library.startAnalysis(async request => response(request), 1, { scopeDigest: current.scopeDigest, retryUncertain: true });
  await finish(library);
  expect(await library.list()).toHaveLength(1);
});

it('blocks known legacy versions through real Canvas preview and start routes until an eligible version is selected', async () => {
  const { dir, library, cards } = await fixture(1);
  const flows = createFlows(dir);
  const base = await flows.create('QC Canvas regression');
  const node = (id: string, type: string, extra = {}) => CanvasNodeSchema.parse({ id, type, x: 0, y: 0, ...extra });
  const flow = (await flows.save(base.id, {
    ...base,
    nodes: [node('comment', 'comment', { text: 'Композиция.' }), node('refs', 'references', { libraryRefs: [{ id: cards[0]!.id, version: 2, role: 'Композиция' }] }), node('ai', 'ai', { targetGeneratorId: 'gen' }), node('gen', 'generator', { modelId: 'higgsfield/soul-2' })],
    edges: [{ id: 'context', from: 'comment', to: 'refs', port: 'context' }, { id: 'refs-ai', from: 'refs', to: 'ai', port: 'libraryRefs' }],
  }))!;
  const forbidden = vi.fn(async () => { throw new Error('Canvas reads and blocked starts must not invoke inference.'); });
  const app = createApp({ rootDir: path.resolve(import.meta.dirname, '../..'), dataDir: dir, referenceLibrary: 'private', runLlm: forbidden });
  const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };
  const preview = () => app.request(`/api/canvas-ai/preview?flowId=${flow.id}&nodeId=ai`, { headers });
  expect(await (await preview()).json()).toMatchObject({ error: 'LIBRARY_REF_UNAVAILABLE' });
  const start = await app.request('/api/canvas-ai/runs', { method: 'POST', headers, body: JSON.stringify({
    flowId: flow.id, nodeId: 'ai', stage: 'idea', requestId: randomUUID(), flow, previewDigest: 'a'.repeat(64), consent: true,
  }) });
  expect(start.status).toBe(409);
  expect(await start.json()).toMatchObject({ error: 'LIBRARY_REF_UNAVAILABLE' });
  await library.startAnalysis(async request => response(request), 1);
  await finish(library);
  expect((await preview()).status).toBe(409);
  const accepted = (await library.list())[0]!;
  await flows.save(flow.id, { ...flow, nodes: flow.nodes.map(item => item.id === 'refs' ? { ...item, libraryRefs: [{ id: accepted.id, version: accepted.version, role: 'Композиция' }] } : item) });
  expect((await preview()).status).toBe(200);
  expect(forbidden).not.toHaveBeenCalled();
});
