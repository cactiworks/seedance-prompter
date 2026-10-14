import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceRun, applyRunAction, newRun } from '../../src/core/production/engine.ts';
import { DEMO_INPUT, type ProductionRun } from '../../src/core/production/model.ts';
import { createApp, HOST, PORT, CLIENT_HEADER } from '../../src/server/app.ts';
import { createProductionRuntime } from '../../src/server/production/runtime.ts';

const dirs: string[] = [];
const dataDir = (): string => { const dir = mkdtempSync(path.join(tmpdir(), 'production-test-')); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function advance(run: ProductionRun, count = 20): ProductionRun {
  let next = run;
  for (let n = 0; n < count; n++) next = advanceRun(next, 10_000 + n * 100, 1);
  return next;
}
const prepared = (scenario: 'normal' | 'repair' = 'normal'): ProductionRun => advance(newRun('pr-demo-123', { ...DEMO_INPUT, scenario }, 0, 1));

describe('production mock gates and immutable revisions', () => {
  it('stops indefinitely at photo approval, then independently at video approval', () => {
    let run = prepared();
    expect(run.shots.every((s) => s.step === 'photoReview')).toBe(true);
    expect(run.artifacts).toHaveLength(3);
    expect(advance(run).artifacts).toHaveLength(3);
    run = applyRunAction(run, { type: 'approvePhotos', rev: run.rev, ids: run.shots.map((s) => s.photoId!) }, 0, 1);
    run = advance(run);
    expect(run.shots.every((s) => s.step === 'videoReview')).toBe(true);
    expect(run.artifacts.filter((a) => a.kind === 'final')).toHaveLength(0);
    expect(advance(run).artifacts).toHaveLength(6);
    run = applyRunAction(run, { type: 'approveVideos', rev: run.rev, ids: run.shots.map((s) => s.videoId!) }, 0, 1);
    run = advance(run);
    expect(run.shots.every((s) => s.step === 'ready')).toBe(true);
    expect(run.artifacts.every((a) => a.taskId.startsWith('mock-') && a.cost === 0)).toBe(true);
  });
  it('partial acceptance advances only selected branches and blocks QC failures', () => {
    let run = prepared('repair');
    const good = run.shots[0]!.photoId!;
    const bad = run.shots[1]!.photoId!;
    expect(() => applyRunAction(run, { type: 'approvePhotos', rev: run.rev, ids: [good, bad] }, 0, 1)).toThrow('проверенные');
    expect(run.approvals).toHaveLength(0);
    run = applyRunAction(run, { type: 'approvePhotos', rev: run.rev, ids: [good] }, 0, 1);
    run = advance(run);
    expect(run.shots.map((s) => s.step)).toEqual(['videoReview', 'photoReview', 'photoReview']);
    expect(run.artifacts.filter((a) => a.kind === 'video')).toHaveLength(1);
  });
  it('photo editing preserves source/history and invalidates downstream approvals', () => {
    let run = prepared();
    const original = structuredClone(run.artifacts[0]!);
    run = applyRunAction(run, { type: 'approvePhotos', rev: run.rev, ids: [original.id] }, 0, 1);
    run = advance(run);
    const video = run.shots[0]!.videoId!;
    run = applyRunAction(run, { type: 'approveVideos', rev: run.rev, ids: [video] }, 0, 1);
    run = advance(run);
    run = applyRunAction(run, { type: 'edit', rev: run.rev, shotId: 'shot-1', sourceId: original.id, note: 'Изменить деталь' }, 0, 1);
    expect(run.shots[0]).toMatchObject({ acceptedPhotoId: null, acceptedVideoId: null, videoId: null, finalId: null });
    run = advance(run);
    expect(run.artifacts.find((a) => a.id === original.id)).toEqual(original);
    expect(run.artifacts.find((a) => a.id === run.shots[0]!.photoId)).toMatchObject({ version: 2, sourceId: original.id });
    expect(run.shots[0]!.step).toBe('photoReview');
    expect(run.approvals.map((a) => a.artifactId)).toEqual([original.id, video]);
    expect(() => applyRunAction(run, { type: 'approveVideos', rev: run.rev, ids: [video] }, 0, 1)).toThrow();
    expect(() => applyRunAction(run, { type: 'edit', rev: run.rev, shotId: 'shot-1', sourceId: original.id, note: 'устаревшее' }, 0, 1)).toThrow();
  });
  it('pause freezes mock progress; failure affects one branch and retry resumes that step', () => {
    let run = advanceRun(newRun('pr-demo-123', DEMO_INPUT, 0, 1), 100, 1);
    run = applyRunAction(run, { type: 'pause', rev: run.rev }, 101, 1);
    expect(advanceRun(run, 10000, 1)).toBe(run);
    run = applyRunAction(run, { type: 'resume', rev: run.rev }, 102, 1);
    run = applyRunAction(run, { type: 'simulateFailure', rev: run.rev, shotId: 'shot-1' }, 103, 1);
    run = advance(run);
    expect(run.shots[0]!.step).toBe('photos');
    expect(run.shots[1]!.step).toBe('photoReview');
    run = applyRunAction(run, { type: 'retry', rev: run.rev, shotId: 'shot-1' }, 104, 1);
    run = advance(run);
    expect(run.shots[0]!.step).toBe('photoReview');
    expect(run.artifacts.filter((a) => a.shotId === 'shot-1')).toHaveLength(1);
  });
});

describe('durable mock API boundary', () => {
  it('serializes concurrent mutations and resumes after runtime replacement', async () => {
    const dir = dataDir(); let now = 0;
    const runtime = createProductionRuntime({ dataDir: dir, now: () => now, delayMs: 1 });
    const run = await runtime.create(DEMO_INPUT);
    const results = await Promise.allSettled([runtime.act(run.id, { type: 'pause', rev: run.rev }), runtime.act(run.id, { type: 'pause', rev: run.rev })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const restored = createProductionRuntime({ dataDir: dir, now: () => now, delayMs: 1 });
    let saved = await restored.get(run.id);
    expect(saved.paused).toBe(true);
    now = 100; await restored.tick(); expect((await restored.get(run.id)).planned).toBe(false);
    saved = await restored.act(run.id, { type: 'resume', rev: saved.rev });
    for (let i = 0; i < 12; i++) { now += 100; await restored.tick(); }
    expect((await restored.get(run.id)).shots.every((s) => s.step === 'photoReview')).toBe(true);
    expect(saved.id).toBe(run.id);
  });
  it('cannot switch to a paid provider; honors localhost guards, validates inputs, exports current artifacts only', async () => {
    const network = vi.fn(() => Promise.reject(new Error('No network allowed'))); vi.stubGlobal('fetch', network);
    const llm = vi.fn(() => Promise.reject(new Error('No LLM allowed')));
    const dir = dataDir(); let now = 0;
    const runtime = createProductionRuntime({ dataDir: dir, now: () => now, delayMs: 1 });
    const app = createApp({ rootDir: path.resolve(import.meta.dirname, '../..'), dataDir: dir, production: runtime, runLlm: llm });
    const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };
    const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post('/api/production', { ...DEMO_INPUT, mode: 'live' })).status).toBe(422);
    expect((await post('/api/production', { ...DEMO_INPUT, provider: 'higgsfield' })).status).toBe(422);
    expect((await app.request('/api/production', { method: 'POST', headers: { host: `${HOST}:${PORT}` }, body: '{}' })).status).toBe(403);
    const response = await post('/api/production', DEMO_INPUT); expect(response.status).toBe(201);
    let run = await response.json() as ProductionRun;
    expect((await app.request('/api/production', { headers })).status).toBe(200);
    for (let i = 0; i < 12; i++) { now += 100; await runtime.tick(); }
    run = await runtime.get(run.id);
    expect((await post(`/api/production/${run.id}/actions`, { type: 'approveVideos', rev: run.rev, ids: [run.shots[0]!.photoId] })).status).toBe(422);
    const action = { type: 'approvePhotos', rev: run.rev, ids: [run.shots[0]!.photoId] };
    expect((await post(`/api/production/${run.id}/actions`, action)).status).toBe(200);
    expect((await post(`/api/production/${run.id}/actions`, action)).status).toBe(409);
    const manifest = await app.request(`/api/production/${run.id}/manifest`, { headers });
    expect((await manifest.json() as { artifacts: unknown[] }).artifacts).toHaveLength(1);
    expect(network).not.toHaveBeenCalled(); expect(llm).not.toHaveBeenCalled();
  });
});
