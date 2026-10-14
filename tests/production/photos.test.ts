import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductionRuntime, type ProductionRuntime } from '../../src/server/production/runtime.ts';
import { createGenRuntime, type GenRuntime } from '../../src/server/gen/runtime.ts';
import { GenError, type GenProvider } from '../../src/server/gen/provider.ts';
import type { Runner } from '../../src/server/llm/tasks/write.ts';
import { DEMO_INPUT } from '../../src/core/production/model.ts';
import { PhotoStartSchema, quotePhotos } from '../../src/core/production/photos.ts';
import type { CharacterSelection } from '../../src/core/production/character.ts';
import { SoulIdError } from '../../src/server/production/soulId.ts';
import { productionRoutes } from '../../src/server/production/routes.ts';
import { createCharacters } from '../../src/server/production/characters.ts';
import { SCRIPT, sceneDraft, promptPlan } from './fixtures.ts';

const png = readFileSync(new URL('../../src/web/public/production-mock/shot-1.png', import.meta.url));
const resources: { dir: string; rt: ProductionRuntime; gen: GenRuntime }[] = [];
const identity: CharacterSelection = { id: 'ch-identity-123', name: 'Тестовый персонаж', referenceId: '11111111-1111-4111-8111-111111111111', modelVersion: 'v2', selectedAt: new Date(0).toISOString() };
async function setup(count = 2, patch: Partial<GenProvider> = {}, character: CharacterSelection | null = identity) {
  const dir = mkdtempSync(path.join(tmpdir(), 'production-photos-'));
  let clock = 100_000;
  let failDownload = false;
  const submit = vi.fn(async (_model: string, _input: Record<string, unknown>) => `task-${submit.mock.calls.length}`);
  const provider: GenProvider = {
    id: 'higgsfield', hasKey: () => true, submit, freshUrl: async () => null,
    upload: vi.fn(async () => 'https://test.invalid/scene.png'),
    poll: async () => ({ state: 'success', providerState: 'completed', urls: ['https://test.invalid/result.png'], creditsConsumed: null, failMsg: null }),
    ...patch,
  };
  const gen = createGenRuntime({ dataDir: dir, providers: { higgsfield: provider }, now: () => clock,
    fetch: (async () => failDownload ? new Response('offline', { status: 503 }) : new Response(png, { headers: { 'content-type': 'image/png' } })) as typeof fetch,
  });
  const calls: unknown[] = [];
  const runLlm: Runner = async <T>(request: unknown) => { calls.push(request); return { data: (calls.length === 1 ? sceneDraft(count) : promptPlan(count)) as T, meta: { model: 'fixture', durationMs: 1, inputTokens: 10, outputTokens: 10, turns: 1 } }; };
  const rt = createProductionRuntime({ dataDir: dir, gen, runLlm, now: () => clock, delayMs: 1 });
  resources.push({ dir, rt, gen });
  const created = await rt.create({ ...DEMO_INPUT, script: SCRIPT, planningMode: 'codex', mode: 'photos', characterId: character?.id ?? null }, character);
  await rt.waitForPreparation(created.id);
  const get = () => rt.get(created.id);
  const input = async () => { const run = await get(); return { rev: run.rev, requestId: crypto.randomUUID(), confirmUsd: quotePhotos(run).usd, refsConsent: true as const }; };
  const cycle = async () => { clock += 60_000; await gen.tick(); await rt.tick(); };
  return { rt, gen, dir, provider, submit, calls, id: created.id, get, input, cycle, failDownload: (value: boolean) => { failDownload = value; } };
}
afterEach(() => { for (const { dir, rt, gen } of resources.splice(0)) { rt.stop(); gen.stop(); rmSync(dir, { recursive: true, force: true }); } vi.unstubAllGlobals(); });

describe('real photos with injected providers only', () => {
  it('does not produce placeholders or submit before exact price and consent; deduplicates double clicks', async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) await s.cycle();
    expect((await s.get()).artifacts).toEqual([]); expect(s.submit).not.toHaveBeenCalled();
    const input = await s.input();
    expect(input.confirmUsd).toBe(0.018); // master + 2 planned shots
    expect(PhotoStartSchema.safeParse({ ...input, refsConsent: false }).success).toBe(false);
    await expect(s.rt.photos.start(s.id, { ...input, confirmUsd: 0 })).rejects.toThrow('Стоимость');
    await expect(s.rt.photos.start(s.id, { ...input, rev: input.rev - 1 })).rejects.toThrow('Серия изменилась');
    await expect(s.rt.photos.start(s.id, { ...input, refsConsent: false as true })).rejects.toThrow('согласие');
    expect(s.submit).not.toHaveBeenCalled();
    await Promise.all([s.rt.photos.start(s.id, input), s.rt.photos.start(s.id, input)]);
    await Promise.all([s.rt.tick(), s.rt.tick()]);
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect((await s.get()).photos!.requests).toHaveLength(1);
    await expect(s.rt.setCharacter(s.id, (await s.get()).rev, null)).rejects.toThrow('зафиксирован');
  });
  it('uses a master scene + Soul ID for every shot and gates only downloaded photos; approvals never start video', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
    const s = await setup(); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 12; i++) await s.cycle();
    let run = await s.get();
    expect(s.submit).toHaveBeenCalledTimes(3);
    expect(s.submit.mock.calls[0]).toEqual(['higgsfield-ai/soul/v2/standard', expect.objectContaining({ prompt: promptPlan().masterPrompt, custom_reference_id: identity.referenceId, enhance_prompt: false })]);
    expect(s.submit.mock.calls[1]).toEqual(['higgsfield-ai/soul/v2/image-to-image', expect.objectContaining({ image_url: 'https://test.invalid/scene.png', custom_reference_id: identity.referenceId, enhance_prompt: true })]);
    expect(s.provider.upload).toHaveBeenCalledTimes(2);
    expect(run.artifacts).toHaveLength(3); expect(run.photos!.status).toBe('review');
    expect(run.shots.every((shot) => shot.step === 'photoReview')).toBe(true);
    expect(run.artifacts.every((a) => a.qc === 'review' && a.mediaId && a.url.startsWith('/api/library/'))).toBe(true);
    const ids = run.shots.map((shot) => shot.photoId!);
    expect(run.artifacts.find((a) => a.id === ids[0])!.sourceId).toBe(run.photos!.masterArtifactId);
    await expect(s.rt.act(s.id, { type: 'approvePhotos', rev: run.rev, ids: [run.photos!.masterArtifactId!] })).rejects.toThrow('milestone');
    run = await s.rt.act(s.id, { type: 'approvePhotos', rev: run.rev, ids });
    expect(run.photos!.status).toBe('complete');
    expect(run.shots.every((shot) => shot.step === 'ready')).toBe(true);
    for (let i = 0; i < 4; i++) await s.cycle();
    expect(s.submit).toHaveBeenCalledTimes(3);
    await expect(s.rt.act(s.id, { type: 'approveVideos', rev: run.rev, ids })).rejects.toThrow('отключены');
    const app = productionRoutes(s.rt, createCharacters({ dataDir: s.dir }));
    const manifest = await (await app.request(`/${s.id}/manifest`)).json() as { mode: string; artifacts: unknown[] };
    expect(manifest.mode).toBe('photos'); expect(manifest.artifacts).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('pause stops new submissions, keeps known jobs and requires a new price gate for remaining slots', async () => {
    const s = await setup(); await s.rt.photos.start(s.id, await s.input()); await s.rt.tick();
    let run = await s.get(); await s.rt.act(s.id, { type: 'pause', rev: run.rev });
    for (let i = 0; i < 4; i++) await s.cycle();
    expect(s.submit).toHaveBeenCalledTimes(1); expect((await s.get()).photos!.masterArtifactId).not.toBeNull();
    run = await s.get(); await s.rt.act(s.id, { type: 'resume', rev: run.rev });
    await s.cycle(); expect(s.submit).toHaveBeenCalledTimes(1);
    expect((await s.input()).confirmUsd).toBe(0.012);
    await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 8; i++) await s.cycle();
    expect(s.submit).toHaveBeenCalledTimes(3);
  });
  it('unknown submission stops the chain and cannot be resubmitted by start or retry', async () => {
    const paid = vi.fn(async () => { throw new GenError('NETWORK', 'network'); });
    const s = await setup(2, { submit: paid }); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 8; i++) await s.cycle();
    const run = await s.get();
    expect(paid).toHaveBeenCalledTimes(1); expect(run.photos!.status).toBe('stopped'); expect(run.artifacts).toHaveLength(0);
    expect(run.photos!.items[0]!.status).toBe('unknown');
    await expect(s.rt.photos.start(s.id, await s.input())).rejects.toThrow('Повтора');
    await expect(s.rt.photos.retry(s.id, run.photos!.items[0]!.jobId!)).rejects.toMatchObject({ code: 'SUBMIT_UNKNOWN' });
  });
  it('a download failure never reaches the milestone; download-only retry does not regenerate', async () => {
    const s = await setup(1); s.failDownload(true); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 15; i++) await s.cycle();
    let run = await s.get(); expect(run.artifacts).toHaveLength(0); expect(run.photos!.items[0]!.status).toBe('download_failed');
    expect(s.submit).toHaveBeenCalledTimes(1);
    s.failDownload(false); await s.rt.photos.retry(s.id, run.photos!.items[0]!.jobId!);
    for (let i = 0; i < 3; i++) await s.cycle();
    run = await s.get(); expect(run.photos!.masterArtifactId).not.toBeNull(); expect(s.submit).toHaveBeenCalledTimes(1);
    await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 5; i++) await s.cycle();
    expect((await s.get()).shots[0]!.step).toBe('photoReview'); expect(s.submit).toHaveBeenCalledTimes(2);
  });
  it('restart recovers a job by its durable tag, never resends an ambiguous intent and stops pending work', async () => {
    const s = await setup(1); await s.rt.photos.start(s.id, await s.input()); await s.rt.tick();
    const run = await s.get(); run.photos!.items[0]!.jobId = null; // crash between job write and series write
    writeFileSync(path.join(s.dir, 'production-mock', `${s.id}.json`), JSON.stringify(run));
    const recovered = createProductionRuntime({ dataDir: s.dir, gen: s.gen });
    await recovered.start(); recovered.stop();
    expect((await recovered.get(s.id)).photos!.items[0]!.jobId).toBe((await s.gen.jobs.all())[0]!.id);
    expect((await recovered.get(s.id)).photos!.status).toBe('stopped');
    for (let i = 0; i < 5; i++) await s.cycle();
    expect(s.submit).toHaveBeenCalledTimes(1);
    const ambiguous = await s.get(); ambiguous.photos!.items[1]!.status = 'submitting';
    writeFileSync(path.join(s.dir, 'production-mock', `${s.id}.json`), JSON.stringify(ambiguous));
    const next = createProductionRuntime({ dataDir: s.dir, gen: s.gen }); await next.start(); next.stop();
    expect((await next.get(s.id)).photos!.items[1]!.status).toBe('unknown');
    expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it('HTTP cost gate rejects missing consent and rechecks selected Soul ID before authorizing any job', async () => {
    const s = await setup(); const characters = createCharacters({ dataDir: s.dir });
    const select = vi.spyOn(characters, 'select').mockRejectedValue(new SoulIdError('Soul ID недоступен.', 422));
    const app = productionRoutes(s.rt, characters);
    const post = (body: object) => app.request(`/${s.id}/photos/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const input = await s.input();
    expect((await post({ ...input, refsConsent: false })).status).toBe(422); expect(select).not.toHaveBeenCalled();
    expect((await post(input)).status).toBe(422); expect(select).toHaveBeenCalledWith(identity.id);
    select.mockResolvedValue({ ...identity, referenceId: '22222222-2222-4222-8222-222222222222' });
    expect((await post(input)).status).toBe(409);
    await s.cycle(); expect(s.submit).not.toHaveBeenCalled(); expect((await s.get()).photos).toBeUndefined();
    select.mockResolvedValue(identity); expect((await post(input)).status).toBe(200);
    await s.rt.tick(); expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it('keeps a usable partial result on rejection and copies the plan without live state or LLM calls', async () => {
    let sent = 0;
    const paid = vi.fn(async () => { sent++; if (sent === 3) throw new GenError('NO_CREDITS', 'Баланс закончился'); return `task-${sent}`; });
    const s = await setup(3, { submit: paid }); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 15; i++) await s.cycle();
    let run = await s.get(); expect(paid).toHaveBeenCalledTimes(3); expect(run.photos!.status).toBe('stopped');
    expect(run.shots[0]!.step).toBe('photoReview'); expect(run.shots[1]!.photoId).toBeNull(); expect(run.photos!.items[3]!.status).toBe('pending');
    run = await s.rt.act(s.id, { type: 'approvePhotos', rev: run.rev, ids: [run.shots[0]!.photoId!] });
    const fresh = await s.rt.forkPhotos(s.id, run.rev, crypto.randomUUID());
    expect(fresh.photos).toBeUndefined(); expect(fresh.artifacts).toEqual([]); expect(fresh.approvals).toEqual([]);
    expect(s.calls).toHaveLength(2); expect((await s.get()).shots[0]!.acceptedPhotoId).not.toBeNull();
  });
  it('reuses old Codex plans without another LLM call, media or approvals; accepts old plans without masterPrompt', async () => {
    const s = await setup(1); const old = await s.get();
    old.mode = 'mock'; delete old.promptPlan!.masterPrompt;
    writeFileSync(path.join(s.dir, 'production-mock', `${s.id}.json`), JSON.stringify(old));
    const requestId = crypto.randomUUID();
    const fresh = await s.rt.forkPhotos(s.id, old.rev, requestId);
    expect(fresh.mode).toBe('photos'); expect(fresh.artifacts).toEqual([]); expect(fresh.approvals).toEqual([]); expect(fresh.photos).toBeUndefined();
    expect(fresh.preparation!.calls).toEqual([]); expect(fresh.scenePlan).toEqual(old.scenePlan); expect(s.calls).toHaveLength(2);
    expect((await s.rt.forkPhotos(s.id, old.rev, requestId)).id).toBe(fresh.id);
    await s.rt.photos.start(fresh.id, { rev: fresh.rev, requestId: crypto.randomUUID(), confirmUsd: quotePhotos(fresh).usd, refsConsent: true });
    await s.rt.tick(); expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.submit.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ prompt: expect.stringContaining('Wide establishing') })]);
    expect((await s.get()).mode).toBe('mock');
  });
});
