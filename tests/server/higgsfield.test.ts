import { describe, expect, it } from 'vitest';
import { createHiggsfieldProvider } from '../../src/server/gen/higgsfield.ts';
import { GenError } from '../../src/server/gen/provider.ts';
import { seedanceTariff } from '../../src/server/gen/seedancePricing.ts';

const KEY = 'kid:secret';
const SELF_SERVE = 'Standard self-serve rates in USD per video second: 480p: $0.1177; 720p: $0.2647; 1080p: $0.6518. Total price = selected rate × output duration in seconds.';
const REFERENCE = 'Standard self-serve rates in USD per second of generated video.\n\n- Without video input: 480p: $0.1177; 720p: $0.2647; 1080p: $0.6518.\n- With video input: 480p: $0.1387; 720p: $0.3264; 1080p: $0.7858.\n\nTotal price = selected rate × output duration in seconds. Input video duration is not added to the billed duration. Image or audio references alone use the rate without video input.';
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

  it('calculates an explicitly approximate Seedance estimate from the live tariff shape', async () => {
    const description='For 16:9 video without video input, your request costs roughly $0.2056 per second of generated video at 480p, $0.4622 at 720p, and $1.1372 at 1080p. Actual pricing depends on output dimensions and billable duration. Rates shown are before any applicable customer discount.';
    for (const [resolution,usd] of [['480p',0.8224],['720p',1.8488],['1080p',4.5488]] as const) {
      const {fetch}=fakeFetch(json({type:'description',pricing_description:description}));
      const hf=createHiggsfieldProvider({apiKey:()=>KEY,fetch});
      expect(await hf.estimate!('bytedance/seedance-2.5/image-to-video',{duration:4,resolution})).toMatchObject({usd,credits:usd,unitRu:'$',approximate:true,pricingDescription:description});
    }
  });
  it.each(['text-to-video', 'image-to-video', 'reference-to-video'])('reads the current self-serve tariff for %s without submitting', async route => {
    const description = route === 'reference-to-video' ? REFERENCE : SELF_SERVE;
    for (const [resolution, usd] of [['480p', 0.5885], ['720p', 1.3235], ['1080p', 3.259]] as const) {
      const { fetch, seen } = fakeFetch(json({ type: 'description', pricing_description: description }));
      const hf = createHiggsfieldProvider({ apiKey: () => KEY, fetch });
      const price = await hf.estimate!(`bytedance/seedance-2.5/${route}`, { duration: 5, resolution });
      expect(price).toMatchObject({ usd, credits: usd, unitRu: '$', approximate: true, pricingDescription: description });
      expect(price.pricingNote).not.toContain('16:9');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toContain('/estimate/');
    }
  });
  it('normalizes provider whitespace and reads live rates rather than fixed catalog prices', () => {
    const description = SELF_SERVE.replaceAll(' ', '\n  ').replace('0.1177', '0.1');
    expect(seedanceTariff('bytedance/seedance-2.5/text-to-video', { duration: 30, resolution: '480p' }, description)).toMatchObject({ usd: 3, pricingDescription: description });
  });
  it.each([
    SELF_SERVE.replace('0.1177', '0'), SELF_SERVE.replace('0.2647', '-0.2647'),
    SELF_SERVE.replace('720p:', '480p:'), SELF_SERVE.replace('USD', 'EUR'),
    SELF_SERVE.replace('output duration', 'input duration'), `${SELF_SERVE} Additional surcharge: $1.`,
    REFERENCE.replace('Without video input:', 'With video input:'), 'x'.repeat(6001),
  ])('rejects an unsupported tariff instead of guessing a price', description => {
    expect(() => seedanceTariff('bytedance/seedance-2.5/reference-to-video', { duration: 5, resolution: '480p' }, description)).toThrow(GenError);
  });
  it.each([
    { duration: 5, resolution: '4K' }, { duration: '5', resolution: '480p' },
    { duration: 3, resolution: '480p' }, { duration: 31, resolution: '480p' },
    { duration: 5, resolution: '480p', video_urls: ['https://example.com/video.mp4'] },
    { duration: 5, resolution: '480p', video_url: 'https://example.com/video.mp4' },
  ])('does not apply the image-only rate to unsupported inputs: %j', input => {
    expect(() => seedanceTariff('bytedance/seedance-2.5/reference-to-video', input, REFERENCE)).toThrow(GenError);
  });
  it('does not use Seedance tariffs for another model', () => {
    expect(() => seedanceTariff('other/model', { duration: 5, resolution: '480p' }, SELF_SERVE)).toThrow(GenError);
  });
  it.each([{type:'description',pricing_description:'Contact sales'}, {type:'description',pricing_description:'Price $0.01'}, {credits:null,usd:0.5}, {credits:true,usd:0.1}, {credits:'',usd:0.1}])('rejects unknown or nonnumeric price shapes without fallback: %j',async body=>{
    const {fetch}=fakeFetch(json(body));const hf=createHiggsfieldProvider({apiKey:()=>KEY,fetch});
    await expect(hf.estimate!('bytedance/seedance-2.5/text-to-video',{duration:4,resolution:'480p'})).rejects.toMatchObject({code:'PROVIDER'});
  });
  it('preserves exact account credits/USD when the endpoint supplies them',async()=>{
    const {fetch}=fakeFetch(json({credits:'42.000',usd:'0.210'}));const hf=createHiggsfieldProvider({apiKey:()=>KEY,fetch});
    expect(await hf.estimate!('bytedance/seedance-2.5/text-to-video',{})).toEqual({credits:42,usd:0.21});
  });
  it('prefers numeric account prices when a response also includes a tariff description', async () => {
    const {fetch}=fakeFetch(json({type:'description',pricing_description:'A human readable tariff',credits:42,usd:0.21}));
    const hf=createHiggsfieldProvider({apiKey:()=>KEY,fetch});
    expect(await hf.estimate!('bytedance/seedance-2.5/text-to-video',{})).toEqual({credits:42,usd:0.21});
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

describe('Higgsfield scene upload', () => {
  it('uses signed storage headers, never sends API auth to storage, and returns the public URL', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return requests.length === 1 ? json({ upload_url: 'https://storage.example/put', public_url: 'https://storage.example/image.png', upload_headers: { 'content-type': 'image/png', 'x-upload-test': 'signed' } }) : new Response(null, { status: 200 });
    }) as typeof fetch;
    const hf = createHiggsfieldProvider({ apiKey: () => KEY, fetch: fetchImpl });
    expect(await hf.upload(new Uint8Array([1, 2, 3]), 'scene.png', 'image/png')).toBe('https://storage.example/image.png');
    expect(requests[0]!.url).toBe('https://api.higgsfield.ai/files/generate-upload-url');
    expect(new Headers(requests[0]!.init!.headers).get('authorization')).toBe(`Key ${KEY}`);
    expect(new Headers(requests[1]!.init!.headers).get('authorization')).toBeNull();
    expect(new Headers(requests[1]!.init!.headers).get('x-upload-test')).toBe('signed');
    expect(requests[1]!.init).toMatchObject({ method: 'PUT', redirect: 'error' });
  });
  it('rejects a signed upload containing API authorization without sending the file', async () => {
    const { fetch, seen } = fakeFetch(json({ upload_url: 'https://storage.example/put', public_url: 'https://storage.example/image.png', upload_headers: { Authorization: 'do-not-forward' } }));
    const hf = createHiggsfieldProvider({ apiKey: () => KEY, fetch });
    await expect(hf.upload(new Uint8Array([1]), 'scene.png', 'image/png')).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});
