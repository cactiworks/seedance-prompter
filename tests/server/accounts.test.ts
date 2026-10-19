import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatgptAccount } from '../../src/core/chatgpt.ts';
import { DEMO_INPUT, type ProductionRun } from '../../src/core/production/model.ts';
import { createApp, HOST, PORT } from '../../src/server/app.ts';
import { createAccounts, type Accounts } from '../../src/server/accounts/service.ts';
import { parseDeviceCode, type DeviceLogin } from '../../src/server/accounts/deviceLogin.ts';
import { LlmError, type runCodex } from '../../src/server/llm/codexCli/provider.ts';
import { createProductionRuntime, type ProductionRuntime } from '../../src/server/production/runtime.ts';
import { SCRIPT, sceneDraft, promptPlan } from '../production/fixtures.ts';

const headers = { host: `${HOST}:${PORT}`, 'x-sp-client': '1', 'content-type': 'application/json' };
const resources: { dir: string; accounts: Accounts; rt: ProductionRuntime }[] = [];
const fakeAuth = (email: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh', id_token: `fake.${Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })).toString('base64url')}.fake` } });
async function setup(run?: typeof runCodex, ignoreAbort = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-accounts-'));
  const logins: { home: string; finish: (email?: string) => Promise<void>; reject: () => void; signal: AbortSignal }[] = [];
  const login: DeviceLogin = (home, onCode, signal) => new Promise<void>((resolve, reject) => {
    const id = logins.length;
    onCode({ url: 'https://auth.openai.com/codex/device', code: `AAAA-${String(id).padStart(4, '0')}` });
    logins.push({ home, signal, finish: async (email = `user${id}@example.test`) => { await writeFile(path.join(home, 'auth.json'), fakeAuth(email)); resolve(); }, reject: () => reject(new Error('fake raw secret')) });
    if (!ignoreAbort) signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const homes: string[] = [];
  const runner: typeof runCodex = async <T>(request: Parameters<typeof runCodex>[0], options?: { codexHome?: string }) => {
    homes.push(options!.codexHome!);
    if (run) return run<T>(request, options);
    return { data: (request.taskRu === 'Режиссёр Production' ? sceneDraft() : promptPlan()) as T, meta: { model: 'fixture', durationMs: 1, inputTokens: 1, outputTokens: 1, turns: 1 } };
  };
  const accounts = createAccounts({ dir: path.join(dir, 'accounts'), secureCookie: true, login, run: runner });
  const rt = createProductionRuntime({ dataDir: path.join(dir, 'data'), runLlmForAccount: accounts.runnerFor });
  const app = createApp({ rootDir: process.cwd(), dataDir: path.join(dir, 'data'), accounts, production: rt });
  resources.push({ dir, accounts, rt });
  const req = (url: string, cookie = '', data?: object) => app.request(url, { headers: { ...headers, cookie }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}) });
  const status = async (cookie: string) => (await (await req('/api/chatgpt', cookie)).json()) as ChatgptAccount;
  async function connect() {
    const response = await req('/api/chatgpt/login', '', {});
    const cookieHeader = response.headers.get('set-cookie')!;
    expect(cookieHeader).toMatch(/^__Host-sp_chatgpt=/); expect(cookieHeader).toContain('Path=/;'); expect(cookieHeader).toContain('HttpOnly'); expect(cookieHeader).toContain('Secure'); expect(cookieHeader).toContain('SameSite=Strict');
    const cookie = cookieHeader.split(';')[0]!;
    const current = logins.at(-1)!; await current.finish();
    await vi.waitFor(async () => expect((await status(cookie)).status).toBe('connected'));
    return { cookie, home: current.home };
  }
  return { accounts, rt, app, req, status, connect, logins, homes, dir };
}
afterEach(async () => { for (const s of resources.splice(0)) { s.rt.stop(); await s.accounts.close(); await rm(s.dir, { recursive: true, force: true }); } });

describe('private browser ChatGPT connections', () => {
  it('parses only official device URL and code, ignoring ANSI and rejecting unrelated links', () => {
    expect(parseDeviceCode('\x1b[1mhttps://auth.openai.com/codex/device\x1b[0m\nABCD1-EFGH2')).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'ABCD1-EFGH2' });
    expect(parseDeviceCode('https://evil.test ABCD-EFGH')).toBeUndefined();
  });
  it('keeps two logins private and persists session routing without credentials in API responses', async () => {
    const s = await setup(); const a = await s.connect(); const b = await s.connect();
    expect(a.home).not.toBe(b.home);
    expect(await s.status(a.cookie)).toMatchObject({ status: 'connected', email: 'user0@example.test' });
    expect(await s.status(b.cookie)).toMatchObject({ status: 'connected', email: 'user1@example.test' });
    expect(await s.status('')).toEqual({ enabled: true, status: 'disconnected' });
    expect(await s.status(`__Host-sp_chatgpt=${path.basename(a.home)}`)).toMatchObject({ status: 'disconnected' });
    const data = JSON.stringify(await s.status(a.cookie));
    expect(data).not.toMatch(/fake-access|fake-refresh|id_token|profile|home/);
    expect((await stat(path.join(a.home, 'auth.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(s.dir, 'accounts'))).mode & 0o777).toBe(0o700);
    const sessions = await readdir(path.join(s.dir, 'accounts/sessions'));
    for (const file of sessions) expect(await readFile(path.join(s.dir, 'accounts/sessions', file), 'utf8')).not.toContain(a.cookie.split('=')[1]);
    const restarted = createAccounts({ dir: path.join(s.dir, 'accounts'), secureCookie: true });
    const app = createApp({ rootDir: process.cwd(), dataDir: path.join(s.dir, 'data'), accounts: restarted });
    expect(await (await app.request('/api/chatgpt', { headers: { ...headers, cookie: a.cookie } })).json()).toMatchObject({ email: 'user0@example.test' });
    await s.req('/api/chatgpt/logout', a.cookie, {});
    expect((await s.status(a.cookie)).status).toBe('disconnected');
    expect((await s.status(b.cookie)).status).toBe('connected');
    await expect(s.accounts.runnerFor(path.basename(a.home))({ system: '', user: '', jsonSchema: {}, model: 'fixture', timeoutMs: 1 })).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
    expect(s.homes).toHaveLength(0);
  });
  it('protects login endpoints with CSRF and excludes them from detached async transport', async () => {
    const s = await setup();
    expect((await s.app.request('/api/chatgpt/login', { method: 'POST', headers: { host: headers.host } })).status).toBe(403);
    expect((await s.app.request('/api/chatgpt/login', { method: 'POST', headers: { ...headers, origin: 'https://evil.test' } })).status).toBe(403);
    const start = await s.app.request('/api/chatgpt/login', { method: 'POST', headers: { ...headers, prefer: 'respond-async' }, body: '{}' });
    expect(start.status).toBe(200); expect(start.headers.get('set-cookie')).toBeTruthy(); expect(start.headers.get('x-sp-request')).toBeNull();
    expect(s.logins).toHaveLength(1);
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    expect((await s.status('')).login).toBeUndefined();
    expect((await s.status(cookie)).login?.code).toBe('AAAA-0000');
    await s.req('/api/chatgpt/logout', cookie, {});
    expect(s.logins[0]!.signal.aborted).toBe(true);
    expect((await s.status(cookie)).status).toBe('disconnected');
  });
  it('does not bind a cancelled late login and never returns raw login errors', async () => {
    const s = await setup();
    const start = await s.req('/api/chatgpt/login', '', {}); const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    s.logins[0]!.reject();
    await vi.waitFor(async () => expect((await s.status(cookie)).status).toBe('error'));
    expect(JSON.stringify(await s.status(cookie))).not.toContain('fake raw secret');
    await s.req('/api/chatgpt/login', cookie, {});
    await s.req('/api/chatgpt/logout', cookie, {});
    expect((await s.status(cookie)).status).toBe('disconnected');
  });
  it('discards a successful login that arrives after cancellation', async () => {
    const s = await setup(undefined, true);
    const start = await s.req('/api/chatgpt/login', '', {}); const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    await s.req('/api/chatgpt/logout', cookie, {});
    await s.logins[0]!.finish();
    await vi.waitFor(async () => expect(await stat(s.logins[0]!.home).catch(() => null)).toBeNull());
    expect((await s.status(cookie)).status).toBe('disconnected');
  });
  it('expires unattended login attempts without a model call', async () => {
    const s = await setup();
    vi.useFakeTimers();
    try {
      const start = await s.req('/api/chatgpt/login', '', {}); const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(s.logins[0]!.signal.aborted).toBe(true);
      expect((await s.status(cookie)).status).toBe('error');
      expect(s.homes).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
  it('bounds concurrent unauthenticated device attempts even when every request discards cookies', async () => {
    const s = await setup();
    const responses = await Promise.all(Array.from({ length: 20 }, () => s.req('/api/chatgpt/login', '', {})));
    expect(s.logins).toHaveLength(6);
    expect(responses.filter(r => r.status === 429)).toHaveLength(14);
  });
  it('fails closed on stale authentication and never falls back to the global CLI account', async () => {
    const s = await setup(async () => { throw new LlmError('NOT_LOGGED_IN', 'fake expired'); }); const a = await s.connect(); const b = await s.connect();
    const invoke = s.accounts.runnerFor(path.basename(a.home));
    const req = { system: '', user: '', jsonSchema: {}, model: 'fixture', timeoutMs: 1 };
    await expect(invoke(req)).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
    await expect(invoke(req)).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
    expect(s.homes).toEqual([a.home]);
    expect((await s.status(a.cookie)).status).toBe('disconnected');
    expect((await s.status(b.cookie)).status).toBe('connected');
  });
  it('does not disconnect credentials while a call is active', async () => {
    let finish!: () => void;
    const s = await setup(async <T>() => { await new Promise<void>(resolve => { finish = resolve; }); return { data: {} as T, meta: { model: 'fixture', durationMs: 1, turns: 1, inputTokens: 1, outputTokens: 1 } }; });
    const a = await s.connect();
    const running = s.accounts.runnerFor(path.basename(a.home))({ system: '', user: '', jsonSchema: {}, model: 'fixture', timeoutMs: 1 });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect((await s.req('/api/chatgpt/logout', a.cookie, {})).status).toBe(409);
    finish(); await running;
    expect((await s.req('/api/chatgpt/logout', a.cookie, {})).status).toBe(200);
  });
  it('routes shared series to the initiating account and requires a fresh explicit account on retry', async () => {
    const s = await setup(); const a = await s.connect(); const b = await s.connect();
    const input = { ...DEMO_INPUT, planningMode: 'codex', script: SCRIPT };
    expect((await s.req('/api/production', '', input)).status).toBe(401);
    expect(await s.rt.list()).toHaveLength(0);
    const created = await (await s.req('/api/production', a.cookie, input)).json() as ProductionRun;
    await s.rt.waitForPreparation(created.id);
    const saved = await s.rt.get(created.id);
    expect(saved.planned).toBe(true); expect(saved.preparation?.codexAccountId).toBe(path.basename(a.home));
    expect(s.homes).toEqual([a.home, a.home]);
    const shared = await (await s.req(`/api/production/${created.id}`, b.cookie)).json() as ProductionRun;
    expect(shared.scenePlan).toEqual(saved.scenePlan);
    const corrupt = { ...saved, planned: false, promptPlan: undefined, preparation: { ...saved.preparation!, status: 'failed', codexAccountId: undefined } };
    await writeFile(path.join(s.dir, 'data/production-mock', `${saved.id}.json`), JSON.stringify(corrupt));
    const retry = await s.req(`/api/production/${saved.id}/actions`, b.cookie, { type: 'retryPreparation', rev: saved.rev });
    expect(retry.status).toBe(200); await s.rt.waitForPreparation(saved.id);
    expect(s.homes.at(-1)).toBe(b.home);
    expect((await s.rt.get(saved.id)).preparation?.codexAccountId).toBe(path.basename(b.home));
    const spoof = await s.req('/api/production', b.cookie, { ...input, codexAccountId: path.basename(a.home) });
    expect(spoof.status).toBe(422);
  });
});
