import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceCard, ReferenceThread } from '../../src/core/references.ts';
import { createAccounts } from '../../src/server/accounts/service.ts';
import { createApp, HOST, PORT } from '../../src/server/app.ts';
import { runFfmpeg } from '../../src/server/gen/ffmpeg.ts';
import type { LlmRequest, LlmResult } from '../../src/server/llm/codexCli/provider.ts';
import { createReferenceChat } from '../../src/server/references/chat.ts';

const dirs: string[] = [];
async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), 'reference-chat-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const card = (id: string, subject: string, angle: string): ReferenceCard => ({
  id, sourceName: `${id}.jpg`, timeMs: null, folder: 'camera', version: 1, tags: [angle],
  quality: { status: 'keep', reason: 'Полезный визуальный приём.' }, eligible: true,
  analysis: { visible: subject, technique: angle, transfer: angle, subject, pose: '', composition: '', angle, lighting: '', color: '', texture: '', styling: '' },
});

const meta = { durationMs: 1, model: 'fake', turns: 1, inputTokens: 10, outputTokens: 10 };

describe('reference chat', () => {
  it('finds complementary matches, verifies IDs, persists selections and applies feedback in context', async () => {
    const cards = [card('food', 'burger', 'close-up'), card('street', 'улица', 'fisheye'), card('other', 'пейзаж', 'телефото')];
    const library = { list: async () => cards, get: async (id: string, version?: number) => cards.find(item => item.id === id && item.version === version) };
    const dir = await root();
    const chat = createReferenceChat(dir, library);
    const reqs: LlmRequest[] = [];
    const run = async <T>(request: LlmRequest): Promise<LlmResult<T>> => {
      reqs.push(request);
      const food = { refId: 'food', role: 'подача продукта', reason: 'Близкая перспектива подчёркивает начинку.' };
      const street = { refId: 'street', role: 'fisheye', reason: 'Искажение по краям усиливает перспективу.' };
      const data = request.taskRu === 'Разобрать запрос референсов'
        ? { aspects: [{ role: 'продукт', terms: ['burger', 'бургер'] }, { role: 'ракурс fisheye', terms: ['fisheye', 'рыбий глаз'] }] }
        : { summary: 'Соедини подачу с оптикой.', matches: [food, street, street, { ...food, refId: 'other' }, { ...food, refId: 'invented' }] };
      return { data: data as T, meta };
    };
    const query = { brief: 'Снимаем бургер', query: 'Подбери fisheye из street' };
    const first = await chat.search('flow:burger:node', query, async () => run);
    const turn = first.turns[0]!;
    expect(turn.matches.map(item => item.refId)).toEqual(['food', 'street']);
    expect(reqs.every(req => !req.images?.length)).toBe(true);
    const selection = [{ id: 'street', version: 1, role: 'fisheye' }];
    await chat.setSelection('flow:burger:node', selection);
    await chat.recordFeedback('flow:burger:node', { turnId: turn.id, refId: 'street', value: 'used', role: 'fisheye' });
    await expect(chat.recordFeedback('flow:burger:node', { turnId: turn.id, refId: 'other', value: 'used' })).rejects.toMatchObject({ status: 404 });
    const restarted = createReferenceChat(dir, library);
    await restarted.search('flow:burger:node', { brief: query.brief, query: 'Оставь fisheye' }, async () => run);
    expect(JSON.parse(reqs[2]!.user).previous.query).toBe(query.query);
    expect(JSON.parse(reqs[3]!.user).candidates).toContainEqual(expect.objectContaining({ refId: 'street', preference: 'positive' }));
    expect(await restarted.get('flow:burger:node')).toMatchObject({ selection, turns: [turn, expect.objectContaining({ query: 'Оставь fisheye' })] });
    expect(await restarted.get('library')).toEqual({ turns: [], selection: [] });
  });

  it('keeps an empty response when the library has no analyzed frames without calling a runner', async () => {
    const run = vi.fn();
    const chat = createReferenceChat(await root(), { list: async () => [], get: async () => undefined });
    const result = await chat.search('library', { brief: '', query: 'портрет' }, run);
    expect(result.turns[0]).toMatchObject({ matches: [], summary: expect.stringContaining('Подходящих кадров пока нет') });
    expect(run).not.toHaveBeenCalled();
  });

  it('passes partial terms to reranking and preserves its explanation when none qualify', async () => {
    const chat = createReferenceChat(await root(), { list: async () => [card('street', 'улица', 'fisheye')], get: async () => undefined });
    let calls = 0;
    const run = async <T>(request: LlmRequest): Promise<LlmResult<T>> => {
      calls++;
      const data = request.taskRu === 'Разобрать запрос референсов'
        ? { aspects: [{ role: 'ракурс', terms: ['уличная съёмка с fisheye'] }] }
        : { summary: 'Есть оптика, но нет нужного верхнего ракурса.', matches: [] };
      return { data: data as T, meta };
    };
    const result = await chat.search('library', { brief: '', query: 'fisheye сверху' }, async () => run);
    expect(calls).toBe(2);
    expect(result.turns[0]).toMatchObject({ matches: [], summary: 'Есть оптика, но нет нужного верхнего ракурса.' });
  });
});

describe('reference library deployment gate', () => {
  const host = `${HOST}:${PORT}`;
  const rootDir = path.resolve(import.meta.dirname, '../..');
  const origin = 'https://studio.example';

  it('denies access on the shared instance and refuses public origins on the pilot', async () => {
    const dataDir = await root();
    const app = createApp({ rootDir, dataDir });
    expect(await (await app.request('/api/references/status', { headers: { host } })).json()).toEqual({ enabled: false });
    expect((await app.request('/api/references/cards', { headers: { host } })).status).toBe(404);
    expect(() => createApp({ rootDir, dataDir, referenceLibrary: 'private', publicOrigins: [origin] })).toThrow(/loopback/);
  });

  it('requires an allowed origin and preserves the empty chat response over the real route', async () => {
    const app = createApp({ rootDir, dataDir: await root(), referenceLibrary: 'private' });
    const headers = { host, 'x-sp-client': '1', 'content-type': 'application/json' };
    const body = JSON.stringify({ brief: '', query: 'бургер' });
    const allowed = await app.request('/api/references/threads/library', { method: 'POST', headers, body });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ thread: { turns: [{ query: 'бургер', matches: [] }] } });
    const blocked = await app.request('/api/references/threads/library', { method: 'POST', headers: { ...headers, origin: 'https://public.example' }, body });
    expect(blocked.status).toBe(403);
    const invalid = await app.request('/api/references/threads/library', { method: 'POST', headers, body: '{}' });
    expect(invalid.status).toBe(422);
  });

  it('requires explicit public HTTPS and per-account AI for shared mode', async () => {
    const dataDir = await root();
    const accounts = createAccounts({ dir: await root(), secureCookie: true });
    expect(() => createApp({ rootDir, dataDir, referenceLibrary: 'shared', accounts })).toThrow(/configured HTTPS origins/);
    expect(() => createApp({ rootDir, dataDir, referenceLibrary: 'shared', publicOrigins: [origin] })).toThrow(/AI accounts/);
  });

  it('rejects both runtime flags before starting or reusing an instance', () => {
    const result = spawnSync(process.execPath, ['src/server/index.ts'], {
      cwd: rootDir,
      env: { ...process.env, SP_PRIVATE_REFERENCE_LIBRARY: '1', SP_SHARED_REFERENCE_LIBRARY: '1' },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('shares the gallery and Canvas history while keeping standalone threads and votes scoped to each account', async () => {
    const dataDir = await root();
    const frame = card('fixture', 'street', 'fisheye');
    let refId = '';
    const requests: { profile?: string; previous?: unknown; candidates?: { refId: string; preference: string }[] }[] = [];
    const accounts = createAccounts({
      dir: await root(),
      secureCookie: true,
      apiLogin: async (home, key) => {
        await writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key }));
      },
      run: async <T>(request: LlmRequest, options?: { codexHome?: string }): Promise<LlmResult<T>> => {
        const input = JSON.parse(request.user);
        const replies = {
          'Проверка качества референсов': { frames: input.candidateIds?.map((id: string) => ({ id, status: 'keep', reasonCode: 'useful', reason: 'Выразительный цвет.', duplicateOf: null })) },
          'Разбор референсов': { frames: input.imageIdsInOrder?.map((id: string) => ({ id, folder: frame.folder, tags: frame.tags, analysis: frame.analysis })) },
          'Разобрать запрос референсов': { aspects: [{ role: 'ракурс fisheye', terms: ['fisheye'] }] },
          'Подобрать кадры из библиотеки': { summary: 'Широкая перспектива улицы.', matches: [{ refId, role: 'ракурс fisheye', reason: 'Характер перспективы.' }] },
        };
        if (request.taskRu === 'Подобрать кадры из библиотеки') requests.push({ ...input, profile: options?.codexHome });
        return { data: replies[request.taskRu as keyof typeof replies] as T, meta };
      },
    });
    const app = createApp({ rootDir, dataDir, publicOrigins: [origin], accounts, referenceLibrary: 'shared' });
    const json = (body: object, method = 'POST'): RequestInit => ({
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const request = (resource: string, options?: RequestInit, cookie = '') => app.request(resource, {
      ...options, headers: { host, origin, 'x-sp-client': '1', cookie, ...Object.fromEntries(new Headers(options?.headers)) },
    });
    const login = async (label: string) => {
      const response = await request('/api/chatgpt/api-key', json({ apiKey: `test-only-key-for-${label}` }));
      expect(response.status).toBe(200);
      return response.headers.get('set-cookie')!.split(';')[0]!;
    };
    const libraryPath = '/api/references/threads/library';
    const canvasPath = '/api/references/threads/flow~node';
    const query = (text: string) => json({ brief: '', query: text });
    const getThread = async (route: string, options?: RequestInit, cookie?: string) => {
      const response = await request(route, options, cookie);
      expect(response.status).toBe(200);
      return ((await response.json()) as { thread: ReferenceThread }).thread;
    };

    expect(await (await request('/api/references/status')).json()).toEqual({ enabled: true, shared: true });
    expect((await request('/api/references/cards')).status).toBe(200);
    expect((await request(libraryPath)).status).toBe(401);
    expect((await request(canvasPath, query('Запрос без подключения'))).status).toBe(401);
    const a = await login('account-a');
    const b = await login('account-b');

    const picture = path.join(dataDir, 'fixture.png');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=red:s=160x90:r=10', '-frames:v', '1', '-threads', '1', '-update', '1', picture]);
    const upload = await request('/api/references/imports?name=fixture.png', { method: 'POST', body: new Uint8Array(await readFile(picture)) });
    expect(upload.status).toBe(200);
    refId = (await upload.json()).cards[0].id;
    expect((await request(`/api/references/cards/${refId}/image`)).status).toBe(404);
    const image = await request(`/api/references/cards/${refId}/image?scope=all`);
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await request('/api/references/analysis', json({ maxPending: 1 }), a)).status).toBe(200);
    await vi.waitFor(async () => expect((await (await request('/api/references/analysis')).json()).job?.status).toBe('done'));

    const first = await getThread(libraryPath, query('Запрос А'), a);
    expect(first.turns[0]?.matches[0]?.refId).toBe(refId);
    expect(await getThread(libraryPath, undefined, b)).toEqual({ turns: [], selection: [] });
    const privateKey = encodeURIComponent(`account/${path.basename(requests[0]!.profile!)}/library`);
    expect((await request(`/api/references/threads/${privateKey}`, undefined, b)).status).toBe(422);
    const selected = [{ id: refId, version: 2, role: 'fisheye' }];
    expect(await getThread(libraryPath, json({ selection: selected }, 'PATCH'), a)).toMatchObject({ selection: selected });
    expect(await getThread(libraryPath, undefined, b)).toEqual({ turns: [], selection: [] });

    const feedback = json({ turnId: first.turns[0]?.id, refId, value: 'used', role: 'fisheye' });
    expect((await request(`${libraryPath}/feedback`, feedback, b)).status).toBe(404);
    expect((await request(`${libraryPath}/feedback`, feedback, a)).status).toBe(204);
    expect(await getThread(canvasPath, query('Общий Canvas'), b)).toMatchObject({ turns: [{ query: 'Общий Canvas' }] });
    expect(await getThread(canvasPath)).toMatchObject({ turns: [{ query: 'Общий Canvas' }] });
    expect(requests[1]?.candidates).toContainEqual(expect.objectContaining({ refId, preference: 'neutral' }));
    await getThread(canvasPath, query('Сохрани ракурс'), a);
    expect(requests[2]?.candidates).toContainEqual(expect.objectContaining({ refId, preference: 'positive' }));
    expect(requests[0]?.profile).toBe(requests[2]?.profile);
    expect(requests[0]?.profile).not.toBe(requests[1]?.profile);
  });
});
