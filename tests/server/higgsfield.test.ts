import { describe, expect, it } from 'vitest';
import { createHiggsfieldProvider } from '../../src/server/gen/higgsfield.ts';
import { GenError } from '../../src/server/gen/provider.ts';

const KEY = 'kid:secret';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(...responses: Response[]) {
  const seen: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (next === undefined) throw new Error('лишний запрос');
    return next;
  }) as typeof fetch;
  return { fetch: impl, seen };
}

describe('Higgsfield API (Soul 2)', () => {
  it('сабмит: заголовок Key ID:SECRET, плоский JSON, request_id → taskId', async () => {
    const { fetch, seen } = fakeFetch(json({ status: 'queued', request_id: 'r-1', status_url: 'x', cancel_url: 'y' }));
    const hf = createHiggsfieldProvider({ apiKey: () => KEY, fetch });
    expect(await hf.submit('higgsfield-ai/soul/v2/standard', { prompt: 'x', resolution: '720p' })).toBe('r-1');
    expect(seen[0]).toEqual({ url: 'https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard', method: 'POST', auth: `Key ${KEY}`, body: { prompt: 'x', resolution: '720p' } });
  });

  it('статус: completed → images[].url; nsfw и failed → провал с причиной', async () => {
    const { fetch, seen } = fakeFetch(
      json({ status: 'in_progress' }),
      json({ status: 'completed', images: [{ url: 'https://cdn.hf/a.png' }, { url: 'https://cdn.hf/b.png' }] }),
      json({ status: 'nsfw' }),
      json({ status: 'failed', error: 'bad prompt' }),
    );
    const hf = createHiggsfieldProvider({ apiKey: () => KEY, fetch });
    expect((await hf.poll('r-1')).state).toBe('running');
    expect(seen[0]?.url).toBe('https://api.higgsfield.ai/requests/r-1/status');
    expect(await hf.poll('r-1')).toMatchObject({ state: 'success', urls: ['https://cdn.hf/a.png', 'https://cdn.hf/b.png'] });
    expect(await hf.poll('r-1')).toMatchObject({ state: 'fail', failMsg: expect.stringContaining('nsfw') as unknown });
    expect(await hf.poll('r-1')).toMatchObject({ state: 'fail', failMsg: 'bad prompt' });
  });

  it('403 — нет денег, 400 concurrent — лимит; ключа в сообщении нет', async () => {
    const { fetch } = fakeFetch(json({ detail: 'Not enough credits' }, 403), json({ detail: 'Maximum number of concurrent requests (4) has been reached' }, 400));
    const hf = createHiggsfieldProvider({ apiKey: () => KEY, fetch });
    for (const code of ['NO_CREDITS', 'RATE_LIMIT']) {
      const error = await hf.submit('m', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GenError);
      expect((error as GenError).code).toBe(code);
      expect((error as GenError).messageRu).not.toContain('secret');
    }
  });

  it('нет ключа — NO_KEY без запроса; баланса у API нет', async () => {
    const { fetch, seen } = fakeFetch();
    const hf = createHiggsfieldProvider({ apiKey: () => null, fetch });
    expect(hf.hasKey()).toBe(false);
    await expect(hf.submit('m', {})).rejects.toMatchObject({ code: 'NO_KEY' });
    expect(seen).toHaveLength(0);
    expect(hf.balance).toBeUndefined();
  });
});

describe('формат ключа: запись с текстом команды вместо ключа ловится сразу', () => {
  it('без двоеточия или с пробелами — не ключ; причина без значения', async () => {
    const pasted = '! security add-generic-password -s higgsfield-api-key -a "$USER" -w "$(pbpaste)"';
    const hf = createHiggsfieldProvider({ apiKey: () => pasted, fetch: fakeFetch().fetch });
    expect(hf.hasKey()).toBe(false);
    expect(hf.keyProblem?.()).toContain('KEY_ID:KEY_SECRET');
    expect(hf.keyProblem?.()).not.toContain('pbpaste');
    await expect(hf.submit('m', {})).rejects.toMatchObject({ code: 'NO_KEY' });
    expect(createHiggsfieldProvider({ apiKey: () => 'abc:def', fetch: fakeFetch().fetch }).keyProblem?.()).toBeNull();
  });
});

describe('готовые мудборды Soul 2', () => {
  it('GET /v1/text2image/soul-styles/v2 → id, имя, превью; мусор отбрасывается', async () => {
    const { fetch, seen } = fakeFetch(
      json([
        { id: 's1', name: 'Old smartphone', description: '', preview_url: 'https://cdn.higgsfield.ai/a.webp' },
        { id: 's2', name: 'BW film', preview_url: null },
        { name: 'без id' },
      ]),
    );
    const hf = createHiggsfieldProvider({ apiKey: () => KEY, fetch });
    expect(await hf.listStyles?.()).toEqual([
      { id: 's1', name: 'Old smartphone', description: '', previewUrl: 'https://cdn.higgsfield.ai/a.webp' },
      { id: 's2', name: 'BW film', description: '', previewUrl: null },
    ]);
    expect(seen[0]).toMatchObject({ url: 'https://api.higgsfield.ai/v1/text2image/soul-styles/v2', method: 'GET', auth: `Key ${KEY}` });
  });
});
