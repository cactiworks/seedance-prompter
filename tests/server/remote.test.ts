import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asyncRequests } from '../../src/server/asyncRequests.ts';
import { createApp, HOST, PORT } from '../../src/server/app.ts';
import { readSecret } from '../../src/server/secrets.ts';

const headers = { host: `${HOST}:${PORT}`, 'x-sp-client': '1', 'content-type': 'application/json', prefer: 'respond-async' };
afterEach(() => vi.unstubAllEnvs());

describe('remote studio transport', () => {
  it('starts a mutation once and preserves status/body across repeated polling', async () => {
    const app = new Hono();
    asyncRequests(app);
    let finish!: () => void;
    let count = 0;
    app.post('/api/slow', async (c) => {
      count++;
      await new Promise<void>((resolve) => { finish = resolve; });
      return c.json({ value: (await c.req.json()).value }, 201);
    });
    const started = await app.request('/api/slow', { method: 'POST', headers, body: '{"value":42}' });
    expect(started.status).toBe(202);
    const url = `/api/requests/${started.headers.get('x-sp-request')}`;
    expect((await app.request(url)).status).toBe(202);
    finish();
    await vi.waitFor(async () => expect((await app.request(url)).status).toBe(201));
    expect(await (await app.request(url)).json()).toEqual({ value: 42 });
    expect(count).toBe(1);
    await app.request(url, { method: 'DELETE' });
    expect((await app.request(url)).status).toBe(410);
  });
  it('cancels the original signal and never restarts an unknown request', async () => {
    const app = new Hono();
    asyncRequests(app);
    let signal!: AbortSignal;
    app.post('/api/slow', (c) => {
      signal = c.req.raw.signal;
      return new Promise<Response>((resolve) => signal.addEventListener('abort', () => resolve(new Response(null, { status: 499 }))));
    });
    const started = await app.request('/api/slow', { method: 'POST', headers, body: '{}' });
    await app.request(`/api/requests/${started.headers.get('x-sp-request')}`, { method: 'DELETE' });
    expect(signal.aborted).toBe(true);
    expect((await app.request('/api/requests/unknown')).status).toBe(410);
  });
  it('keeps Host, Origin and client gates in front of asynchronous work', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-remote-'));
    const app = createApp({ rootDir: process.cwd(), dataDir, publicOrigins: ['https://studio.example'] });
    for (const bad of [{ ...headers, host: 'evil.example' }, { ...headers, origin: 'https://evil.example' }, { host: headers.host, prefer: headers.prefer }]) {
      expect((await app.request('/api/projects', { method: 'POST', headers: bad, body: '{}' })).status).toBe(403);
    }
    const response = await app.request('/api/health', { headers: { host: headers.host, origin: 'https://studio.example' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(() => createApp({ rootDir: process.cwd(), dataDir, publicOrigins: ['http://studio.example'] })).toThrow();
  });
  it('reads only allowlisted private systemd credentials, never environment values', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-secrets-'));
    vi.stubEnv('CREDENTIALS_DIRECTORY', dir);
    writeFileSync(path.join(dir, 'kie-api-key'), 'fixture-key-123', { mode: 0o600 });
    writeFileSync(path.join(dir, 'higgsfield-api-key'), 'fixture:secret', { mode: 0o644 });
    expect(readSecret('kie-api-key')).toBe('fixture-key-123');
    expect(readSecret('higgsfield-api-key')).toBeNull();
    expect(readSecret('../kie-api-key')).toBeNull();
    const serviceDir = mkdtempSync(path.join(tmpdir(), 'sp-service-secrets-'));
    vi.stubEnv('CREDENTIALS_DIRECTORY', serviceDir);
    writeFileSync(path.join(serviceDir, 'higgsfield-api-key'), 'fixture:service-secret', { mode: 0o440 });
    expect(readSecret('higgsfield-api-key')).toBe('fixture:service-secret');
  });
});
