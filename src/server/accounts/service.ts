import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { ChatgptAccount } from '../../core/chatgpt.ts';
import { LlmError, runCodex } from '../llm/codexCli/provider.ts';
import type { Runner } from '../llm/tasks/write.ts';
import { deviceLogin, type DeviceLogin } from './deviceLogin.ts';
import { apiLogin, type ApiLogin } from './apiLogin.ts';
import { apiBaseUrl } from './apiConnection.ts';

const AGE = 180 * 24 * 60 * 60;
const PROFILE = /^[a-f0-9-]{36}$/;
interface Session { profile?: string; expires: number }
interface Attempt { controller: AbortController; home: string; state: ChatgptAccount; done: Promise<void> }
export class AccountError extends Error {
  readonly status: 401 | 409 | 422 | 429;
  constructor(message: string, status: 401 | 409 | 422 | 429 = 401) { super(message); this.status = status; }
}
const required = () => new AccountError('Подключи ChatGPT или API key кнопкой вверху студии, затем повтори действие.');

/** Private credentials and opaque browser sessions live outside shared studio data. */
export function createAccounts(options: { dir: string; secureCookie: boolean; login?: DeviceLogin; apiLogin?: ApiLogin; allowedApiBaseUrls?: string[]; run?: typeof runCodex; now?: () => number }) {
  const root = path.resolve(options.dir);
  const cookieName = options.secureCookie ? '__Host-sp_chatgpt' : 'sp_chatgpt';
  const now = options.now ?? Date.now;
  const allowedApiBaseUrls = options.allowedApiBaseUrls ?? (process.env.SP_LLM_API_BASE_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const attempts = new Map<string, Attempt>();
  const active = new Map<string, number>();
  const invalid = new Set<string>();
  const locks = new Map<string, Promise<unknown>>();
  let recent: number[] = [];
  let starting = 0;
  const homeFor = (id: string) => { if (!PROFILE.test(id)) throw required(); return path.join(root, 'profiles', id); };
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  const keyFor = (c: Context) => { const token = getCookie(c, cookieName); return token && /^[a-f0-9]{64}$/.test(token) ? hash(token) : undefined; };
  const sessionFile = (key: string) => path.join(root, 'sessions', `${key}.json`);
  async function save(key: string, session: Session) {
    const file = sessionFile(key); const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(session), { mode: 0o600 }); await rename(tmp, file);
  }
  async function read(key: string | undefined): Promise<Session | undefined> {
    if (!key) return;
    try { const session = JSON.parse(await readFile(sessionFile(key), 'utf8')) as Session; return session.expires > now() ? session : undefined; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  }
  async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (locks.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => undefined);
    locks.set(key, tail);
    try { return await result; } finally { if (locks.get(key) === tail) locks.delete(key); }
  }
  async function ensure(c: Context) {
    const oldKey = keyFor(c); const old = await read(oldKey);
    if (oldKey && old) return { key: oldKey, session: old };
    for (const dir of [root, path.join(root, 'sessions'), path.join(root, 'profiles')]) { await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700); }
    const token = randomBytes(32).toString('hex'); const key = hash(token); const session: Session = { expires: now() + AGE * 1000 };
    await save(key, session);
    setCookie(c, cookieName, token, { httpOnly: true, secure: options.secureCookie, sameSite: 'Strict', path: options.secureCookie ? '/' : '/api', maxAge: AGE });
    return { key, session };
  }
  async function identity(profile: string): Promise<{ method:'chatgpt' | 'api'; baseUrl?: string; email?: string; plan?: string } | undefined> {
    if (invalid.has(profile)) return;
    try {
      const auth = JSON.parse(await readFile(path.join(homeFor(profile), 'auth.json'), 'utf8')) as { auth_mode?: string; OPENAI_API_KEY?: unknown; tokens?: { access_token?: string; refresh_token?: string; id_token?: string } };
      if ((auth.auth_mode === 'apikey' || auth.auth_mode === undefined) && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) {
        const connection = JSON.parse(await readFile(path.join(homeFor(profile),'connection.json'),'utf8')) as {baseUrl:unknown};
        try { return { method:'api', baseUrl:apiBaseUrl(connection.baseUrl, allowedApiBaseUrls) }; } catch { return; }
      }
      if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token || !auth.tokens.refresh_token) return;
      let claims: { email?: unknown; 'https://api.openai.com/auth'?: { chatgpt_plan_type?: unknown } } = {};
      try { claims = JSON.parse(Buffer.from(auth.tokens.id_token?.split('.')[1] ?? '', 'base64url').toString()) as typeof claims; } catch { /* metadata is optional */ }
      const plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type;
      return { method:'chatgpt', email: typeof claims.email === 'string' ? claims.email.slice(0, 254) : undefined, plan: typeof plan === 'string' ? plan.slice(0, 40) : undefined };
    } catch (e) { if (e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  }
  async function status(c: Context): Promise<ChatgptAccount> {
    const key = keyFor(c); const session = await read(key);
    if (!session || !key) return { enabled: true, status: 'disconnected' };
    const attempt = attempts.get(key);
    if (attempt) return attempt.state;
    const user = session.profile ? await identity(session.profile) : undefined;
    return user ? { enabled: true, status: 'connected', ...user } : { enabled: true, status: 'disconnected', ...(session.profile ? { message: 'Подключение больше не действует. Подключи ChatGPT или API key заново.' } : {}) };
  }
  async function requireAccount(c: Context): Promise<string> {
    const session = await read(keyFor(c));
    if (!session?.profile || !await identity(session.profile)) throw required();
    return session.profile;
  }
  const runnerFor = (profile?: string): Runner => async request => {
    if (!profile) throw new LlmError('NOT_LOGGED_IN', required().message);
    return serialized(`call:${profile}`, async () => {
      active.set(profile, (active.get(profile) ?? 0) + 1);
      try {
        const user = await identity(profile);
        if (!user) throw new LlmError('NOT_LOGGED_IN', 'Подключение, с которого запущен этот этап, отключено. Подключи его и явно повтори этап.');
        return await (options.run ?? runCodex)(request, { codexHome: homeFor(profile), authMethod:user.method, apiBaseUrl:user.baseUrl });
      }
      catch (e) {
        if (e instanceof LlmError && e.code === 'NOT_LOGGED_IN') {
          invalid.add(profile);
          await rm(path.join(homeFor(profile), 'auth.json'), { force: true });
          throw new LlmError('NOT_LOGGED_IN', 'Подключение отклонено. Подключи ChatGPT или новый API key кнопкой вверху студии.');
        }
        throw e;
      } finally { active.set(profile, Math.max(0, (active.get(profile) ?? 1) - 1)); }
    });
  };
  async function disconnect(key: string, session: Session) {
    if (session.profile && active.get(session.profile)) throw new AccountError('Дождись текущего вызова Codex или останови его перед отключением.', 409);
    const attempt = attempts.get(key); attempts.delete(key); attempt?.controller.abort();
    if (session.profile) {
      invalid.add(session.profile);
      await rm(path.join(homeFor(session.profile), 'auth.json'), { force: true });
    }
    delete session.profile; await save(key, session);
  }
  return {
    status, requireAccount, runnerFor,
    runner: async (c: Context) => runnerFor(await requireAccount(c)),
    async connectApi(c: Context, value: unknown, baseUrlInput?: unknown): Promise<ChatgptAccount> {
      if (typeof value !== 'string' || !/^[\x21-\x7e]{16,1024}$/.test(value.trim())) throw new AccountError('Вставь API key целиком, без пробелов и переносов строк.', 422);
      let baseUrl: string;
      try { baseUrl = apiBaseUrl(baseUrlInput, allowedApiBaseUrls); }
      catch { throw new AccountError('Нужен HTTPS Base URL разрешённого API-сервиса, без ключа, query и fragment. Этот адрес должен быть настроен владельцем студии.',422); }
      recent = recent.filter(t => now() - t < 60_000);
      if (recent.length >= 12) throw new AccountError('Слишком много попыток подключения. Подожди минуту.', 429);
      recent.push(now());
      const ensured = await ensure(c);
      return serialized(ensured.key, async () => {
        const session = await read(ensured.key) ?? ensured.session;
        if (session.profile && active.get(session.profile)) throw new AccountError('Дождись текущего вызова Codex или останови его перед сменой подключения.', 409);
        const profile = randomUUID(); const home = homeFor(profile);
        await mkdir(home, { recursive:true, mode:0o700 });
        try {
          await writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode:0o600 });
          await writeFile(path.join(home,'connection.json'),JSON.stringify({baseUrl}),{mode:0o600});
          await (options.apiLogin ?? apiLogin)(home, value.trim(), AbortSignal.timeout(10_000));
          if ((await identity(profile))?.method !== 'api') throw new Error('API credentials missing');
          await chmod(path.join(home, 'auth.json'), 0o600);
        } catch {
          await rm(home, { recursive:true, force:true });
          throw new AccountError('Не удалось сохранить API-подключение. Предыдущее подключение сохранено; попробуй ещё раз.', 409);
        }
        const previous = session.profile;
        try {
          if (previous && active.get(previous)) throw new AccountError('Дождись текущего вызова Codex перед сменой подключения.', 409);
          await serialized(`call:${previous ?? profile}`, async () => {
            // Publish the new binding before retiring the old credential. A failed save
            // leaves the working connection intact, and queued calls recheck identity.
            await save(ensured.key, { ...session, profile });
            const attempt = attempts.get(ensured.key); attempts.delete(ensured.key); attempt?.controller.abort();
            if (previous) { invalid.add(previous); await rm(path.join(homeFor(previous), 'auth.json'), { force:true }).catch(() => undefined); }
          });
        } catch (e) {
          await rm(home, { recursive:true, force:true });
          if (e instanceof AccountError) throw e;
          throw new AccountError('Не удалось сохранить API-подключение. Попробуй ещё раз.', 409);
        }
        return { enabled:true, status:'connected', method:'api', baseUrl };
      });
    },
    async login(c: Context): Promise<ChatgptAccount> {
      // Global bound also applies to clients that discard their cookie.
      recent = recent.filter(t => now() - t < 60_000);
      if (recent.length >= 12 || starting + [...attempts.values()].filter(a => a.state.status === 'connecting').length >= 6) throw new AccountError('Слишком много попыток входа. Подожди минуту.', 429);
      recent.push(now()); starting++;
      try {
        const ensured = await ensure(c); const { key } = ensured;
        return await serialized(key, async () => {
          const session = await read(key) ?? ensured.session;
          if (attempts.get(key)?.state.status === 'connecting') return attempts.get(key)!.state;
          if (session.profile && await identity(session.profile)) return status(c);
          await disconnect(key, session);
          const profile = randomUUID(); const home = homeFor(profile);
          await mkdir(home, { recursive: true, mode: 0o700 });
          await writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
          const attempt: Attempt = { controller: new AbortController(), home, state: { enabled: true, status: 'connecting' }, done: Promise.resolve() };
          attempts.set(key, attempt);
          const expires = now() + 15 * 60_000;
          const timeout = setTimeout(() => attempt.controller.abort(), 15 * 60_000); timeout.unref();
          attempt.done = (options.login ?? deviceLogin)(home, code => {
            if (attempts.get(key) === attempt && !attempt.controller.signal.aborted) attempt.state.login = { ...code, expiresAt: new Date(expires).toISOString() };
          }, attempt.controller.signal).then(async () => {
            const user = await identity(profile);
            if (user?.method !== 'chatgpt') throw new Error('Codex не сохранил вход через ChatGPT. Повтори подключение.');
            await serialized(key, async () => {
              if (attempts.get(key) !== attempt || attempt.controller.signal.aborted) return;
              await chmod(path.join(home, 'auth.json'), 0o600);
              session.profile = profile; await save(key, session);
              attempts.delete(key);
            });
          }).catch(() => {
            if (attempts.get(key) === attempt) attempt.state = { enabled: true, status: 'error', message: 'Вход не завершён. Попробуй ещё раз. Если OpenAI отклоняет вход по коду, включи device code login в настройках безопасности ChatGPT.' };
          }).finally(async () => {
            clearTimeout(timeout);
            if ((await read(key))?.profile !== profile) await rm(home, { recursive: true, force: true });
          });
          return attempt.state;
        });
      } finally { starting--; }
    },
    async logout(c: Context) {
      const key = keyFor(c); if (!key) return;
      await serialized(key, async () => { const session = await read(key); if (session) await disconnect(key, session); });
    },
    async close() { const jobs = [...attempts.values()]; for (const job of jobs) job.controller.abort(); await Promise.allSettled(jobs.map(a => a.done)); },
  };
}
export type Accounts = ReturnType<typeof createAccounts>;
