import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AccountError, type Accounts } from './service.ts';

export function accountRoutes(accounts?: Accounts) {
  return new Hono()
    .onError((e, c) => {
      if (e instanceof AccountError) return c.json({ error: 'ACCOUNT_REQUIRED', messageRu: e.message }, e.status);
      // Never serialize raw CLI output, auth files or filesystem errors.
      return c.json({ messageRu: 'Не удалось изменить AI-подключение. Попробуй ещё раз.' }, 500);
    })
    .get('/', async c => c.json(accounts ? await accounts.status(c) : { enabled: false, status: 'disconnected' }))
    .post('/api-key', bodyLimit({ maxSize:4096, onError:c => c.json({ messageRu:'Слишком большой запрос подключения.' },413) }), async c => {
      if (!accounts) return c.json({ messageRu:'Отдельные подключения не включены.' }, 404);
      let body: unknown;
      try { body = await c.req.json(); } catch { return c.json({ messageRu:'Нужен API key в JSON.' }, 422); }
      const fields = body && typeof body === 'object' ? body as Record<string,unknown> : {};
      return c.json(await accounts.connectApi(c,fields.apiKey,fields.baseUrl));
    })
    .post('/login', async c => accounts ? c.json(await accounts.login(c)) : c.json({ messageRu: 'Отдельные подключения не включены.' }, 404))
    .post('/logout', async c => { await accounts?.logout(c); return c.json({ enabled: !!accounts, status: 'disconnected' }); });
}
