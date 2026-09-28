import { describe, expect, it } from 'vitest';
import { createKieProvider, parseResultUrls } from '../../src/server/gen/kie.ts';
import { GenError } from '../../src/server/gen/provider.ts';

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

const KEY = 'test-key-123';

/** fetch, который отвечает заранее заданными ответами и запоминает запросы. */
function fakeFetch(...responses: (Response | Error)[]) {
  const seen: Seen[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body ?? null;
    if (typeof body === 'string') body = JSON.parse(body);
    seen.push({ url: String(input), method: init?.method ?? 'GET', auth: headers.get('authorization'), body });
    const next = responses.shift();
    if (next === undefined) throw new Error('лишний запрос');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: impl as typeof fetch, seen };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('клиент KIE', () => {
  it('createTask: Bearer-ключ, тело {model, input}, taskId из data', async () => {
    const { fetch, seen } = fakeFetch(json({ code: 200, msg: 'success', data: { taskId: 't-1' } }));
    const kie = createKieProvider({ apiKey: () => KEY, fetch });
    expect(await kie.submit('nano-banana-2', { prompt: 'x' })).toBe('t-1');
    expect(seen[0]).toEqual({ url: 'https://api.kie.ai/api/v1/jobs/createTask', method: 'POST', auth: `Bearer ${KEY}`, body: { model: 'nano-banana-2', input: { prompt: 'x' } } });
  });

  it('ошибка в поле code при HTTP 200 и HTTP-статус — оба разбираются; ключа в сообщении нет', async () => {
    const { fetch } = fakeFetch(json({ code: 402, msg: 'Credits insufficient' }), json({ msg: 'bad key' }, 401), json({ code: 429, msg: 'slow down' }));
    const kie = createKieProvider({ apiKey: () => KEY, fetch });
    const codes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const error = await kie.submit('m', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GenError);
      expect((error as GenError).messageRu).not.toContain(KEY);
      codes.push((error as GenError).code);
    }
    expect(codes).toEqual(['NO_CREDITS', 'AUTH', 'RATE_LIMIT']);
  });

  it('recordInfo: состояния KIE → наши; resultJson — строка JSON', async () => {
    const { fetch, seen } = fakeFetch(
      json({ code: 200, data: { state: 'waiting' } }),
      json({ code: 200, data: { state: 'generating' } }),
      json({ code: 200, data: { state: 'success', resultJson: '{"resultUrls":["https://tempfile.example/a.png"]}', creditsConsumed: 8 } }),
      json({ code: 200, data: { state: 'fail', failMsg: 'content policy' } }),
    );
    const kie = createKieProvider({ apiKey: () => KEY, fetch });
    expect((await kie.poll('t 1')).state).toBe('queued');
    expect(seen[0]?.url).toBe('https://api.kie.ai/api/v1/jobs/recordInfo?taskId=t%201');
    expect((await kie.poll('t')).state).toBe('running');
    expect(await kie.poll('t')).toEqual({ state: 'success', providerState: 'success', urls: ['https://tempfile.example/a.png'], creditsConsumed: 8, failMsg: null });
    expect(await kie.poll('t')).toMatchObject({ state: 'fail', failMsg: 'content policy' });
  });

  it('parseResultUrls терпит мусор', () => {
    expect(parseResultUrls('')).toEqual([]);
    expect(parseResultUrls('{not json')).toEqual([]);
    expect(parseResultUrls(JSON.stringify({ resultUrls: ['https://ok/a.mp4', 42, 'ftp://x'] }))).toEqual(['https://ok/a.mp4']);
  });

  it('загрузка файла: multipart на хост загрузок, uploadPath проекта, ссылка из downloadUrl', async () => {
    const { fetch, seen } = fakeFetch(json({ code: 200, data: { downloadUrl: 'https://tempfile.example/up/hero.png' } }));
    const kie = createKieProvider({ apiKey: () => KEY, fetch });
    expect(await kie.upload(new Uint8Array([1, 2, 3]), 'hero.png', 'image/png')).toBe('https://tempfile.example/up/hero.png');
    expect(seen[0]?.url).toBe('https://kieai.redpandaai.co/api/file-stream-upload');
    const form = seen[0]?.body as FormData;
    expect(form.get('uploadPath')).toBe('seedance-prompter');
    expect((form.get('file') as File).size).toBe(3);
  });

  it('нет ключа — NO_KEY без обращения в сеть; сеть упала — NETWORK', async () => {
    const offline = fakeFetch(new TypeError('fetch failed'));
    expect(createKieProvider({ apiKey: () => null, fetch: offline.fetch }).hasKey()).toBe(false);
    await expect(createKieProvider({ apiKey: () => null, fetch: offline.fetch }).submit('m', {})).rejects.toMatchObject({ code: 'NO_KEY' });
    expect(offline.seen).toHaveLength(0);
    await expect(createKieProvider({ apiKey: () => KEY, fetch: offline.fetch }).balance?.()).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('download-url: запасная ссылка или null при отказе', async () => {
    const { fetch } = fakeFetch(json({ code: 200, data: 'https://tempfile.example/fresh.png' }), json({ code: 422, msg: 'not a kie url' }));
    const kie = createKieProvider({ apiKey: () => KEY, fetch });
    expect(await kie.freshUrl('https://tempfile.example/a.png')).toBe('https://tempfile.example/fresh.png');
    expect(await kie.freshUrl('https://other.example/a.png')).toBeNull();
  });
});
