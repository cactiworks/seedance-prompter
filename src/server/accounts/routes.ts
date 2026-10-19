import { Hono } from 'hono';
import { AccountError, type Accounts } from './service.ts';

export function accountRoutes(accounts?: Accounts) {
  return new Hono()
    .onError((e, c) => {
      if (e instanceof AccountError) return c.json({ error: 'ACCOUNT_REQUIRED', messageRu: e.message }, e.status);
      // Never serialize raw CLI output, auth files or filesystem errors.
      return c.json({ messageRu: 'Не удалось подключить ChatGPT. Попробуй ещё раз.' }, 500);
    })
    .get('/', async c => c.json(accounts ? await accounts.status(c) : { enabled: false, status: 'disconnected' }))
    .post('/login', async c => accounts ? c.json(await accounts.login(c)) : c.json({ messageRu: 'Отдельные подключения не включены.' }, 404))
    .post('/logout', async c => { await accounts?.logout(c); return c.json({ enabled: !!accounts, status: 'disconnected' }); });
}
