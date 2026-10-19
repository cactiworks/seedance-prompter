import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { archiveDirectory, downloadRoutes } from '../../src/server/downloads.ts';

it('exports a downloadable ZIP and rejects paths outside its private directory', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-archive-'));
  const source = mkdtempSync(path.join(tmpdir(), 'sp-export-'));
  writeFileSync(path.join(source, '01-image.txt'), 'synthetic fixture');
  const url = await archiveDirectory(dir, source);
  const app = new Hono();
  downloadRoutes(app, dir);
  const response = await app.request(url!);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toContain('attachment');
  expect(new Uint8Array(await response.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([80, 75]));
  expect((await app.request('/api/downloads/..%2fsecret')).status).toBe(404);
  expect((await app.request('/api/downloads/00000000-0000-0000-0000-000000000000')).status).toBe(404);
});
