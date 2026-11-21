import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceCard } from '../../src/core/references.ts';
import { createApp, HOST, PORT } from '../../src/server/app.ts';
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
  analysis: { visible: subject, technique: angle, transfer: angle, subject, pose: '', composition: '', angle, lighting: '', color: '', texture: '', styling: '' },
});

const meta = { durationMs: 1, model: 'fake', turns: 1, inputTokens: 10, outputTokens: 10 };

describe('reference chat', () => {
  it('finds complementary matches, verifies IDs, persists selections and applies feedback in context', async () => {
    const cards = [card('food', 'бургер', 'крупный план'), card('street', 'улица', 'fisheye'), card('other', 'пейзаж', 'телефото')];
    const library = { list: async () => cards, get: async (id: string, version?: number) => cards.find(item => item.id === id && item.version === version) };
    const dir = await root();
    const chat = createReferenceChat(dir, library);
    const reqs: LlmRequest[] = [];
    const run = async <T>(request: LlmRequest): Promise<LlmResult<T>> => {
      reqs.push(request);
      const food = { refId: 'food', role: 'подача продукта', reason: 'Близкая перспектива подчёркивает начинку.' };
      const street = { refId: 'street', role: 'fisheye', reason: 'Искажение по краям усиливает перспективу.' };
      const data = request.taskRu === 'Разобрать запрос референсов'
        ? { aspects: [{ role: 'продукт', terms: ['бургер'] }, { role: 'ракурс fisheye', terms: ['fisheye'] }] }
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

  it('denies access on the shared instance and refuses public origins on the pilot', async () => {
    const dataDir = await root();
    const app = createApp({ rootDir, dataDir });
    expect(await (await app.request('/api/references/status', { headers: { host } })).json()).toEqual({ enabled: false });
    expect((await app.request('/api/references/cards', { headers: { host } })).status).toBe(404);
    expect(() => createApp({ rootDir, dataDir, referenceLibrary: true, publicOrigins: ['https://public.example'] })).toThrow(/loopback/);
  });

  it('requires an allowed origin and preserves the empty chat response over the real route', async () => {
    const app = createApp({ rootDir, dataDir: await root(), referenceLibrary: true });
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
});
