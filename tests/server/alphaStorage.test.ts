import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { newProject } from '../../src/core/model/project.ts';
import { createStore } from '../../src/server/storage/fsStore.ts';
import { createSessions } from '../../src/server/storage/sessions.ts';
import { createLibrary } from '../../src/server/storage/library.ts';
import { createFlows } from '../../src/server/storage/flows.ts';
import { acquireDataLock } from '../../src/server/storage/dataLock.ts';
import { createProductionRuntime } from '../../src/server/production/runtime.ts';
import { DEMO_INPUT } from '../../src/core/production/model.ts';
import { sceneDraft, promptPlan, SCRIPT } from '../production/fixtures.ts';
import type { Runner } from '../../src/server/llm/tasks/write.ts';

const dirs: string[] = [];
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), 'sp-alpha-storage-')); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('B01: concurrent saves of one revision have one winner and the same payload on disk', async () => {
  const store = createStore(await directory());
  const project = await store.write('race', newProject('race', 'Start'), null);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.write('race', { ...project, title: `Edit ${i}` }, project.rev)));
  const successful = results.filter((r) => r.status === 'fulfilled');
  expect(successful).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'CONFLICT')).toBe(true);
  expect(await store.read('race')).toEqual(successful[0]!.value);
});

it('B01: concurrent sessions, favorites and folder edits all survive reopening', async () => {
  const dir = await directory(); const sessions = createSessions(dir); const library = createLibrary(dir);
  await Promise.all(Array.from({ length: 8 }, (_, i) => sessions.create('image', `Session ${i}`)));
  expect(await createSessions(dir).list()).toHaveLength(8);
  const ids = Array.from({ length: 8 }, (_, i) => `m-test-${i}abcdef`);
  await Promise.all(ids.map((id) => library.setFavorite(id, true)));
  expect((await createLibrary(dir).favorites()).sort()).toEqual(ids.sort());
  await Promise.all(ids.map((id, i) => library.updateFolders((folders) => [...folders, { id: `d-folder-${i}abc`, name: id, mediaIds: [], createdAt: '2026-10-14T00:00:00Z' }])));
  expect(await createLibrary(dir).folders()).toHaveLength(8);
});

it('B01: a second server cannot own the same data directory', async () => {
  const dir = await directory(); const release = await acquireDataLock(dir);
  await expect(acquireDataLock(dir)).rejects.toThrow('уже используется');
  await release(); const releaseAgain = await acquireDataLock(dir); await releaseAgain();
});

it('B02/B13/B15: revisions reject stale writes, invalid graphs do not save, deletion is recoverable', async () => {
  const dir = await directory(); const flows = createFlows(dir); const flow = await flows.create('Example');
  const updated = await flows.save(flow.id, { ...flow, name: 'Kept' });
  await expect(flows.save(flow.id, { ...flow, name: 'Lost' })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await flows.save(flow.id, { ...updated, viewport: { x: 0, y: 0, zoom: 0 } })).toBeNull();
  expect(await flows.get(flow.id)).toEqual(updated);
  expect(await flows.remove(flow.id)).toBe(true);
  expect(await flows.get(flow.id)).toBeUndefined();
  expect(await createFlows(dir).restore(flow.id)).toEqual(updated);
});

it('B04: a corrupt series does not block startup or healthy series; the damaged file is retained', async () => {
  const dir = await directory(); const runtime = createProductionRuntime({ dataDir: dir, delayMs: 1 });
  const healthy = await runtime.create(DEMO_INPUT);
  const bad = path.join(dir, 'production-mock/pr-broken-abcdef.json');
  await mkdir(path.dirname(bad), { recursive: true }); await writeFile(bad, '{');
  await writeFile(path.join(dir, 'production-mock/pr-invalid-abcdef.json'), JSON.stringify({ ...healthy, id: 'pr-invalid-abcdef', shots: [null] }));
  try {
    await runtime.start(); await runtime.tick();
    expect(await runtime.list()).toHaveLength(1);
    expect((await runtime.get(healthy.id)).id).toBe(healthy.id);
    expect(runtime.issues()).toHaveLength(2);
    expect(await readFile(bad, 'utf8')).toBe('{');
  } finally { runtime.stop(); }
});

it('a corrupt production flow cannot be silently replaced by the next handoff', async () => {
  const dir = await directory(); const flows = createFlows(dir);
  const healthy = await flows.create('Healthy');
  const id = 'f-production-broken';
  const file = path.join(dir, 'canvas', `${id}.json`);
  await writeFile(file, '{');
  await expect(flows.ensureProduction(id, 'Replacement', flow => flow)).rejects.toMatchObject({ code: 'INVALID' });
  expect(await readFile(file, 'utf8')).toBe('{');
  expect((await flows.list()).map(flow => flow.id)).toEqual([healthy.id]);
});

it('B06: concurrent/replayed create requests keep one run and two text calls, including after restart', async () => {
  const dir = await directory(); let calls = 0;
  const runner: Runner = async <T>() => ({ data: (calls++ === 0 ? sceneDraft() : promptPlan()) as T, meta: { model: 'fake', inputTokens: 1, outputTokens: 1, durationMs: 1, turns: 1 } });
  const runtime = createProductionRuntime({ dataDir: dir, runLlm: runner });
  const input = { ...DEMO_INPUT, script: SCRIPT, planningMode: 'codex' as const, requestId: 'one-request-abcdef' };
  const results = await Promise.all(Array.from({ length: 4 }, () => runtime.create(input)));
  await runtime.waitForPreparation(results[0]!.id);
  expect(new Set(results.map((r) => r.id)).size).toBe(1); expect(calls).toBe(2);
  const restarted = createProductionRuntime({ dataDir: dir, runLlm: runner });
  expect((await restarted.create(input)).id).toBe(results[0]!.id);
  expect(calls).toBe(2);
  await expect(restarted.create({ ...input, title: 'Different' })).rejects.toMatchObject({ code: 'CONFLICT' });
});
