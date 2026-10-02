import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GenJob, MediaItem } from '../../src/core/model/media.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import { GenError, type GenProvider, type PollResult } from '../../src/server/gen/provider.ts';
import { createGenRuntime, POLL_TIMEOUT_MS } from '../../src/server/gen/runtime.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const host = `${HOST}:${PORT}`;
const headers = { host, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };

const running: PollResult = { state: 'running', providerState: 'generating', urls: [], creditsConsumed: null, failMsg: null };
const success = (urls: string[], credits = 8): PollResult => ({ state: 'success', providerState: 'success', urls, creditsConsumed: credits, failMsg: null });

/** Провайдер-заглушка: запоминает вызовы, опрос отвечает из очереди. Сети нет. */
function mockProvider(patch: Partial<GenProvider> = {}) {
  const calls = { upload: [] as { fileName: string; mime: string; size: number }[], submit: [] as { model: string; input: Record<string, unknown> }[], poll: [] as string[], fresh: [] as string[] };
  const queue: PollResult[] = [];
  const provider: GenProvider = {
    id: 'kie',
    hasKey: () => true,
    upload: async (bytes, fileName, mime) => {
      calls.upload.push({ fileName, mime, size: bytes.byteLength });
      return `https://up.example/${fileName}`;
    },
    submit: async (model, input) => {
      calls.submit.push({ model, input });
      return `task-${calls.submit.length}`;
    },
    poll: async (taskId) => {
      calls.poll.push(taskId);
      return queue.shift() ?? running;
    },
    freshUrl: async (url) => {
      calls.fresh.push(url);
      return null;
    },
    balance: async () => 1234,
    ...patch,
  };
  return { provider, calls, queue };
}

/** CDN результатов: url → байты (или HTTP-статус ошибки). */
function mediaServer() {
  const files = new Map<string, { bytes: Uint8Array; type: string } | number>();
  const fetchImpl = (async (input: string | URL | Request) => {
    const entry = files.get(String(input));
    if (entry === undefined) return new Response('not found', { status: 404 });
    if (typeof entry === 'number') return new Response('error', { status: entry });
    return new Response(entry.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'content-type': entry.type } });
  }) as typeof fetch;
  return { files, fetch: fetchImpl };
}

function setup(patch: Partial<GenProvider> = {}, dataDir = mkdtempSync(path.join(tmpdir(), 'sp-gen-'))) {
  let t = Date.parse('2026-09-27T10:00:00Z');
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const mock = mockProvider(patch);
  const cdn = mediaServer();
  const gen = createGenRuntime({ dataDir, providers: { kie: mock.provider }, fetch: cdn.fetch, now: clock.now });
  const app = createApp({ rootDir: ROOT, dataDir, gen, reveal: false });
  const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return { app, gen, mock, cdn, clock, dataDir, post };
}

const imageJob = (patch: Record<string, unknown> = {}) => ({ modelId: 'kie/gpt-image-2-5', prompt: 'A red chair.', params: { resolution: '1K' }, confirmCredits: 6, ...patch });

describe('POST /api/gen/jobs — гейт до любой траты', () => {
  it('нет ключа → 412, провайдер не вызывается', async () => {
    const { post, mock } = setup({ hasKey: () => false });
    const res = await post('/api/gen/jobs', imageJob());
    expect(res.status).toBe(412);
    expect(mock.calls.submit).toHaveLength(0);
  });

  it('подтверждённая сумма не равна оценке → 409 с оценкой', async () => {
    const { post, mock } = setup();
    const res = await post('/api/gen/jobs', imageJob({ confirmCredits: 7.5 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'COST_CHANGED', estimate: { credits: 6, usd: 0.03 } });
    expect((await post('/api/gen/jobs', imageJob({ confirmCredits: undefined }))).status).toBe(409);
    expect(mock.calls.submit).toHaveLength(0);
  });

  it('рефы без согласия → 428; больше 4 задач → 422; кривое тело → 422', async () => {
    const { post, mock } = setup();
    const withRef = imageJob({ refs: [{ source: { type: 'projectRef', slug: 'demo', file: 'a.png' } }] });
    expect((await post('/api/gen/jobs', withRef)).status).toBe(428);
    expect((await post('/api/gen/jobs', imageJob({ count: 5, confirmCredits: 30 }))).status).toBe(422);
    expect((await post('/api/gen/jobs', { prompt: 42 })).status).toBe(422);
    expect(mock.calls.upload).toHaveLength(0);
    expect(mock.calls.submit).toHaveLength(0);
  });

  it('без клиентского заголовка задача не создаётся (CSRF)', async () => {
    const { app } = setup();
    const res = await app.request('/api/gen/jobs', { method: 'POST', headers: { host, 'content-type': 'text/plain' }, body: JSON.stringify(imageJob()) });
    expect(res.status).toBe(403);
  });
});

describe('жизненный цикл: задача → опрос сервером → файл в библиотеке', () => {
  it('Seedance с рефом проекта: загрузка, @Image1, опрос, скачивание, sha256, Range', async () => {
    const { app, gen, mock, cdn, clock, dataDir, post } = setup();
    await post('/api/projects', { slug: 'demo', title: 'Демо' });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await app.request('/api/projects/demo/refs/hero.png', { method: 'PUT', headers: { host, [CLIENT_HEADER]: '1' }, body: png });

    const res = await post('/api/gen/jobs', {
      modelId: 'kie/seedance-2-5',
      prompt: 'Hero <<<image_1>>> walks.',
      params: { resolution: '480p', durationSec: 4, aspectRatio: '9:16' },
      refs: [{ label: 'Герой', source: { type: 'projectRef', slug: 'demo', file: 'hero.png?v=123' } }],
      confirmCredits: 112,
      refsConsent: true,
      origin: { projectSlug: 'demo', shotId: 's1', attemptN: 1 },
    });
    expect(res.status).toBe(202);
    const [job] = ((await res.json()) as { jobs: GenJob[] }).jobs;
    expect(job).toMatchObject({ status: 'queued', taskId: 'task-1', prompt: 'Hero @Image1 walks.', estimateCredits: 112 });
    expect(mock.calls.upload).toEqual([{ fileName: 'hero.png', mime: 'image/png', size: 8 }]);
    expect(mock.calls.submit[0]).toEqual({
      model: 'bytedance/seedance-2-5',
      input: { prompt: 'Hero @Image1 walks.', resolution: '480p', aspect_ratio: '9:16', duration: 4, generate_audio: true, reference_image_urls: ['https://up.example/hero.png'] },
    });

    await gen.tick();
    expect(mock.calls.poll).toHaveLength(0); // рано: следующая проверка ещё не наступила

    clock.advance(10_000);
    await gen.tick();
    expect((await gen.jobs.get(job!.id))?.status).toBe('running');

    const video = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));
    cdn.files.set('https://cdn.example/out.mp4', { bytes: video, type: 'video/mp4' });
    mock.queue.push(success(['https://cdn.example/out.mp4'], 112));
    clock.advance(60_000);
    await gen.tick();

    const saved = await gen.jobs.get(job!.id);
    expect(saved).toMatchObject({ status: 'saved', creditsConsumed: 112, error: null });
    const library = ((await (await app.request('/api/library', { headers: { host } })).json()) as { items: MediaItem[] }).items;
    expect(library).toHaveLength(1);
    const item = library[0]!;
    expect(item).toMatchObject({ kind: 'video', mime: 'video/mp4', bytes: 64, taskId: 'task-1', prompt: 'Hero @Image1 walks.', sourceUrl: 'https://cdn.example/out.mp4', creditsConsumed: 112, origin: { shotId: 's1', attemptN: 1 } });
    expect(item.sha256).toBe(createHash('sha256').update(video).digest('hex'));
    expect(item.file).toMatch(/^2026-09\/m-[a-z0-9-]+\.mp4$/);
    expect(saved?.mediaIds).toEqual([item.id]);
    expect(existsSync(path.join(dataDir, 'library', item.file.replace('.mp4', '.json')))).toBe(true);
    expect(new Uint8Array(readFileSync(path.join(dataDir, 'library', item.file)))).toEqual(video);

    const full = await app.request(`/api/library/${item.id}/file`, { headers: { host } });
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(video);
    const part = await app.request(`/api/library/${item.id}/file`, { headers: { host, range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/64');
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([2, 3, 4, 5]);

    expect(((await (await app.request('/api/gen/jobs?slug=demo', { headers: { host } })).json()) as GenJob[]).length).toBe(1);
    expect(((await (await app.request('/api/gen/jobs?slug=other', { headers: { host } })).json()) as GenJob[]).length).toBe(0);
  });

  it('прямая ссылка протухла → запасная ссылка провайдера; в описании остаётся исходная', async () => {
    const { gen, mock, cdn, clock, post } = setup({ freshUrl: async () => 'https://cdn.example/fresh.png' });
    await post('/api/gen/jobs', imageJob());
    cdn.files.set('https://cdn.example/fresh.png', { bytes: new Uint8Array([7, 7, 7]), type: 'image/png' });
    mock.queue.push(success(['https://cdn.example/gone.png']));
    clock.advance(5_000);
    await gen.tick();
    const [item] = await gen.library.list();
    expect(item).toMatchObject({ kind: 'image', bytes: 3, sourceUrl: 'https://cdn.example/gone.png', file: expect.stringMatching(/\.png$/) as unknown });
  });

  it('скачивание не удаётся трижды → download_failed; «Скачать снова» дотягивает без новых кредитов', async () => {
    const { gen, mock, cdn, clock, post } = setup();
    const created = ((await (await post('/api/gen/jobs', imageJob())).json()) as { jobs: GenJob[] }).jobs[0]!;
    cdn.files.set('https://cdn.example/flaky.png', 500);
    mock.queue.push(success(['https://cdn.example/flaky.png']));
    clock.advance(5_000);
    await gen.tick();
    expect(await gen.jobs.get(created.id)).toMatchObject({ status: 'downloading', downloadAttempts: 1 });
    clock.advance(10_000);
    await gen.tick();
    clock.advance(60_000);
    await gen.tick();
    const failed = await gen.jobs.get(created.id);
    expect(failed).toMatchObject({ status: 'download_failed', downloadAttempts: 3, error: { code: 'DOWNLOAD_FAILED' } });

    cdn.files.set('https://cdn.example/flaky.png', { bytes: new Uint8Array([1]), type: 'image/png' });
    const retried = await post(`/api/gen/jobs/${created.id}/retry`, {});
    expect(retried.status).toBe(200);
    await gen.tick();
    expect((await gen.jobs.get(created.id))?.status).toBe('saved');
    expect(mock.calls.submit).toHaveLength(1);
  });

  it('провайдер отказал → failed с причиной; повтор — только новой генерацией', async () => {
    const { gen, mock, clock, post } = setup();
    const created = ((await (await post('/api/gen/jobs', imageJob())).json()) as { jobs: GenJob[] }).jobs[0]!;
    mock.queue.push({ state: 'fail', providerState: 'fail', urls: [], creditsConsumed: 0, failMsg: 'content policy' });
    clock.advance(5_000);
    await gen.tick();
    expect(await gen.jobs.get(created.id)).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_FAIL', messageRu: expect.stringContaining('content policy') as unknown } });
    expect((await post(`/api/gen/jobs/${created.id}/retry`, {})).status).toBe(409);
  });

  it('нет кредитов на первой задаче → остальные не отправляются', async () => {
    const { mock, post } = setup({
      submit: async () => {
        mock.calls.submit.push({ model: 'x', input: {} });
        throw new GenError('NO_CREDITS', 'На балансе KIE не хватает кредитов.');
      },
    });
    const body = (await (await post('/api/gen/jobs', imageJob({ count: 3, confirmCredits: 18 }))).json()) as { jobs: GenJob[] };
    expect(body.jobs.map((j) => j.status)).toEqual(['failed', 'failed', 'failed']);
    expect(body.jobs.every((j) => j.error?.code === 'NO_CREDITS')).toBe(true);
    expect(mock.calls.submit).toHaveLength(1);
  });

  it('ошибка опроса — не провал: задача ждёт дальше; таймаут → «Проверить снова»', async () => {
    let fail = true;
    const { gen, mock, cdn, clock, post } = setup({
      poll: async (taskId) => {
        mock.calls.poll.push(taskId);
        if (fail) throw new GenError('NETWORK', 'KIE не отвечает.');
        return mock.queue.shift() ?? running;
      },
    });
    const created = ((await (await post('/api/gen/jobs', imageJob())).json()) as { jobs: GenJob[] }).jobs[0]!;
    clock.advance(5_000);
    await gen.tick();
    expect(await gen.jobs.get(created.id)).toMatchObject({ status: 'queued', error: { code: 'POLL_NETWORK' } });

    fail = false;
    clock.advance(POLL_TIMEOUT_MS + 1);
    await gen.tick();
    expect(await gen.jobs.get(created.id)).toMatchObject({ status: 'failed', error: { code: 'POLL_TIMEOUT' } });

    expect((await post(`/api/gen/jobs/${created.id}/retry`, {})).status).toBe(200);
    cdn.files.set('https://cdn.example/late.png', { bytes: new Uint8Array([9]), type: 'image/png' });
    mock.queue.push(success(['https://cdn.example/late.png']));
    await gen.tick();
    expect((await gen.jobs.get(created.id))?.status).toBe('saved');
  });
});

describe('перезапуск сервера', () => {
  it('задача с taskId продолжает опрос; прерванная отправка — провал без повтора', async () => {
    const first = setup();
    const queued = ((await (await first.post('/api/gen/jobs', imageJob())).json()) as { jobs: GenJob[] }).jobs[0]!;
    const interrupted = await first.gen.jobs.put({ ...queued, id: 'j-interrupted-1', status: 'submitting', taskId: null });

    const second = setup({}, first.dataDir);
    await second.gen.recover();
    expect(await second.gen.jobs.get(interrupted.id)).toMatchObject({ status: 'failed', error: { code: 'SUBMIT_INTERRUPTED' } });
    second.clock.advance(5_000);
    await second.gen.tick();
    expect(second.mock.calls.poll).toEqual(['task-1']);
    expect(second.mock.calls.submit).toHaveLength(0);
  });
});

describe('GET /api/gen/status', () => {
  it('баланс — только по запросу', async () => {
    const { app } = setup();
    expect(await (await app.request('/api/gen/status', { headers: { host } })).json()).toEqual({ kie: { hasKey: true } });
    expect(await (await app.request('/api/gen/status?balance=1', { headers: { host } })).json()).toEqual({ kie: { hasKey: true, balance: 1234 } });
  });
});

describe('студия: сессии, загрузки, избранное', () => {
  it('сессия получает имя по первому промпту; сессия другого типа — отказ', async () => {
    const { app, post } = setup();
    const session = (await (await post('/api/studio/sessions', { kind: 'image' })).json()) as { id: string; title: string };
    expect(session.title).toBe('Новая сессия');
    const res = await post('/api/gen/jobs', imageJob({ prompt: 'Portrait of a woman in golden hour light', sessionId: session.id }));
    const [job] = ((await res.json()) as { jobs: GenJob[] }).jobs;
    expect(job?.sessionId).toBe(session.id);
    const list = (await (await app.request('/api/studio/sessions?kind=image', { headers: { host } })).json()) as { title: string }[];
    expect(list[0]?.title).toBe('Portrait of a woman in');
    expect((await post('/api/gen/jobs', { ...imageJob(), modelId: 'kie/kling-3', params: {}, confirmCredits: 70, sessionId: session.id })).status).toBe(422);
    expect(((await (await app.request(`/api/gen/jobs?sessionId=${session.id}`, { headers: { host } })).json()) as GenJob[]).length).toBe(1);
  });

  it('загрузка с диска становится референсом задачи; не картинка — 415', async () => {
    const { app, mock, post } = setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const up = await app.request('/api/uploads', { method: 'POST', headers: { host, [CLIENT_HEADER]: '1', 'content-type': 'image/png' }, body: png });
    expect(up.status).toBe(201);
    const { id } = (await up.json()) as { id: string };
    expect(new Uint8Array(await (await app.request(`/api/uploads/${id}`, { headers: { host } })).arrayBuffer())).toEqual(png);
    expect((await app.request('/api/uploads', { method: 'POST', headers: { host, [CLIENT_HEADER]: '1', 'content-type': 'text/plain' }, body: 'x' })).status).toBe(415);

    const res = await post('/api/gen/jobs', imageJob({ refs: [{ label: 'кадр', source: { type: 'upload', uploadId: id } }], refsConsent: true }));
    expect(res.status).toBe(202);
    expect(mock.calls.upload).toEqual([{ fileName: `${id}.png`, mime: 'image/png', size: 6 }]);
    expect(mock.calls.submit[0]).toMatchObject({ model: 'gpt-image-2-5-flare-image-to-image', input: { input_urls: [`https://up.example/${id}.png`] } });
  });

  it('Seedream: цена с картинками сверяется на сервере (+0.5 кр за каждую после первой)', async () => {
    const { app, post } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(((await (await app.request('/api/uploads', { method: 'POST', headers: { host, [CLIENT_HEADER]: '1', 'content-type': 'image/png' }, body: new Uint8Array([i]) })).json()) as { id: string }).id);
    const body = { modelId: 'kie/seedream-5-pro', prompt: 'x', params: { resolution: '2K' }, refs: ids.map((uploadId) => ({ source: { type: 'upload', uploadId } })), refsConsent: true };
    expect((await post('/api/gen/jobs', { ...body, confirmCredits: 14 })).status).toBe(409);
    expect((await post('/api/gen/jobs', { ...body, confirmCredits: 15 })).status).toBe(202);
  });

  it('избранное хранится на сервере', async () => {
    const { app, gen, mock, cdn, clock, post } = setup();
    await post('/api/gen/jobs', imageJob());
    cdn.files.set('https://cdn.example/f.png', { bytes: new Uint8Array([1]), type: 'image/png' });
    mock.queue.push(success(['https://cdn.example/f.png']));
    clock.advance(5_000);
    await gen.tick();
    const [item] = await gen.library.list();
    await post(`/api/library/${item!.id}/favorite`, { on: true });
    expect(((await (await app.request('/api/library', { headers: { host } })).json()) as { favorites: string[] }).favorites).toEqual([item!.id]);
  });
});

describe('Soul 2 через Higgsfield: тот же конвейер', () => {
  it('задача уходит провайдеру higgsfield, результат скачивается в библиотеку', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-soul-'));
    let t = Date.parse('2026-09-27T10:00:00Z');
    const hf = mockProvider({ id: 'higgsfield', balance: undefined });
    const cdn = mediaServer();
    const gen = createGenRuntime({ dataDir, providers: { higgsfield: hf.provider }, fetch: cdn.fetch, now: () => t });
    const app = createApp({ rootDir: ROOT, dataDir, gen });
    const res = await app.request('/api/gen/jobs', { method: 'POST', headers, body: JSON.stringify({ modelId: 'higgsfield/soul-2', prompt: 'Portrait', params: { resolution: '720p' }, confirmCredits: 0.004 }) });
    expect(res.status).toBe(202);
    expect(hf.calls.submit[0]).toMatchObject({ model: 'higgsfield-ai/soul/v2/standard', input: { resolution: '720p', batch_size: 1 } });
    cdn.files.set('https://cdn.hf/a.png', { bytes: new Uint8Array([5, 5]), type: 'image/png' });
    hf.queue.push(success(['https://cdn.hf/a.png'], 0));
    t += 5_000;
    await gen.tick();
    expect((await gen.library.list())[0]).toMatchObject({ provider: 'higgsfield', modelId: 'higgsfield/soul-2', bytes: 2 });
  });
});

describe('canvas: flows', () => {
  it('создать, сохранить, прочитать, удалить; кривое тело — 422', async () => {
    const { app, post } = setup();
    const flow = (await (await post('/api/canvas/flows', { name: 'Рекламный ролик' })).json()) as { id: string; name: string; nodes: unknown[] };
    expect(flow.name).toBe('Рекламный ролик');
    const node = { id: 'n1', type: 'prompt', x: 10, y: 20, text: 'hello' };
    const put = await app.request(`/api/canvas/flows/${flow.id}`, { method: 'PUT', headers, body: JSON.stringify({ ...flow, nodes: [node] }) });
    expect(put.status).toBe(200);
    const read = (await (await app.request(`/api/canvas/flows/${flow.id}`, { headers: { host } })).json()) as { nodes: { text: string; jobIds: string[] }[] };
    expect(read.nodes[0]).toMatchObject({ text: 'hello', jobIds: [] });
    expect((await app.request(`/api/canvas/flows/${flow.id}`, { method: 'PUT', headers, body: JSON.stringify({ id: flow.id }) })).status).toBe(422);
    expect(((await (await app.request('/api/canvas/flows', { headers: { host } })).json()) as unknown[]).length).toBe(1);
    expect((await app.request(`/api/canvas/flows/${flow.id}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await app.request(`/api/canvas/flows/${flow.id}`, { headers: { host } })).status).toBe(404);
  });
});

describe('папки библиотеки', () => {
  it('создать, положить, убрать, переименовать, удалить — файлы не трогаются', async () => {
    const { app, gen, mock, cdn, clock, post } = setup();
    await post('/api/gen/jobs', imageJob());
    cdn.files.set('https://cdn.example/p.png', { bytes: new Uint8Array([3]), type: 'image/png' });
    mock.queue.push(success(['https://cdn.example/p.png']));
    clock.advance(5_000);
    await gen.tick();
    const [item] = await gen.library.list();
    const folder = (await (await post('/api/library/folders', { name: 'Кроссовки' })).json()) as { id: string };
    let body = (await (await post(`/api/library/folders/${folder.id}/items`, { mediaIds: [item!.id, 'm-unknown-xxxx'], on: true })).json()) as { folders: { id: string; mediaIds: string[] }[] };
    expect(body.folders[0]?.mediaIds).toEqual([item!.id]);
    body = (await (await post(`/api/library/folders/${folder.id}/items`, { mediaIds: [item!.id], on: false })).json()) as typeof body;
    expect(body.folders[0]?.mediaIds).toEqual([]);
    await app.request(`/api/library/folders/${folder.id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: 'Проект А' }) });
    expect(((await (await app.request('/api/library', { headers: { host } })).json()) as { folders: { name: string }[] }).folders[0]?.name).toBe('Проект А');
    await app.request(`/api/library/folders/${folder.id}`, { method: 'DELETE', headers });
    const after = (await (await app.request('/api/library', { headers: { host } })).json()) as { folders: unknown[]; items: unknown[] };
    expect(after.folders).toEqual([]);
    expect(after.items).toHaveLength(1);
  });
});

describe('кадр из видео (ffmpeg)', () => {
  it('последний кадр → новая картинка библиотеки со ссылкой на видео; повтор отдаёт тот же кадр; не видео — 422', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-frame-'));
    let t = Date.parse('2026-09-27T10:00:00Z');
    const mock = mockProvider();
    const cdn = mediaServer();
    const gen = createGenRuntime({ dataDir, providers: { kie: mock.provider }, fetch: cdn.fetch, now: () => t });
    const calls: string[][] = [];
    const app = createApp({
      rootDir: ROOT,
      dataDir,
      gen,
      ffmpeg: async (args) => {
        calls.push(args);
        writeFileSync(args.at(-1) as string, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]));
      },
    });
    await app.request('/api/gen/jobs', { method: 'POST', headers, body: JSON.stringify({ modelId: 'kie/seedance-2-5', prompt: 'x', params: { resolution: '480p', durationSec: 4 }, confirmCredits: 112 }) });
    cdn.files.set('https://cdn.example/v.mp4', { bytes: new Uint8Array([1, 2, 3]), type: 'video/mp4' });
    mock.queue.push(success(['https://cdn.example/v.mp4'], 112));
    t += 10_000;
    await gen.tick();
    const [video] = await gen.library.list();

    const res = await app.request(`/api/library/${video!.id}/frame`, { method: 'POST', headers, body: JSON.stringify({ which: 'last' }) });
    expect(res.status).toBe(201);
    const frame = (await res.json()) as MediaItem;
    expect(frame).toMatchObject({ kind: 'image', modelId: 'local/frame', prompt: 'Последний кадр видео', bytes: 5, creditsConsumed: 0, refs: [{ source: { type: 'media', mediaId: video!.id } }] });
    expect(calls[0]?.slice(0, 2)).toEqual(['-sseof', '-0.1']);

    const again = await app.request(`/api/library/${video!.id}/frame`, { method: 'POST', headers, body: JSON.stringify({ which: 'last' }) });
    expect(again.status).toBe(200);
    expect(((await again.json()) as MediaItem).id).toBe(frame.id);
    expect(calls).toHaveLength(1);

    expect((await app.request(`/api/library/${frame.id}/frame`, { method: 'POST', headers, body: JSON.stringify({ which: 'first' }) })).status).toBe(422);
  });
});

describe('Soul 2: seed сохраняется с задачей, мудборды кешируются', () => {
  const soulSetup = (listStyles?: () => Promise<{ id: string; name: string; description: string; previewUrl: string | null }[]>) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-seed-'));
    const hf = mockProvider({ id: 'higgsfield', balance: undefined, ...(listStyles === undefined ? {} : { listStyles }) });
    const gen = createGenRuntime({ dataDir, providers: { higgsfield: hf.provider }, fetch: mediaServer().fetch, now: () => Date.parse('2026-09-28T10:00:00Z') });
    const app = createApp({ rootDir: ROOT, dataDir, gen });
    const post = (body: unknown) => app.request('/api/gen/jobs', { method: 'POST', headers, body: JSON.stringify(body) });
    return { app, hf, post };
  };

  it('случайный seed — конкретное число в параметрах задачи и в теле запроса; фиксированный ×2 — seed и seed+1', async () => {
    const { hf, post } = soulSetup();
    const random = (await (await post({ modelId: 'higgsfield/soul-2', prompt: 'Portrait', params: { resolution: '720p' }, count: 2, confirmCredits: 0.008 })).json()) as { jobs: GenJob[] };
    const seeds = random.jobs.map((j) => j.params.seed as number);
    expect(seeds.every((s) => Number.isInteger(s) && s >= 1 && s <= 1_000_000)).toBe(true);
    expect(hf.calls.submit.map((c) => c.input.seed)).toEqual(seeds);

    const locked = (await (await post({ modelId: 'higgsfield/soul-2', prompt: 'Portrait', params: { resolution: '720p', seed: 4242 }, count: 2, confirmCredits: 0.008 })).json()) as { jobs: GenJob[] };
    expect(locked.jobs.map((j) => j.params.seed)).toEqual([4242, 4243]);
    expect(hf.calls.submit.slice(2).map((c) => c.input.seed)).toEqual([4242, 4243]);
  });

  it('GET /api/gen/styles — список провайдера, второй запрос из кеша; у KIE мудбордов нет', async () => {
    let calls = 0;
    const { app } = soulSetup(async () => {
      calls += 1;
      return [{ id: 's1', name: 'Old smartphone', description: '', previewUrl: null }];
    });
    const first = await (await app.request('/api/gen/styles?provider=higgsfield', { headers: { host } })).json();
    await app.request('/api/gen/styles?provider=higgsfield', { headers: { host } });
    expect(first).toEqual([{ id: 's1', name: 'Old smartphone', description: '', previewUrl: null }]);
    expect(calls).toBe(1);
    expect(await (await app.request('/api/gen/styles?provider=kie', { headers: { host } })).json()).toEqual([]);
  });
});

describe('инструменты: обрезка (ffmpeg) и апскейл Topaz', () => {
  /** PNG-заголовок нужного размера — серверу для цены Topaz нужен только он. */
  const png = (width: number, height: number): Uint8Array => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return new Uint8Array(b);
  };

  it('обрезка — новая версия со ссылкой на исходник; Topaz: сервер меряет исходник, цена по результату, гейт держит', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-tools-'));
    let t = Date.parse('2026-09-28T10:00:00Z');
    const mock = mockProvider();
    const cdn = mediaServer();
    const gen = createGenRuntime({ dataDir, providers: { kie: mock.provider }, fetch: cdn.fetch, now: () => t });
    const calls: string[][] = [];
    const app = createApp({
      rootDir: ROOT,
      dataDir,
      gen,
      ffmpeg: async (args) => {
        calls.push(args);
        writeFileSync(args.at(-1) as string, png(1086, 1448));
      },
    });
    const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });
    await post('/api/gen/jobs', { modelId: 'kie/seedance-2-5', prompt: 'x', params: { resolution: '480p', durationSec: 4 }, confirmCredits: 112 });
    cdn.files.set('https://cdn.example/v.mp4', { bytes: new Uint8Array([1, 2, 3]), type: 'video/mp4' });
    mock.queue.push(success(['https://cdn.example/v.mp4'], 112));
    t += 10_000;
    await gen.tick();
    const [video] = await gen.library.list();
    const image = (await (await post(`/api/library/${video!.id}/frame`, { which: 'first' })).json()) as MediaItem;

    const cropped = await post(`/api/library/${image.id}/crop`, { x: 0.1, y: 0.2, w: 0.5, h: 0.4, labelRu: '1:1' });
    expect(cropped.status).toBe(201);
    expect((await cropped.json()) as MediaItem).toMatchObject({ modelId: 'local/crop', prompt: 'Обрезка · 1:1', creditsConsumed: 0, refs: [{ source: { type: 'media', mediaId: image.id } }] });
    expect(calls.at(-1)).toContain('crop=trunc(iw*0.5):trunc(ih*0.4):trunc(iw*0.1):trunc(ih*0.2)');
    expect((await post(`/api/library/${image.id}/crop`, { x: 0.6, y: 0, w: 0.5, h: 0.5 })).status).toBe(422);

    // Клиент ошибся в размере (999) — сервер перемерит: 1448 × 2 = 2896 px → 20 кр, а не 10.
    const upscale = (confirmCredits: number) => post('/api/gen/jobs', { modelId: 'kie/topaz-upscale', prompt: '', params: { upscaleFactor: '2', sourceSize: 999 }, refs: [{ source: { type: 'media', mediaId: image.id } }], confirmCredits, refsConsent: true });
    expect((await upscale(10)).status).toBe(409);
    const ok = await upscale(20);
    expect(ok.status).toBe(202);
    const job = ((await ok.json()) as { jobs: GenJob[] }).jobs[0];
    expect(job?.params).toMatchObject({ upscaleFactor: '2', sourceSize: 1448 });
    expect(mock.calls.submit.at(-1)).toEqual({ model: 'topaz/image-upscale', input: { image_url: expect.stringContaining('https://up.example/') as unknown, upscale_factor: '2' } });
  });
});

describe('обрезка видео по времени (ffmpeg)', () => {
  it('отрезок → новое видео со ссылкой на исходник; тот же отрезок — тот же файл; неверный отрезок и картинка — 422', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-trim-'));
    let t = Date.parse('2026-09-28T10:00:00Z');
    const mock = mockProvider();
    const cdn = mediaServer();
    const gen = createGenRuntime({ dataDir, providers: { kie: mock.provider }, fetch: cdn.fetch, now: () => t });
    const calls: string[][] = [];
    const app = createApp({
      rootDir: ROOT,
      dataDir,
      gen,
      ffmpeg: async (args) => {
        calls.push(args);
        writeFileSync(args.at(-1) as string, new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
      },
    });
    const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });
    await post('/api/gen/jobs', { modelId: 'kie/seedance-2-5', prompt: 'x', params: { resolution: '480p', durationSec: 4 }, confirmCredits: 112 });
    cdn.files.set('https://cdn.example/v.mp4', { bytes: new Uint8Array([1, 2, 3]), type: 'video/mp4' });
    mock.queue.push(success(['https://cdn.example/v.mp4'], 112));
    t += 10_000;
    await gen.tick();
    const [video] = await gen.library.list();

    const res = await post(`/api/library/${video!.id}/trim`, { start: 0.5, end: 3 });
    expect(res.status).toBe(201);
    const cut = (await res.json()) as MediaItem;
    expect(cut).toMatchObject({ kind: 'video', modelId: 'local/trim', prompt: 'Обрезка 0.5–3.0 с', creditsConsumed: 0, refs: [{ source: { type: 'media', mediaId: video!.id } }] });
    expect(calls[0]).toEqual(expect.arrayContaining(['-ss', '0.50', '-to', '3.00', 'libx264']));
    expect(((await (await post(`/api/library/${video!.id}/trim`, { start: 0.5, end: 3 })).json()) as MediaItem).id).toBe(cut.id);
    expect(calls).toHaveLength(1);

    expect((await post(`/api/library/${video!.id}/trim`, { start: 2, end: 1 })).status).toBe(422);
    const frame = (await (await post(`/api/library/${video!.id}/frame`, { which: 'first' })).json()) as MediaItem;
    expect((await post(`/api/library/${frame.id}/trim`, { start: 0, end: 1 })).status).toBe(422);
  });
});

describe('свои файлы в библиотеку', () => {
  it('видео и картинка импортируются с именем и типом; чужой формат — 415; своё видео режется как сгенерированное', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-import-'));
    const gen = createGenRuntime({ dataDir, providers: {} });
    const app = createApp({ rootDir: ROOT, dataDir, gen, ffmpeg: async (args) => writeFileSync(args.at(-1) as string, new Uint8Array([1, 2, 3])) });
    const upload = (type: string, name: string, bytes: Uint8Array) => app.request(`/api/library/import?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { host, [CLIENT_HEADER]: '1', 'content-type': type }, body: bytes as Uint8Array<ArrayBuffer> });
    const video = await upload('video/quicktime', 'съёмка на крыше.mov', new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70]));
    expect(video.status).toBe(201);
    const item = (await video.json()) as MediaItem;
    expect(item).toMatchObject({ kind: 'video', modelId: 'local/import', prompt: 'съёмка на крыше.mov', provider: 'local', creditsConsumed: 0, mime: 'video/quicktime' });
    expect(item.file).toMatch(/\.mov$/);
    expect((await upload('image/png', 'ref.png', new Uint8Array([0x89, 0x50]))).status).toBe(201);
    expect((await upload('application/pdf', 'doc.pdf', new Uint8Array([1]))).status).toBe(415);
    const cut = await app.request(`/api/library/${item.id}/trim`, { method: 'POST', headers, body: JSON.stringify({ start: 0, end: 1 }) });
    expect(cut.status).toBe(201);
  });
});

describe('размер под площадку (ffmpeg)', () => {
  it('файл библиотеки и картинка с диска → новый файл того же вида; стороны чётные; повтор — тот же файл', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-resize-'));
    const gen = createGenRuntime({ dataDir, providers: {} });
    const calls: string[][] = [];
    const app = createApp({ rootDir: ROOT, dataDir, gen, ffmpeg: async (args) => { calls.push(args); writeFileSync(args.at(-1) as string, new Uint8Array([1, 2, 3])); } });
    const video = (await (await app.request('/api/library/import?name=clip.mp4', { method: 'POST', headers: { host, [CLIENT_HEADER]: '1', 'content-type': 'video/mp4' }, body: new Uint8Array([0, 0, 0, 8]) })).json()) as MediaItem;
    const post = (body: unknown) => app.request('/api/media/resize', { method: 'POST', headers, body: JSON.stringify(body) });

    const res = await post({ source: { type: 'media', mediaId: video.id }, width: 1081, height: 1920, fit: 'cover' });
    expect(res.status).toBe(201);
    const out = (await res.json()) as MediaItem;
    expect(out).toMatchObject({ kind: 'video', modelId: 'local/resize', prompt: 'Размер 1080×1920 · заполнить', refs: [{ source: { type: 'media', mediaId: video.id } }] });
    expect(calls[0]).toContain('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1');
    expect(((await (await post({ source: { type: 'media', mediaId: video.id }, width: 1080, height: 1920, fit: 'cover' })).json()) as MediaItem).id).toBe(out.id);

    const upload = (await (await app.request('/api/uploads', { method: 'POST', headers: { host, [CLIENT_HEADER]: '1', 'content-type': 'image/png' }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })).json()) as { id: string };
    const img = await post({ source: { type: 'upload', uploadId: upload.id }, width: 1080, height: 1080, fit: 'contain' });
    expect(img.status).toBe(201);
    expect(((await img.json()) as MediaItem).kind).toBe('image');
    expect(calls.at(-1)).toContain('scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1');
    expect((await post({ source: { type: 'media', mediaId: video.id }, width: 8, height: 1920 })).status).toBe(422);
  });
});

describe('удаление и выгрузка для монтажа', () => {
  it('удаление: файл, описание, избранное, папки, оценка; задача без файлов уходит из ленты; идущую задачу не удалить', async () => {
    const { app, gen, mock, cdn, clock, dataDir, post } = setup();
    cdn.files.set('https://cdn.example/a.png', { bytes: new Uint8Array([7, 7, 7]), type: 'image/png' });
    const created = (await (await post('/api/gen/jobs', imageJob())).json()) as { jobs: GenJob[] };
    const jobId = created.jobs[0]?.id ?? '';
    expect((await app.request(`/api/gen/jobs/${jobId}`, { method: 'DELETE', headers })).status).toBe(409);
    mock.queue.push(success(['https://cdn.example/a.png'], 6));
    clock.advance(10_000);
    await gen.tick();
    const [item] = await gen.library.list();
    const file = path.join(dataDir, 'library', item!.file);
    await post(`/api/library/${item!.id}/favorite`, { on: true });
    const folder = (await (await post('/api/library/folders', { name: 'Рилсы' })).json()) as { id: string };
    await post(`/api/library/folders/${folder.id}/items`, { mediaIds: [item!.id], on: true });
    await app.request(`/api/verdicts/${item!.id}`, { method: 'PUT', headers, body: JSON.stringify({ verdict: 'bad', symptoms: ['text'] }) });

    const exported = (await (await post('/api/library/export', { mediaIds: [item!.id] })).json()) as { dir: string; files: string[] };
    expect(exported.files[0]).toMatch(/^01 GPT Image 2\.5 A red chair\.png$/);
    expect(existsSync(path.join(exported.dir, exported.files[0]!))).toBe(true);

    expect((await app.request(`/api/library/${item!.id}`, { method: 'DELETE', headers })).status).toBe(200);
    expect(existsSync(file)).toBe(false);
    const lib = (await (await app.request('/api/library', { headers: { host } })).json()) as { items: unknown[]; favorites: string[]; folders: { mediaIds: string[] }[] };
    expect(lib.items).toHaveLength(0);
    expect(lib.favorites).toEqual([]);
    expect(lib.folders[0]?.mediaIds).toEqual([]);
    expect((await (await app.request('/api/verdicts', { headers: { host } })).json()) as unknown[]).toEqual([]);
    expect(await gen.jobs.get(jobId)).toBeUndefined();
    expect(existsSync(exported.dir)).toBe(true);
  });
});

describe('апскейл видео Topaz (решение 39)', () => {
  it('сервер мерит длительность сам, замер для формы совпадает с гейтом; видео уходит в KIE, картинка и пустой вход — 422', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-topaz-video-'));
    const mock = mockProvider();
    const probed: string[] = [];
    const gen = createGenRuntime({
      dataDir,
      providers: { kie: mock.provider },
      probe: async (filePath) => {
        probed.push(filePath);
        return { durationSec: 5.04, width: 480, height: 854 };
      },
    });
    const app = createApp({ rootDir: ROOT, dataDir, gen, reveal: false });
    const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const upload = (type: string, name: string, bytes: Uint8Array) => app.request(`/api/library/import?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { host, [CLIENT_HEADER]: '1', 'content-type': type }, body: bytes as Uint8Array<ArrayBuffer> });
    const video = (await (await upload('video/quicktime', 'черновик.mov', new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70]))).json()) as MediaItem;
    const image = (await (await upload('image/png', 'кадр.png', new Uint8Array([0x89, 0x50]))).json()) as MediaItem;
    const source = { type: 'media', mediaId: video.id };

    // 5.04 с — секунд к оплате 5 (допуск на округление контейнера), а не 6.
    const measured = await post('/api/gen/measure', { modelId: 'kie/topaz-video-upscale', refs: [{ source }] });
    expect(measured.status).toBe(200);
    expect(await measured.json()).toEqual({ params: { sourceSec: 5 }, info: { width: 480, height: 854, durationSec: 5.04, bytes: 8 } });
    expect(probed.at(-1)).toMatch(/\.mov$/);

    // Клиент назвал 30 с — сервер перемерит: 2× = 8 кр/с × 5 = 40, а не 240.
    const run = (upscaleFactor: string, confirmCredits: number) => post('/api/gen/jobs', { modelId: 'kie/topaz-video-upscale', prompt: '', params: { upscaleFactor, sourceSec: 30 }, refs: [{ source }], confirmCredits, refsConsent: true });
    expect((await run('2', 240)).status).toBe(409);
    expect((await run('2', 70)).status).toBe(409);
    const ok = await run('2', 40);
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { jobs: GenJob[] }).jobs[0]?.params).toEqual({ upscaleFactor: '2', sourceSec: 5 });
    expect(mock.calls.upload.at(-1)).toMatchObject({ mime: 'video/quicktime', size: 8 });
    expect(mock.calls.submit.at(-1)).toEqual({ model: 'topaz/video-upscale', input: { video_url: expect.stringContaining('https://up.example/') as unknown, upscale_factor: '2' } });
    expect((await run('4', 70)).status).toBe(202);

    const wrong = await post('/api/gen/jobs', { modelId: 'kie/topaz-video-upscale', prompt: '', params: { upscaleFactor: '2' }, refs: [{ source: { type: 'media', mediaId: image.id } }], confirmCredits: 40, refsConsent: true });
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as { messageRu: string }).messageRu).toContain('нужно видео');
    expect((await post('/api/gen/measure', { modelId: 'kie/topaz-video-upscale', refs: [{ source: { type: 'upload', uploadId: 'u-1' } }] })).status).toBe(422);
    const empty = await post('/api/gen/jobs', { modelId: 'kie/topaz-video-upscale', prompt: '', params: { upscaleFactor: '2' }, confirmCredits: 40 });
    expect(empty.status).toBe(422);
    expect(((await empty.json()) as { messageRu: string }).messageRu).toContain('нужно входное видео');
    expect(mock.calls.submit).toHaveLength(2);
  });
});
