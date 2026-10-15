import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { SCRIPT, sceneDraft, promptPlan, reviewReport, appearanceOutput } from './fixtures.ts';
import { ReviewReportSchema, validateReview, masterApproved } from '../../src/core/production/review.ts';
import type { LlmRequest } from '../../src/server/llm/codexCli/provider.ts';

const png = readFileSync(new URL('../../src/web/public/production-mock/shot-1.png', import.meta.url));
const resources: { dir: string; rt: ProductionRuntime; gen: GenRuntime }[] = [];
const identity: CharacterSelection = { id: 'ch-identity-123', name: 'Тестовый персонаж', referenceId: '11111111-1111-4111-8111-111111111111', modelVersion: 'v2', selectedAt: new Date(0).toISOString() };
async function setup(count = 2, patch: Partial<GenProvider> = {}, character: CharacterSelection | null = identity, reviewRunner?: Runner, masterRunner?: Runner, appearanceRunner?: Runner) {
  const dir = mkdtempSync(path.join(tmpdir(), 'production-photos-'));
  if (character) {
    mkdirSync(path.join(dir, 'characters'), { recursive: true }); mkdirSync(path.join(dir, 'uploads'), { recursive: true });
    const uploadIds = ['u-face-one', 'u-face-two', 'u-body-three'];
    for (const id of uploadIds) writeFileSync(path.join(dir, 'uploads', `${id}.png`), png);
    writeFileSync(path.join(dir, 'characters', `${character.id}.json`), JSON.stringify({ ...character, uploadIds, status: 'completed', createdAt: new Date(0).toISOString() }));
  }
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
  const calls: LlmRequest[] = [];
  const runLlm: Runner = async <T>(request: LlmRequest) => {
    calls.push(request);
    const critic = request.taskRu === 'Критик фотографий Production';
    const appearance = request.taskRu === 'Внешность персонажа Production';
    const reviewer = JSON.parse(request.user).scope === 'master' ? masterRunner : reviewRunner;
    if (critic && reviewer) return reviewer<T>(request);
    if (appearance && appearanceRunner) return appearanceRunner<T>(request);
    return { data: (critic ? reviewReport(JSON.parse(request.user).candidates.map((c: { artifactId: string }) => c.artifactId)) : appearance ? appearanceOutput(count) : request.taskRu === 'Режиссёр Production' ? sceneDraft(count) : promptPlan(count)) as T,
      meta: { model: 'fixture', durationMs: 1, inputTokens: 10, outputTokens: 10, turns: 1 } };
  };
  const rt = createProductionRuntime({ dataDir: dir, gen, runLlm, now: () => clock, delayMs: 1 });
  resources.push({ dir, rt, gen });
  const created = await rt.create({ ...DEMO_INPUT, script: SCRIPT, planningMode: 'codex', mode: 'photos', characterId: character?.id ?? null }, character);
  await rt.waitForPreparation(created.id);
  const get = () => rt.get(created.id);
  const input = async () => { const run = await get(); return { rev: run.rev, requestId: crypto.randomUUID(), confirmUsd: quotePhotos(run).usd, refsConsent: true as const, reviewConsent: true as const, masterGateConsent: true as const }; };
  const cycle = async (waitReview = true) => { clock += 60_000; await gen.tick(); await rt.tick(); await rt.appearance.wait(created.id); if (waitReview) await rt.review.wait(created.id); };
  const dispatch = async () => { await rt.tick(); await rt.appearance.wait(created.id); await rt.tick(); };
  return { dispatch, rt, gen, dir, provider, submit, calls, id: created.id, get, input, cycle, failDownload: (value: boolean) => { failDownload = value; } };
}
afterEach(async () => { for (const { dir, rt, gen } of resources.splice(0)) { rt.stop(); gen.stop(); for (const run of await rt.list()) { await rt.review.wait(run.id); await rt.appearance.wait(run.id); } rmSync(dir, { recursive: true, force: true }); } vi.unstubAllGlobals(); });

describe('real photos with injected providers only', () => {
  it('keeps rejected files and permits an explicit owner override without new media', async () => {
    const critic: Runner = async <T>(request: LlmRequest) => {
      const report = ReviewReportSchema.parse(reviewReport(JSON.parse(request.user).candidates.map((c: { artifactId: string }) => c.artifactId)));
      for (const result of report.results) { result.verdict = 'reject'; result.checks.shotMatch = 'fail'; }
      return { data: report as T, meta: { model: 'fixture', durationMs: 1, inputTokens: 10, outputTokens: 10, turns: 1 } };
    };
    const s = await setup(1, {}, identity, critic);
    await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 8; i++) await s.cycle();
    const run = await s.get(); const ids = run.shots.map(shot => shot.photoId!);
    expect(run.review?.report?.results.every(r => r.verdict === 'reject')).toBe(true);
    expect(run.shots.every(shot => !shot.acceptedPhotoId)).toBe(true);
    expect(await s.gen.library.get(run.artifacts[1]!.mediaId!)).toBeTruthy();
    const accepted = await s.rt.act(s.id, { type: 'approvePhotos', rev: run.rev, ids });
    expect(accepted.shots[0]!.acceptedPhotoId).toBe(ids[0]);
    expect(accepted.artifacts).toHaveLength(2); expect(s.submit).toHaveBeenCalledTimes(2);
  });

  it('does not produce placeholders or submit before exact price and consent; deduplicates double clicks', async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) await s.cycle();
    expect((await s.get()).artifacts).toEqual([]); expect(s.submit).not.toHaveBeenCalled();
    const input = await s.input();
    expect(input.confirmUsd).toBe(0.018); // master + 2 planned shots
    expect(PhotoStartSchema.safeParse({ ...input, refsConsent: false }).success).toBe(false);
    expect(PhotoStartSchema.safeParse({ ...input, reviewConsent: undefined }).success).toBe(false);
    await expect(s.rt.photos.start(s.id, { ...input, confirmUsd: 0 })).rejects.toThrow('Стоимость');
    await expect(s.rt.photos.start(s.id, { ...input, rev: input.rev - 1 })).rejects.toThrow('Серия изменилась');
    await expect(s.rt.photos.start(s.id, { ...input, refsConsent: false as true })).rejects.toThrow('согласие');
    expect(s.submit).not.toHaveBeenCalled();
    await Promise.all([s.rt.photos.start(s.id, input), s.rt.photos.start(s.id, input)]);
    await Promise.all([s.rt.tick(), s.rt.tick()]); await s.rt.appearance.wait(s.id); await s.rt.tick();
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
    expect(s.submit.mock.calls[0]).toEqual(['higgsfield-ai/soul/v2/standard', expect.objectContaining({ prompt: appearanceOutput().prompts.masterPrompt, custom_reference_id: identity.referenceId, enhance_prompt: false })]);
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
    const s = await setup(); await s.rt.photos.start(s.id, await s.input()); await s.dispatch();
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
    expect(run.review!.status).toBe('interrupted'); expect(s.calls).toHaveLength(3);
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
    const s = await setup(1); await s.rt.photos.start(s.id, await s.input()); await s.dispatch();
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
    await s.dispatch(); expect(s.submit).toHaveBeenCalledTimes(1);
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
    expect(s.calls).toHaveLength(5); expect((await s.get()).shots[0]!.acceptedPhotoId).not.toBeNull();
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
    await s.rt.photos.start(fresh.id, { rev: fresh.rev, requestId: crypto.randomUUID(), confirmUsd: quotePhotos(fresh).usd, refsConsent: true, reviewConsent: true, masterGateConsent: true });
    await s.rt.tick(); await s.rt.appearance.wait(fresh.id); await s.rt.tick(); expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.submit.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ prompt: expect.stringContaining(appearanceOutput().profile.anchorEn) })]);
    expect((await s.get()).mode).toBe('mock');
  });
});

describe('photo critic lifecycle and trust boundaries', () => {
  it('normalizes visible faces without identity to uncertain and rejects missing IDs or skipped core criteria', () => {
    const report = ReviewReportSchema.parse(reviewReport(['a']));
    expect(validateReview(report, ['a'], 0).results[0]!.verdict).toBe('uncertain');
    report.results[0]!.checks.likeness = 'not_visible';
    expect(validateReview(report, ['a'], 0).results[0]!.checks.likeness).toBe('uncertain');
    report.results[0]!.checks.face = 'not_visible';
    expect(validateReview(report, ['a'], 0).results[0]!.verdict).toBe('keep');
    expect(() => validateReview(report, ['b'], 2)).toThrow('список');
    report.results[0]!.checks.continuity = 'not_visible';
    expect(() => validateReview(report, ['a'], 2)).toThrow('критерий');
  });
  it('reviews real bytes with an explicit map, bounded identity photos and no approval or generation by the critic', async () => {
    const s = await setup(2);
    mkdirSync(path.join(s.dir, 'characters'), { recursive: true }); mkdirSync(path.join(s.dir, 'uploads'), { recursive: true });
    const uploadIds = ['u-face-one', 'u-face-two', 'u-face-three'];
    for (const id of uploadIds) writeFileSync(path.join(s.dir, 'uploads', `${id}.png`), png);
    writeFileSync(path.join(s.dir, 'characters', `${identity.id}.json`), JSON.stringify({ ...identity, uploadIds, status: 'completed', createdAt: new Date(0).toISOString() }));
    await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 12; i++) await s.cycle();
    const run = await s.get(); expect(run.review?.status).toBe('complete'); expect(run.review?.identityCount).toBe(3);
    const request = s.calls.find((c) => c.taskRu === 'Критик фотографий Production' && JSON.parse(c.user).scope === 'series')!;
    expect(request.images).toHaveLength(6); expect(request.images!.every((image) => image.mediaType === 'image/jpeg' && image.base64.length > 100)).toBe(true);
    expect(JSON.parse(request.user).imageMap.map((i: { role: string }) => i.role)).toEqual(['identity', 'identity', 'identity', 'scene', 'shot', 'shot']);
    expect(JSON.parse(request.user).candidates.map((c: { artifactId: string }) => c.artifactId)).toEqual(run.review!.artifactIds);
    expect(JSON.parse(request.user).masterPrompt).toBe(appearanceOutput(2).prompts.masterPrompt);
    expect(run.approvals).toEqual([]); expect(s.submit).toHaveBeenCalledTimes(3); expect(s.calls).toHaveLength(5);
  });
  it('invalid critic output blocks acceptance, never retries on ticks, and retries explicitly without media calls', async () => {
    let invalid = true;
    const critic: Runner = async <T>(request: LlmRequest) => ({ data: reviewReport(invalid ? ['invented'] : JSON.parse(request.user).candidates.map((c: { artifactId: string }) => c.artifactId)) as T, meta: { model: 'fixture', durationMs: 1, inputTokens: 1, outputTokens: 1, turns: 1 } });
    const s = await setup(1, {}, identity, critic); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 12; i++) await s.cycle();
    let run = await s.get(); expect(run.review?.status).toBe('failed'); expect(s.calls).toHaveLength(5);
    await expect(s.rt.act(s.id, { type: 'approvePhotos', rev: run.rev, ids: [run.shots[0]!.photoId!] })).rejects.toThrow('критиком');
    invalid = false;
    const request = { rev: run.rev, requestId: crypto.randomUUID(), consent: true as const };
    await Promise.all([s.rt.review.start(s.id, request), s.rt.review.start(s.id, request)]); await s.rt.review.wait(s.id);
    run = await s.get(); expect(run.review?.status).toBe('complete'); expect(s.calls).toHaveLength(6); expect(s.submit).toHaveBeenCalledTimes(2);
  });
  it('legacy saved photos need explicit consent and restart never relaunches a critic', async () => {
    const s = await setup(1); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 10; i++) await s.cycle();
    let run = await s.get(); delete run.review;
    writeFileSync(path.join(s.dir, 'production-mock', `${s.id}.json`), JSON.stringify(run));
    await s.cycle(); expect(s.calls).toHaveLength(5);
    const app = productionRoutes(s.rt, createCharacters({ dataDir: s.dir }));
    const response = await app.request(`/${s.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rev: run.rev, requestId: crypto.randomUUID(), consent: false }) });
    expect(response.status).toBe(422); expect(s.calls).toHaveLength(5);
    run = await s.get(); run.review = { status: 'running', requestId: crypto.randomUUID(), consentedAt: new Date().toISOString(), artifactIds: [], identityCount: 0, report: null, error: null, model: null, inputTokens: null, outputTokens: null };
    writeFileSync(path.join(s.dir, 'production-mock', `${s.id}.json`), JSON.stringify(run));
    const runLlm = vi.fn(); const recovered = createProductionRuntime({ dataDir: s.dir, gen: s.gen, runLlm });
    await recovered.start(); await recovered.tick(); recovered.stop();
    expect((await recovered.get(s.id)).review!.status).toBe('interrupted'); expect(runLlm).not.toHaveBeenCalled();
  });
  it('deduplicates simultaneous background critic ticks after the async snapshot read', async () => {
    const s = await setup(1); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 10; i++) await s.cycle();
    const run = await s.get(); run.review!.status = 'pending'; run.review!.requestId = crypto.randomUUID(); run.review!.report = null;
    writeFileSync(path.join(s.dir, 'production-mock', `${s.id}.json`), JSON.stringify(run));
    await Promise.all(Array.from({ length: 8 }, () => s.rt.review.tick(s.id))); await s.rt.review.wait(s.id);
    expect(s.calls.filter(c => c.taskRu === 'Критик фотографий Production')).toHaveLength(3);
    expect((await s.get()).review!.status).toBe('complete'); expect(s.submit).toHaveBeenCalledTimes(2);
  });
  it('pause discards a late critic answer and requires an explicit new request', async () => {
    let finish: (() => void) | undefined;
    const critic: Runner = async <T>(request: LlmRequest) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { data: reviewReport(JSON.parse(request.user).candidates.map((c: { artifactId: string }) => c.artifactId)) as T, meta: { model: 'fixture', durationMs: 1, inputTokens: 1, outputTokens: 1, turns: 1 } };
    };
    const s = await setup(1, {}, identity, critic); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 8 && !masterApproved(await s.get()); i++) await s.cycle();
    for (let i = 0; i < 12; i++) await s.cycle(false);
    await vi.waitFor(() => expect(finish).toBeDefined());
    let run = await s.get(); await s.rt.act(s.id, { type: 'pause', rev: run.rev }); finish!(); await s.rt.review.wait(s.id);
    run = await s.get(); expect(run.review?.status).toBe('interrupted'); expect(run.review?.report).toBeNull();
    await s.rt.act(s.id, { type: 'resume', rev: run.rev }); await s.cycle(); expect(s.calls).toHaveLength(5);
  });
});

describe('whole-character lock and mandatory master gate', () => {
  const meta = { model: 'fixture', durationMs: 1, inputTokens: 10, outputTokens: 10, turns: 1 };
  it.each(['character', 'likeness', 'face', 'hands', 'continuity', 'shotMatch', 'visualInterest'] as const)('stops at one paid stub when master fails %s, even with a keep verdict', async (check) => {
    const critic: Runner = async <T>(request: LlmRequest) => {
      const report = ReviewReportSchema.parse(reviewReport(JSON.parse(request.user).candidates.map((c: { artifactId: string }) => c.artifactId)));
      report.results[0]!.checks[check] = 'fail';
      return { data: report as T, meta };
    };
    const s = await setup(2, {}, identity, undefined, critic);
    await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 12; i++) await s.cycle();
    const run = await s.get();
    expect(s.submit).toHaveBeenCalledTimes(1); expect(run.artifacts).toHaveLength(1);
    expect(run.photos!.items.slice(1).every(i => i.status === 'pending')).toBe(true);
    expect(run.masterReview?.report?.results[0]!.verdict).toBe('reject'); expect(masterApproved(run)).toBe(false);
    expect(run.photos?.status).toBe('stopped'); expect(run.review?.status).toBe('interrupted');
    await expect(s.rt.photos.start(s.id, await s.input())).rejects.toThrow('Master');
  });
  it.each(['uncertain', 'not_visible'] as const)('never treats an unassessable master character (%s) as approved', async (status) => {
    const critic: Runner = async <T>(request: LlmRequest) => {
      const report = ReviewReportSchema.parse(reviewReport(JSON.parse(request.user).candidates.map((c: { artifactId: string }) => c.artifactId)));
      report.results[0]!.checks.character = status;
      return { data: report as T, meta };
    };
    const s = await setup(1, {}, identity, undefined, critic); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 9; i++) await s.cycle();
    expect(masterApproved(await s.get())).toBe(false); expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it('runs appearance then master review before any shot; every submitted prompt contains the bound appearance', async () => {
    const s = await setup(); await s.rt.photos.start(s.id, await s.input());
    await s.rt.tick(); expect(s.submit).not.toHaveBeenCalled(); await s.rt.appearance.wait(s.id);
    expect((await s.get()).appearance?.status).toBe('complete');
    await s.rt.tick(); expect(s.submit).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 8 && !masterApproved(await s.get()); i++) { await s.cycle(); expect(s.submit).toHaveBeenCalledTimes(1); }
    expect(masterApproved(await s.get())).toBe(true);
    const masterCall = s.calls.find(c => c.taskRu === 'Критик фотографий Production')!;
    expect(JSON.parse(masterCall.user).scope).toBe('master'); expect(masterCall.images).toHaveLength(4);
    expect(JSON.parse(masterCall.user).candidates).toHaveLength(1);
    for (let i = 0; i < 9; i++) await s.cycle();
    expect(s.submit).toHaveBeenCalledTimes(3);
    for (const [, body] of s.submit.mock.calls) expect(body.prompt).toContain(appearanceOutput().profile.anchorEn);
    expect(s.calls.map(c => c.taskRu)).toEqual(['Режиссёр Production', 'Prompts Production', 'Внешность персонажа Production', 'Критик фотографий Production', 'Критик фотографий Production']);
  });
  it('missing local references block even the master without LLM or provider calls', async () => {
    const s = await setup(); rmSync(path.join(s.dir, 'uploads'), { recursive: true });
    await s.rt.photos.start(s.id, await s.input()); for (let i = 0; i < 5; i++) await s.cycle();
    expect((await s.get()).appearance?.status).toBe('failed'); expect(s.calls).toHaveLength(2); expect(s.submit).not.toHaveBeenCalled();
  });
  it.each(['unusable', 'missing-anchor', 'invented-image', 'changed-motion'] as const)('invalid appearance (%s) never reaches paid media', async (failure) => {
    const appearance: Runner = async <T>() => {
      const output = appearanceOutput(1);
      if (failure === 'unusable') output.profile.usable = false;
      if (failure === 'missing-anchor') output.prompts.shots[0]!.imagePrompt = promptPlan(1).shots[0]!.imagePrompt;
      if (failure === 'invented-image') output.profile.evidence[0]!.imageIndex = 6;
      if (failure === 'changed-motion') output.prompts.shots[0]!.motionPrompt += ' A new gesture.';
      return { data: output as T, meta };
    };
    const s = await setup(1, {}, identity, undefined, undefined, appearance);
    await s.rt.photos.start(s.id, await s.input()); for (let i = 0; i < 7; i++) await s.cycle();
    expect((await s.get()).appearance?.status).toBe('failed'); expect(s.submit).not.toHaveBeenCalled(); expect(s.calls).toHaveLength(3);
  });
  it('a failed master critic has no auto retry; explicit retry alone never resumes paid dispatch', async () => {
    let bad = true;
    const critic: Runner = async <T>(request: LlmRequest) => ({ data: reviewReport(bad ? ['wrong-id'] : JSON.parse(request.user).candidates.map((c: { artifactId: string }) => c.artifactId)) as T, meta });
    const s = await setup(1, {}, identity, undefined, critic); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 10; i++) await s.cycle();
    let run = await s.get(); expect(run.masterReview?.status).toBe('failed'); expect(s.submit).toHaveBeenCalledTimes(1); expect(s.calls).toHaveLength(4);
    bad = false; const input = { rev: run.rev, requestId: crypto.randomUUID(), consent: true as const, scope: 'master' as const, referenceLimit: 6 as const };
    await Promise.all([s.rt.review.start(s.id, input), s.rt.review.start(s.id, input)]); await s.rt.review.wait(s.id);
    for (let i = 0; i < 5; i++) await s.cycle();
    run = await s.get(); expect(masterApproved(run)).toBe(true); expect(run.photos?.status).toBe('stopped'); expect(s.submit).toHaveBeenCalledTimes(1); expect(s.calls).toHaveLength(5);
    await s.rt.photos.start(s.id, await s.input()); for (let i = 0; i < 7; i++) await s.cycle();
    expect(s.submit).toHaveBeenCalledTimes(2); expect((await s.get()).review?.status).toBe('complete');
  });
  it('pause during master review discards a late pass and does not resume on unpause', async () => {
    let finish: (() => void) | undefined;
    const critic: Runner = async <T>(request: LlmRequest) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { data: reviewReport(JSON.parse(request.user).candidates.map((c: { artifactId: string }) => c.artifactId)) as T, meta };
    };
    const s = await setup(1, {}, identity, undefined, critic); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 8; i++) await s.cycle(false);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const before = await s.get(); await s.rt.act(s.id, { type: 'pause', rev: before.rev }); finish!(); await s.rt.review.wait(s.id);
    const paused = await s.get(); expect(paused.masterReview?.status).toBe('interrupted'); expect(paused.masterReview?.report).toBeNull();
    await s.rt.act(s.id, { type: 'resume', rev: paused.rev }); for (let i = 0; i < 4; i++) await s.cycle();
    expect(s.submit).toHaveBeenCalledTimes(1); expect(s.calls).toHaveLength(4);
  });
  it('restart interrupts appearance and master calls, without any automatic LLM or media', async () => {
    const s = await setup(1); await s.rt.photos.start(s.id, await s.input());
    const run = await s.get(); run.appearance!.status = 'running'; run.masterReview!.status = 'running';
    writeFileSync(path.join(s.dir, 'production-mock', `${s.id}.json`), JSON.stringify(run));
    const runLlm = vi.fn(); const recovered = createProductionRuntime({ dataDir: s.dir, gen: s.gen, runLlm });
    await recovered.start(); await recovered.tick(); recovered.stop();
    const saved = await recovered.get(s.id); expect(saved.appearance?.status).toBe('interrupted'); expect(saved.masterReview?.status).toBe('interrupted'); expect(saved.photos?.status).toBe('stopped');
    expect(runLlm).not.toHaveBeenCalled(); expect(s.submit).not.toHaveBeenCalled();
  });
  it('legacy/stale approvals and absent gate consent never unlock remaining shots', async () => {
    const s = await setup(2); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 8 && !masterApproved(await s.get()); i++) await s.cycle();
    const run = await s.get(); expect(masterApproved(run)).toBe(true); const good = structuredClone(run);
    const stale = [() => { delete run.masterReview; }, () => { run.masterReview!.artifactIds = ['old-master']; }, () => { run.masterReview!.appearanceRequestId = crypto.randomUUID(); }, () => { delete run.masterReview!.report!.results[0]!.checks.character; }];
    for (const corrupt of stale) {
      Object.assign(run, structuredClone(good)); corrupt(); writeFileSync(path.join(s.dir, 'production-mock', `${s.id}.json`), JSON.stringify(run));
      await s.rt.tick(); expect(s.submit).toHaveBeenCalledTimes(1); expect(masterApproved(await s.get())).toBe(false);
    }
    expect(PhotoStartSchema.safeParse({ ...await s.input(), masterGateConsent: undefined }).success).toBe(false);
  });
  it('allows a generic no-Soul-ID series without claiming likeness, but still checks master', async () => {
    const s = await setup(1, {}, null); await s.rt.photos.start(s.id, await s.input()); for (let i = 0; i < 9; i++) await s.cycle();
    const run = await s.get(); expect(masterApproved(run)).toBe(true); expect(run.masterReview?.report?.results[0]!.checks.likeness).toBe('not_applicable'); expect(s.submit).toHaveBeenCalledTimes(2);
    expect(s.calls.some(c => c.taskRu === 'Внешность персонажа Production')).toBe(false);
  });
  it('keeps planned object-only b-roll eligible without relaxing the whole-character master gate', () => {
    const report = ReviewReportSchema.parse(reviewReport(['detail']));
    Object.assign(report.results[0]!.checks, { character: 'not_visible', face: 'not_visible', likeness: 'not_visible', hands: 'not_visible' });
    expect(validateReview(report, ['detail'], 2).results[0]!.verdict).toBe('keep');
  });
});

describe('appearance reference consent and cancellation', () => {
  it('bounds new reference sets at six and preserves the old two-reference consent on explicit legacy review', async () => {
    const s = await setup(1);
    const file = path.join(s.dir, 'characters', `${identity.id}.json`);
    const character = JSON.parse(readFileSync(file, 'utf8'));
    character.uploadIds = Array.from({ length: 17 }, (_, i) => `u-photo-${String(i).padStart(3, '0')}`);
    for (const id of character.uploadIds) writeFileSync(path.join(s.dir, 'uploads', `${id}.png`), png);
    writeFileSync(file, JSON.stringify(character));
    await s.rt.photos.start(s.id, await s.input()); for (let i = 0; i < 10; i++) await s.cycle();
    let run = await s.get(); expect(run.appearance?.uploadIds).toEqual([0, 3, 6, 10, 13, 16].map(i => character.uploadIds[i]));
    expect(s.calls.find(c => c.taskRu === 'Внешность персонажа Production')!.images).toHaveLength(6);
    expect(run.masterReview?.identityCount).toBe(6);
    await s.rt.review.start(s.id, { rev: run.rev, requestId: crypto.randomUUID(), consent: true }); await s.rt.review.wait(s.id);
    run = await s.get(); expect(run.review?.identityCount).toBe(2); expect(s.calls.at(-1)!.images).toHaveLength(4); expect(s.submit).toHaveBeenCalledTimes(2);
  });
  it('discards a late appearance result after pause without sending the master', async () => {
    let finish: (() => void) | undefined;
    const appearance: Runner = async <T>() => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { data: appearanceOutput(1) as T, meta: { model: 'fixture', durationMs: 1, inputTokens: 10, outputTokens: 10, turns: 1 } };
    };
    const s = await setup(1, {}, identity, undefined, undefined, appearance);
    await s.rt.photos.start(s.id, await s.input()); await s.rt.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
    const run = await s.get(); await s.rt.act(s.id, { type: 'pause', rev: run.rev }); finish!(); await s.rt.appearance.wait(s.id);
    const paused = await s.get(); expect(paused.appearance?.status).toBe('interrupted'); expect(paused.appearance?.output).toBeNull();
    await s.rt.act(s.id, { type: 'resume', rev: paused.rev }); for (let i = 0; i < 3; i++) await s.cycle();
    expect(s.submit).not.toHaveBeenCalled(); expect(s.calls).toHaveLength(3);
  });
});

describe('creator tolerance and bounded master recovery', () => {
  const meta = { model: 'fixture', durationMs: 1, inputTokens: 10, outputTokens: 10, turns: 1 };
  const budgetInput = async (s: Awaited<ReturnType<typeof setup>>, retryMaster = false) => ({ ...await s.input(), confirmUsd: quotePhotos(await s.get(), { retries: true, retryMaster }).usd, masterRetryConsent: true as const, ...(retryMaster ? { retryMaster: true as const } : {}) });
  const reportFor = (request: LlmRequest) => ReviewReportSchema.parse(reviewReport(JSON.parse(request.user).candidates.map((c: { artifactId: string }) => c.artifactId)));
  it('accepts minor wardrobe and framing variation without relaxing anatomy or identity checks', async () => {
    const critic: Runner = async <T>(request: LlmRequest) => {
      const report = reportFor(request); Object.assign(report.results[0]!.checks, { continuity: 'variation', shotMatch: 'variation' });
      report.results[0]!.reason = 'Рукава короче; образ, внешность и смысл сцены сохранены.';
      return { data: report as T, meta };
    };
    const s = await setup(2, {}, identity, undefined, critic);
    await s.rt.photos.start(s.id, await budgetInput(s));
    for (let i = 0; i < 12; i++) await s.cycle();
    const run = await s.get(); expect(masterApproved(run)).toBe(true); expect(s.submit).toHaveBeenCalledTimes(3);
    expect(run.photos!.budget!.remainingUsd).toBe(0.012); expect(run.photos!.masterHistory).toBeUndefined();
    expect(s.calls.find(c => c.taskRu === 'Критик фотографий Production')!.system).toContain('Короткие рукава');
  });
  it.each(['face', 'likeness', 'character', 'hands'] as const)('does not allow variation to hide a %s defect', check => {
    const report = ReviewReportSchema.parse(reviewReport(['master'])); report.results[0]!.checks[check] = 'variation';
    expect(() => validateReview(report, ['master'], 2)).toThrow('анатомии');
  });
  it('retries a rejected master in the same series, keeps history, and uses only the passing master for shots', async () => {
    let calls = 0;
    const critic: Runner = async <T>(request: LlmRequest) => {
      const report = reportFor(request); if (++calls < 3) report.results[0]!.checks.character = 'fail';
      return { data: report as T, meta };
    };
    const s = await setup(2, {}, identity, undefined, critic);
    const input = await budgetInput(s); expect(input.confirmUsd).toBe(0.030);
    await Promise.all([s.rt.photos.start(s.id, input), s.rt.photos.start(s.id, input)]);
    for (let i = 0; i < 24; i++) await s.cycle();
    const run = await s.get(); expect(s.submit).toHaveBeenCalledTimes(5); expect(calls).toBe(3);
    expect(run.photos!.requests).toHaveLength(1); expect(run.photos!.masterHistory).toHaveLength(2); expect(run.artifacts).toHaveLength(5);
    expect(run.photos!.masterHistory!.every(h => h.review.report!.results[0]!.verdict === 'reject' && h.item.status === 'saved')).toBe(true);
    expect(run.photos!.budget!.remainingUsd).toBe(0); expect(masterApproved(run)).toBe(true);
    const jobs = await s.gen.jobs.all(); expect(new Set(jobs.map(j => j.tag)).size).toBe(5);
    expect(run.artifacts.filter(a => a.shotId !== 'scene').every(a => a.sourceId === run.photos!.masterArtifactId)).toBe(true);
    expect(JSON.parse(s.calls.at(-1)!.user).candidates).toHaveLength(3);
  });
  it('stops after three unsuitable masters and cannot buy a fourth through the same endpoint', async () => {
    const critic: Runner = async <T>(request: LlmRequest) => { const report = reportFor(request); report.results[0]!.checks.character = 'uncertain'; return { data: report as T, meta }; };
    const s = await setup(2, {}, identity, undefined, critic); await s.rt.photos.start(s.id, await budgetInput(s));
    for (let i = 0; i < 24; i++) await s.cycle();
    const run = await s.get(); expect(s.submit).toHaveBeenCalledTimes(3); expect(run.photos!.status).toBe('stopped');
    expect(run.photos!.items.slice(1).every(i => i.status === 'pending')).toBe(true);
    await expect(s.rt.photos.start(s.id, await budgetInput(s, true))).rejects.toThrow('трёх попыток');
    expect(s.submit).toHaveBeenCalledTimes(3);
  });
  it('does not spend a legacy consent reserve; explicit regeneration keeps the script and appearance', async () => {
    let fail = true;
    const critic: Runner = async <T>(request: LlmRequest) => { const report = reportFor(request); if (fail) report.results[0]!.checks.continuity = 'fail'; return { data: report as T, meta }; };
    const s = await setup(1, {}, identity, undefined, critic); await s.rt.photos.start(s.id, await s.input());
    for (let i = 0; i < 10; i++) await s.cycle();
    const before = await s.get(); expect(s.submit).toHaveBeenCalledTimes(1);
    await expect(s.rt.photos.start(s.id, { ...await s.input(), retryMaster: true })).rejects.toThrow('согласие');
    fail = false; await s.rt.photos.start(s.id, await budgetInput(s, true));
    for (let i = 0; i < 12; i++) await s.cycle();
    const run = await s.get(); expect(run.id).toBe(before.id); expect(run.script).toBe(before.script); expect(run.appearance).toEqual(before.appearance);
    expect(run.photos!.masterHistory).toHaveLength(1); expect(s.submit).toHaveBeenCalledTimes(3);
    expect(s.calls.filter(c => c.taskRu === 'Внешность персонажа Production')).toHaveLength(1);
  });
  it('never regenerates on critic protocol failure or unknown provider submission even with a three-attempt budget', async () => {
    const critic: Runner = async <T>() => ({ data: reviewReport(['wrong']) as T, meta });
    const s = await setup(1, {}, identity, undefined, critic); await s.rt.photos.start(s.id, await budgetInput(s));
    for (let i = 0; i < 14; i++) await s.cycle();
    expect(s.submit).toHaveBeenCalledTimes(1); expect((await s.get()).masterReview?.status).toBe('failed');
    const unknown = vi.fn(async () => { throw new GenError('NETWORK', 'Ответ потерян'); });
    const u = await setup(1, { submit: unknown }); await u.rt.photos.start(u.id, await budgetInput(u));
    for (let i = 0; i < 12; i++) await u.cycle();
    expect(unknown).toHaveBeenCalledTimes(1); expect((await u.get()).photos?.status).toBe('stopped');
  });
  it.each(['price', 'budget'])('stops dispatch if the confirmed %s no longer covers the next image', async (change) => {
    const s = await setup(1); await s.rt.photos.start(s.id, await budgetInput(s));
    await s.rt.tick(); await s.rt.appearance.wait(s.id);
    const run = await s.get();
    if (change === 'price') run.photos!.budget!.perImageUsd += 0.001;
    else run.photos!.budget!.remainingUsd = 0;
    writeFileSync(path.join(s.dir, 'production-mock', `${s.id}.json`), JSON.stringify(run));
    for (let i = 0; i < 5; i++) await s.cycle();
    expect(s.submit).not.toHaveBeenCalled(); expect((await s.get()).photos!.status).toBe('stopped');
  });
  it('pausing between rejection and retry cancels automatic paid continuation', async () => {
    const critic: Runner = async <T>(request: LlmRequest) => { const report = reportFor(request); report.results[0]!.checks.face = 'fail'; return { data: report as T, meta }; };
    const s = await setup(1, {}, identity, undefined, critic); await s.rt.photos.start(s.id, await budgetInput(s));
    for (let i = 0; i < 9 && (await s.get()).masterReview?.status !== 'complete'; i++) await s.cycle();
    let run = await s.get(); expect(run.masterReview?.status).toBe('complete'); expect(s.submit).toHaveBeenCalledTimes(1);
    await s.rt.act(s.id, { type: 'pause', rev: run.rev }); run = await s.get(); await s.rt.act(s.id, { type: 'resume', rev: run.rev });
    for (let i = 0; i < 8; i++) await s.cycle();
    expect(s.submit).toHaveBeenCalledTimes(1); expect((await s.get()).photos!.status).toBe('stopped');
  });
});
