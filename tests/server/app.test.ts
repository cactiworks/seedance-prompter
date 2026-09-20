import { describe, expect, it } from 'vitest';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';

const host = `${HOST}:${PORT}`;

describe('API: защита локального сервера', () => {
  const app = createApp();

  it('отвечает на health с правильным Host', async () => {
    const res = await app.request('/api/health', { headers: { host } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: 'seedance-prompter' });
  });

  it('отклоняет чужой Host (DNS rebinding)', async () => {
    const res = await app.request('/api/health', { headers: { host: 'evil.example:4317' } });
    expect(res.status).toBe(403);
  });

  it('отклоняет чужой Origin', async () => {
    const res = await app.request('/api/health', {
      headers: { host, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('требует заголовок клиента на мутациях', async () => {
    const denied = await app.request('/api/health', { method: 'POST', headers: { host } });
    expect(denied.status).toBe(403);

    const allowed = await app.request('/api/health', {
      method: 'POST',
      headers: { host, [CLIENT_HEADER]: '1' },
    });
    expect(allowed.status).not.toBe(403);
  });
});
