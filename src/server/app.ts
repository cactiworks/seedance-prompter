import { Hono } from 'hono';
import { APP_NAME, APP_VERSION } from '../core/meta.ts';

export const HOST = '127.0.0.1';
export const PORT = 4317;

/** Заголовок, который обязан прислать наш клиент на любой мутации. */
export const CLIENT_HEADER = 'x-sp-client';

const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createApp() {
  const app = new Hono();

  // Сервер локальный, но любая веб-страница в браузере владельца может стучаться в localhost.
  // Без этих проверок она смогла бы тратить квоту LLM и читать референсы.
  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!ALLOWED_HOSTS.has(host)) return c.json({ error: 'FORBIDDEN_HOST' }, 403);

    const origin = c.req.header('origin');
    if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
      return c.json({ error: 'FORBIDDEN_ORIGIN' }, 403);
    }
    if (!SAFE_METHODS.has(c.req.method) && c.req.header(CLIENT_HEADER) === undefined) {
      return c.json({ error: 'MISSING_CLIENT_HEADER' }, 403);
    }
    await next();
  });

  const routes = app.get('/api/health', (c) =>
    c.json({ ok: true, name: APP_NAME, version: APP_VERSION }),
  );

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
