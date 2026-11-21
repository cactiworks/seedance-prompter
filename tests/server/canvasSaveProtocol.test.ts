import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFlows, FlowMergeError } from '../../src/server/storage/flows.ts';
import { CanvasNodeSchema, type CanvasNode, type Flow } from '../../src/core/model/canvas.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';

const folders: string[] = [];
async function folder(): Promise<string> { const dir = await mkdtemp(path.join(tmpdir(), 'sp-canvas-save-')); folders.push(dir); return dir; }
afterEach(async () => { for (const dir of folders.splice(0)) await rm(dir, { force: true, recursive: true }); });
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const node = (id: string, type: CanvasNode['type'], extra: Partial<CanvasNode> = {}): CanvasNode => CanvasNodeSchema.parse({ id, type, x: 0, y: 0, ...extra });

it('PATCH is durable and idempotent after a lost acknowledgement', async () => {
  const dir = await folder(); const flows = createFlows(dir);
  const base = await flows.create('Initial');
  const first = { base, flow: { ...base, name: 'First tab' } };
  expect((await flows.patch(base.id, first))?.name).toBe('First tab');
  const current = (await flows.get(base.id))!;
  const second = { base: current, flow: { ...current, name: 'Second tab' } };
  expect((await flows.patch(base.id, second))?.name).toBe('Second tab');
  // Retrying the exact first envelope returns the latest canonical state and never reapplies it.
  expect((await createFlows(dir).patch(base.id, first))?.name).toBe('Second tab');
  expect((await flows.get(base.id))?.name).toBe('Second tab');
});

it('legacy draft migration is durable and replay does not overwrite newer server edits', async () => {
  const dir = await folder(); const flows = createFlows(dir);
  const base = await flows.create('Initial');
  const draft = { ...base, name: 'Recovered tab' };
  expect((await flows.archiveLegacy(draft))?.flow?.name).toBe('Recovered tab');
  const current = (await flows.get(base.id))!;
  const newer = { base: current, flow: { ...current, name: 'Server tab' } };
  await flows.patch(base.id, newer);
  expect((await createFlows(dir).archiveLegacy(draft))?.flow?.name).toBe('Server tab');
  expect((await flows.get(base.id))?.name).toBe('Server tab');
});

it('keeps receipt storage compact and ignores a torn trailing receipt after restart', async () => {
  const dir = await folder(); const flows = createFlows(dir); const base = await flows.create('Start');
  const first = { base, flow: { ...base, name: 'First edit' } };
  await flows.patch(base.id, first);
  const receipt = path.join(dir, 'canvas', 'receipts', `${base.id}.log`);
  await appendFile(receipt, '0'.repeat(20));
  const current = (await flows.get(base.id))!;
  const second = { base: current, flow: { ...current, name: 'Second edit' } };
  const restarted = createFlows(dir); await restarted.patch(base.id, second);
  expect((await createFlows(dir).patch(base.id, first))?.name).toBe('Second edit');
  expect((await createFlows(dir).patch(base.id, second))?.name).toBe('Second edit');
  expect(await readdir(path.join(dir, 'canvas', 'receipts'))).toEqual([`${base.id}.log`]);
  const valid = (await readFile(receipt, 'utf8')).split('\n').filter(line => /^[a-f0-9]{64}$/.test(line));
  expect(valid).toHaveLength(2);
});

it('merges delayed UI autosave with AI-created nodes and canonical projections', async () => {
  const flows = createFlows(await folder()); const empty = await flows.create('AI race');
  const base = (await flows.save(empty.id, { ...empty, nodes: [node('comment', 'comment', { text: 'Original' }), node('ai', 'ai')] }))!;
  const desired = { ...base, nodes: base.nodes.map(n => n.id === 'comment' ? { ...n, text: 'Still typing' } : { ...n, x: 100 }) };
  const projected = await flows.ensureProduction(base.id, '', current => ({ ...current, nodes: [...current.nodes.map(n => n.id === 'ai' ? { ...n, ai: { runId: 'run', status: 'ready', stage: 'idea', idea: null, prompt: null, errorRu: null } as const } : n), node('prompt', 'prompt', { text: 'Generated prompt' })] }));
  const saved = (await flows.patch(base.id, { base, flow: desired }))!;
  expect(saved.nodes.find(n => n.id === 'comment')?.text).toBe('Still typing');
  expect(saved.nodes.find(n => n.id === 'ai')).toMatchObject({ x: 100, ai: { runId: 'run', status: 'ready' } });
  expect(saved.nodes.find(n => n.id === 'prompt')?.text).toBe('Generated prompt');
  expect((await flows.listHistory(base.id)).some(entry => entry.rev === projected.rev)).toBe(true);
});

it('concurrent same-field edits retain the replaced version in server history', async () => {
  const flows = createFlows(await folder()); const base = await flows.create('Original');
  const first = (await flows.patch(base.id, { base, flow: { ...base, name: 'First tab' } }))!;
  const second = (await flows.patch(base.id, { base, flow: { ...base, name: 'Last caller' } }))!;
  expect(second.name).toBe('Last caller');
  const version = (await flows.listHistory(base.id)).find(entry => entry.rev === first.rev)!;
  expect((await flows.history(base.id, version.id))?.name).toBe('First tab');
});

it('server deletion wins over an old tab without losing edited content from that tab', async () => {
  const flows = createFlows(await folder()); const empty = await flows.create('Deletion');
  const base = (await flows.save(empty.id, { ...empty, nodes: [node('comment', 'comment', { text: 'Original' })] }))!;
  await flows.patch(base.id, { base, flow: { ...base, nodes: [] } });
  const incoming = { ...base, nodes: [{ ...base.nodes[0]!, text: 'Unsaved tab text' }] };
  expect((await flows.patch(base.id, { base, flow: incoming }))?.nodes).toEqual([]);
  const recovered = (await flows.listHistory(base.id)).find(entry => entry.kind === 'recovery')!;
  expect((await flows.history(base.id, recovered.id))?.nodes[0]?.text).toBe('Unsaved tab text');
});

it('retains an invalid concurrent DAG merge on the VPS without changing the valid graph', async () => {
  const flows = createFlows(await folder()); const empty = await flows.create('DAG race');
  const base = (await flows.save(empty.id, { ...empty, nodes: [node('a', 'resize'), node('b', 'resize')] }))!;
  const current = (await flows.patch(base.id, { base, flow: { ...base, edges: [{ id: 'a-b', from: 'a', to: 'b', port: 'media' }] } }))!;
  const desired: Flow = { ...base, edges: [{ id: 'b-a', from: 'b', to: 'a', port: 'media' }] };
  let caught: unknown;
  try { await flows.patch(base.id, { base, flow: desired }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(FlowMergeError);
  const failure = caught as FlowMergeError;
  expect(failure.current).toEqual(current);
  expect(await flows.get(base.id)).toEqual(current);
  expect(await flows.history(base.id, failure.historyId)).toEqual(desired);
});

it.each(['before canonical write', 'after canonical write'])('recovers a durable prepared save %s and seals its receipt before another mutation', async phase => {
  const dir = await folder(); const flows = createFlows(dir); const base = await flows.create('Before');
  const desired = { ...base, name: 'Journal result' }; const key = hash(['patch', base, desired]);
  await mkdir(path.join(dir, 'canvas', 'pending'), { recursive: true });
  await writeFile(path.join(dir, 'canvas', 'pending', `${base.id}.json`), JSON.stringify({ key, previousDigest: hash(base), next: desired, desired }));
  if (phase === 'after canonical write') await writeFile(path.join(dir, 'canvas', `${base.id}.json`), JSON.stringify({ ...desired, rev: (base.rev ?? 0) + 1 }));
  const restarted = createFlows(dir);
  const recovered = await restarted.get(base.id);
  expect(recovered?.name).toBe('Journal result');
  expect(await readdir(path.join(dir, 'canvas', 'pending'))).toEqual([]);
  await restarted.ensureProduction(base.id, '', current => ({ ...current, name: 'Subsequent server edit' }));
  expect((await restarted.patch(base.id, { base, flow: desired }))?.name).toBe('Subsequent server edit');
});

it('old legacy drafts without an acknowledged baseline are archived without replacing canonical state', async () => {
  const flows = createFlows(await folder()); const current = await flows.create('Canonical');
  const old = { ...current, rev: 0, name: 'Uncertain old draft' };
  expect((await flows.archiveLegacy(old))?.flow).toEqual(current);
  const entry = (await flows.listHistory(current.id)).find(value => value.kind === 'legacy')!;
  expect(await flows.history(current.id, entry.id)).toEqual(old);
  expect(await flows.list()).toHaveLength(1);
});

it('migrates known old draft edits against revision history while preserving server additions', async () => {
  const flows = createFlows(await folder()); const empty = await flows.create('Known baseline');
  const base = (await flows.save(empty.id, { ...empty, nodes: [node('comment', 'comment', { text: 'Old text' })] }))!;
  await flows.ensureProduction(base.id, '', current => ({ ...current, nodes: [...current.nodes, node('server', 'prompt', { text: 'AI text' })] }));
  const migrated = await flows.archiveLegacy({ ...base, nodes: [{ ...base.nodes[0]!, text: 'Recovered typing' }] });
  expect(migrated?.flow?.nodes.map(n => n.id)).toEqual(['comment', 'server']);
  expect(migrated?.flow?.nodes[0]?.text).toBe('Recovered typing');
});

it('retains fifty prior revisions and keeps archived legacy material outside that retention', async () => {
  const dir = await folder(); const flows = createFlows(dir); const base = await flows.create('Start');
  await flows.archiveLegacy({ ...base, rev: 0, name: 'Archived material' });
  for (let index = 0; index < 55; index++) await flows.ensureProduction(base.id, '', current => ({ ...current, name: `Revision ${index}` }));
  const history = await createFlows(dir).listHistory(base.id);
  expect(history.filter(entry => entry.kind === 'revision')).toHaveLength(50);
  expect(history.filter(entry => entry.kind === 'legacy')).toHaveLength(1);
});

it('manual history restore clears runtime pointers and reviews while retaining original snapshots', async () => {
  const flows = createFlows(await folder()); const empty = await flows.create('Review restore');
  const approval = { versionId: 'version', inputFingerprint: 'inputs', approvedAt: 'now' };
  const base = (await flows.save(empty.id, { ...empty, nodes: [node('ai', 'ai', { ai: { runId: 'running', status: 'running', stage: 'idea', idea: { id: 'version', text: 'Idea', inputFingerprint: 'inputs', createdAt: 'now', parentVersionId: null, approval }, prompt: null, errorRu: null } }), node('prompt', 'prompt', { aiApproval: approval }), node('photo', 'generator', { acceptedJobId: 'job', acceptedMediaId: 'media' })] }))!;
  const current = await flows.ensureProduction(base.id, '', value => ({ ...value, name: 'New name' }));
  const snapshot = (await flows.listHistory(base.id)).find(entry => entry.rev === base.rev)!;
  await expect(flows.restoreVersion(base.id, snapshot.id, base.rev)).rejects.toMatchObject({ code: 'CONFLICT' });
  const restored = (await flows.restoreVersion(base.id, snapshot.id, current.rev))!;
  expect(restored.nodes[0]?.ai).toMatchObject({ runId: null, status: 'interrupted', idea: { approval: null } });
  expect(restored.nodes[1]?.aiApproval).toBeUndefined();
  expect(restored.nodes[2]).toMatchObject({ acceptedJobId: null, acceptedMediaId: null });
  expect((await flows.history(base.id, snapshot.id))?.nodes[0]?.ai?.idea?.approval).toEqual(approval);
});

it('retries the same history restore after a lost response without overwriting newer work', async () => {
  const dir = await folder(); const flows = createFlows(dir); const original = await flows.create('Original');
  const current = await flows.ensureProduction(original.id, '', flow => ({ ...flow, name: 'Newer' }));
  const snapshot = (await flows.listHistory(original.id)).find(entry => entry.rev === original.rev)!;
  const requestId = 'restore-operation-abcdef';
  const restored = await flows.restoreVersion(original.id, snapshot.id, current.rev, requestId);
  expect(restored?.name).toBe('Original');
  await flows.ensureProduction(original.id, '', flow => ({ ...flow, name: 'Edited after restore' }));
  const replay = await createFlows(dir).restoreVersion(original.id, snapshot.id, current.rev, requestId);
  expect(replay?.name).toBe('Edited after restore');
  expect(await flows.get(original.id)).toEqual(replay);
});

it('HTTP PATCH saves large payloads, exposes server history and returns recoverable merge conflicts', async () => {
  const dir = await folder(); const flows = createFlows(dir); const base = await flows.create('HTTP flow');
  const app = createApp({ rootDir: path.join(import.meta.dirname, '../..'), dataDir: dir });
  const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };
  const request = (method: string, url: string, body?: unknown) => app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const save = await request('PATCH', `/api/canvas/flows/${base.id}`, { base, flow: { ...base, nodes: [node('large', 'comment', { text: 'текст'.repeat(20000) }), node('a', 'resize'), node('b', 'resize')] } });
  expect(save.status).toBe(200); const graph = await save.json() as Flow;
  expect(graph.nodes[0]?.text.length).toBe(100000);
  await request('PATCH', `/api/canvas/flows/${base.id}`, { base: graph, flow: { ...graph, edges: [{ id: 'a-b', from: 'a', to: 'b', port: 'media' }] } });
  const conflict = await request('PATCH', `/api/canvas/flows/${base.id}`, { base: graph, flow: { ...graph, edges: [{ id: 'b-a', from: 'b', to: 'a', port: 'media' }] } });
  expect(conflict.status).toBe(409); const detail = await conflict.json() as { historyId: string; current: Flow };
  expect(detail.current.edges).toHaveLength(1);
  expect((await request('GET', `/api/canvas/flows/${base.id}/history/${detail.historyId}`)).status).toBe(200);
  expect((await request('GET', `/api/canvas/flows/${base.id}/history`)).status).toBe(200);
  const restored = await request('POST', `/api/canvas/flows/${base.id}/history/${detail.historyId}/restore`, { rev: detail.current.rev });
  expect(restored.status).toBe(200); expect((await restored.json() as Flow).edges[0]?.id).toBe('b-a');
  expect((await request('POST', '/api/canvas/legacy-drafts', { flow: { ...graph, rev: 0 } })).status).toBe(200);
  expect((await request('PATCH', `/api/canvas/flows/${base.id}`, { base: graph, flow: { ...graph, id: 'f-other-flow' } })).status).toBe(422);
});
