import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';

interface Pending {
  controller: AbortController;
  response?: Response;
  expires: number;
}

/** Transport only: the original route owns validation, costs and idempotency. Never retries work. */
export function asyncRequests(app: Hono): void {
  const requests = new Map<string, Pending>();
  const lifetime = 30 * 60_000;
  const prune = (): void => {
    for (const [id, item] of requests) if (item.expires < Date.now()) {
      item.controller.abort();
      requests.delete(id);
    }
  };
  const pending = (id: string): Response => Response.json({ requestId: id }, {
    status: 202, headers: { 'x-sp-request': id, 'cache-control': 'private, no-store' },
  });
  app.get('/api/requests/:id', (c) => {
    prune();
    const id = c.req.param('id');
    const item = requests.get(id);
    if (!item) return c.json({ error: 'REQUEST_EXPIRED', messageRu: 'Сервер перезапущен или результат ожидания истёк. Обнови данные перед повтором действия: запрос автоматически не повторялся.' }, 410);
    return item.response?.clone() ?? pending(id);
  });
  app.delete('/api/requests/:id', (c) => {
    const item = requests.get(c.req.param('id'));
    item?.controller.abort();
    requests.delete(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.use('/api/*', async (c, next) => {
    if (c.req.header('prefer') !== 'respond-async' || c.req.method !== 'POST' || !c.req.header('content-type')?.startsWith('application/json')) return next();
    prune();
    if (requests.size >= 128) return c.json({ error: 'BUSY', messageRu: 'Слишком много ожидающих запросов. Попробуй позже.' }, 503);
    // Consume the bounded JSON before acknowledging: upload failures never start the action.
    const body = await c.req.text();
    if (Buffer.byteLength(body) > 40 * 1024 * 1024) return c.json({ error: 'TOO_LARGE' }, 413);
    const id = randomUUID();
    const item: Pending = { controller: new AbortController(), expires: Date.now() + lifetime };
    const headers = new Headers(c.req.raw.headers);
    headers.delete('prefer');
    headers.delete('content-length');
    requests.set(id, item);
    const timeout = setTimeout(() => item.controller.abort(), lifetime);
    timeout.unref();
    const completion = Promise.resolve(app.fetch(new Request(c.req.url, { method: 'POST', headers, body, signal: item.controller.signal })))
      .then(async (response) => {
        // Materialize once so polling can repeat GET after a lost response, never POST.
        item.response = new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
        item.response.headers.set('cache-control', 'private, no-store');
        item.expires = Date.now() + lifetime;
        console.info(JSON.stringify({ event: 'request_complete', requestId: id, method: 'POST', path: new URL(c.req.url).pathname, status: response.status }));
      })
      .catch(() => { item.response = Response.json({ error: 'REQUEST_FAILED', messageRu: 'Не удалось получить результат. Обнови данные перед повтором действия.' }, { status: 500 }); })
      .finally(() => clearTimeout(timeout));
    // Fast mutations keep their ordinary response; only long work needs polling.
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([completion, new Promise<void>((resolve) => { grace = setTimeout(resolve, 75); })]);
    clearTimeout(grace);
    if (item.response) {
      requests.delete(id);
      return item.response.clone();
    }
    return pending(id);
  });
}
