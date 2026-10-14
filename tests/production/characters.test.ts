import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, HOST, PORT, CLIENT_HEADER } from '../../src/server/app.ts';
import { createCharacters } from '../../src/server/production/characters.ts';
import { createSoulIdProvider, type SoulIdProvider, type SoulReference } from '../../src/server/production/soulId.ts';
import { createUploads } from '../../src/server/storage/uploads.ts';
import { createProductionRuntime } from '../../src/server/production/runtime.ts';
import { DEMO_INPUT, type ProductionRun } from '../../src/core/production/model.ts';
import type { Character, CreateCharacterInput } from '../../src/core/production/character.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };
const reference: SoulReference = { id: 'b9b6376f-128c-4238-b0e0-11015cb24e64', name: 'Test character', status: 'completed' };
const png = readFileSync(path.join(ROOT, 'src/web/public/production-mock/shot-1.png'));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
async function setup(patch: Partial<SoulIdProvider> = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'soul-id-test-')); dirs.push(dataDir);
  const provider = { upload: vi.fn(async () => 'https://example.com/upload.png'), create: vi.fn(async () => reference), get: vi.fn(async () => reference), list: vi.fn(async () => ({ items: [reference], total_pages: 1 })), ...patch };
  const characters = createCharacters({ dataDir, provider });
  const upload = (await createUploads(dataDir).save(png, 'image/png'))!;
  const input: CreateCharacterInput = { name: 'Test character', requestId: randomUUID(), uploadIds: [upload.id], consent: true, costConfirmed: 'unknown' };
  return { dataDir, provider, characters, upload, input };
}

describe('Soul ID adapter without real requests', () => {
  it('uploads all presigned headers without credentials and creates only v2 custom reference', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/files/generate-upload-url')) return Response.json({ public_url: 'https://cdn.example/image.png', upload_url: 'https://storage.example/signed', upload_headers: { 'Content-Type': 'image/png', 'x-amz-tagging': 'retention=temporary' } });
      if (String(url).includes('storage.example')) return new Response(null, { status: 200 });
      return Response.json(reference);
    });
    const provider = createSoulIdProvider({ apiKey: () => 'test-key:test-secret', fetch: fetcher as typeof fetch });
    const url = await provider.upload(png, 'image/png');
    await provider.create('Test character', [url]);
    expect(calls.map((c) => c.url)).toEqual(['https://api.higgsfield.ai/files/generate-upload-url', 'https://storage.example/signed', 'https://api.higgsfield.ai/v1/custom-references']);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Key test-key:test-secret');
    expect(new Headers(calls[1]!.init.headers).get('authorization')).toBeNull();
    expect(new Headers(calls[1]!.init.headers).get('x-amz-tagging')).toBe('retention=temporary');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ name: 'Test character', model_version: 'v2', input_images: [{ type: 'image_url', image_url: url }] });
  });
  it('does not retry a failed POST or expose raw provider errors', async () => {
    const fetcher = vi.fn(async () => new Response('secret vendor error', { status: 500 }));
    const provider = createSoulIdProvider({ apiKey: () => 'test-key:test-secret', fetch: fetcher });
    await expect(provider.create('Test', ['https://example.com/a.png'])).rejects.toThrow('HTTP 500');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('durable characters and explicit creation', () => {
  it('rejects missing consent/cost and invalid/missing photos before any external call', async () => {
    const { characters, input, provider, dataDir } = await setup();
    for (const invalid of [{ ...input, consent: false }, { ...input, costConfirmed: 0 }, { ...input, uploadIds: [] }, { ...input, uploadIds: [input.uploadIds[0], input.uploadIds[0]] }]) {
      await expect(characters.create(invalid as CreateCharacterInput)).rejects.toThrow();
    }
    await expect(characters.create({ ...input, uploadIds: [...input.uploadIds, 'u-missing-file'] })).rejects.toThrow('не найдено');
    const bad = (await createUploads(dataDir).save(new Uint8Array([1, 2]), 'image/png'))!;
    await expect(characters.create({ ...input, uploadIds: [bad.id] })).rejects.toThrow('прочитать');
    expect(provider.upload).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
  });
  it('deduplicates repeated submission, stores progress and survives reload', async () => {
    const { characters, input, provider, dataDir } = await setup();
    const [a, b] = await Promise.all([characters.create(input), characters.create(input)]);
    expect(a.id).toBe(b.id); await characters.wait(a.id);
    expect(provider.create).toHaveBeenCalledTimes(1); expect(provider.upload).toHaveBeenCalledTimes(1);
    const restored = createCharacters({ dataDir, provider });
    expect(await restored.list()).toMatchObject([{ status: 'completed', referenceId: reference.id, uploadedCount: 1, uploadIds: input.uploadIds }]);
    await restored.create(input); expect(provider.create).toHaveBeenCalledTimes(1);
    await expect(restored.create({ ...input, name: 'Changed' })).rejects.toThrow('другими');
  });
  it('polls queued → in_progress → completed, never repeats creation', async () => {
    const { characters, input, provider } = await setup({ create: vi.fn(async () => ({ ...reference, status: 'queued' as const })), get: vi.fn().mockResolvedValueOnce({ ...reference, status: 'in_progress' }).mockResolvedValue(reference) });
    const result = await characters.create(input); await characters.wait(result.id);
    await expect(characters.select(result.id)).rejects.toThrow('готовый');
    expect((await characters.refresh())[0]?.status).toBe('in_progress');
    expect((await characters.refresh())[0]?.status).toBe('completed');
    expect((await characters.select(result.id)).referenceId).toBe(reference.id);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it('persists an uncertain submission without resending on refresh or restart', async () => {
    const { characters, input, provider, dataDir } = await setup({ create: vi.fn(async () => { throw new Error('connection lost'); }) });
    const result = await characters.create(input); await characters.wait(result.id);
    expect((await characters.list())[0]?.status).toBe('unknown');
    const restored = createCharacters({ dataDir, provider });
    await restored.refresh(); await restored.create(input);
    expect(provider.create).toHaveBeenCalledTimes(1);
    await expect(restored.select(result.id)).rejects.toThrow();
  });
  it.each(['uploading', 'submitting'] as const)('recovers persisted %s state without network calls', async (status) => {
    const { characters, input, provider, dataDir } = await setup();
    const result = await characters.create(input); await characters.wait(result.id);
    const file = path.join(dataDir, 'characters', `${result.id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), status, referenceId: null }));
    vi.mocked(provider.create).mockClear(); vi.mocked(provider.upload).mockClear();
    const restored = createCharacters({ dataDir, provider });
    expect((await restored.list())[0]?.status).toBe(status === 'submitting' ? 'unknown' : 'failed');
    expect(provider.create).not.toHaveBeenCalled(); expect(provider.upload).not.toHaveBeenCalled();
  });
  it('imports all pages read-only and does not assume external references are v2', async () => {
    const second = { ...reference, id: randomUUID(), name: 'Second', model_version: 'v2' };
    const { characters, provider } = await setup({ list: vi.fn(async (page) => ({ items: [page === 1 ? reference : second], total_pages: 2 })) });
    const items = await characters.sync();
    expect(items).toHaveLength(2); expect(provider.list).toHaveBeenCalledTimes(2);
    const unknown = items.find((c) => c.referenceId === reference.id)!;
    expect(unknown.modelVersion).toBe('unknown'); await expect(characters.select(unknown.id)).rejects.toThrow();
    expect(provider.create).not.toHaveBeenCalled();
  });
});

describe('Production selection API keeps media mock', () => {
  it('enforces localhost and explicit consent; saves only ready identity and exports it', async () => {
    const network = vi.fn(async () => { throw new Error('No network'); }); vi.stubGlobal('fetch', network);
    const { characters, input, dataDir, provider } = await setup();
    let now = 0;
    const production = createProductionRuntime({ dataDir, now: () => now, delayMs: 1 });
    const llm = vi.fn(async () => { throw new Error('No LLM'); });
    const app = createApp({ rootDir: ROOT, dataDir, production, characters, runLlm: llm });
    const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await app.request('/api/characters', { method: 'POST', headers: { host: `${HOST}:${PORT}` }, body: JSON.stringify(input) })).status).toBe(403);
    expect((await post('/api/characters', { ...input, consent: false })).status).toBe(422);
    const response = await post('/api/characters', input); expect(response.status).toBe(202);
    const character = await response.json() as Character; await characters.wait(character.id);
    let run = await (await post('/api/production', { ...DEMO_INPUT, characterId: character.id })).json() as ProductionRun;
    expect(run.character).toMatchObject({ id: character.id, referenceId: reference.id, modelVersion: 'v2' });
    const runId = run.id;
    for (let i = 0; i < 12; i++) { now += 100; await production.tick(); }
    run = await production.get(runId);
    const original = structuredClone(run.artifacts);
    expect(original).toHaveLength(3); expect(original.every((a) => a.cost === 0 && a.taskId.startsWith('mock-'))).toBe(true);
    expect((await post(`/api/production/${runId}/character`, { characterId: null, rev: 0 })).status).toBe(409);
    expect((await post(`/api/production/${runId}/character`, { characterId: null, rev: run.rev })).status).toBe(200);
    run = await production.get(runId);
    expect(run.character).toBeNull(); expect(run.artifacts).toEqual(original);
    expect((await post(`/api/production/${runId}/character`, { characterId: character.id, rev: run.rev })).status).toBe(200);
    const manifest = await (await app.request(`/api/production/${runId}/manifest`, { headers })).json() as ProductionRun;
    expect(manifest.character?.referenceId).toBe(reference.id);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled(); expect(llm).not.toHaveBeenCalled();
  });
  it('checks provider readiness again before binding a previously ready character', async () => {
    const { characters, input } = await setup({ get: vi.fn(async () => ({ ...reference, status: 'failed' as const })) });
    const character = await characters.create(input); await characters.wait(character.id);
    await expect(characters.select(character.id)).rejects.toThrow('не готов');
    expect((await characters.list())[0]?.status).toBe('failed');
  });
  it('rejects an explicit incompatible model version even when training completed', async () => {
    const { characters, input } = await setup({ get: vi.fn(async () => ({ ...reference, model_version: 'v1' })) });
    const character = await characters.create(input); await characters.wait(character.id);
    await expect(characters.select(character.id)).rejects.toThrow();
    expect((await characters.list())[0]?.modelVersion).toBe('unknown');
  });
});
