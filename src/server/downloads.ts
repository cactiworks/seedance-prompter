import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { Hono } from 'hono';

const exec = promisify(execFile);
export async function archiveDirectory(dataDir: string, directory: string): Promise<string | undefined> {
  const files = (await readdir(directory, { withFileTypes: true })).filter((f) => f.isFile()).map((f) => f.name);
  if (!files.length) return undefined;
  const id = randomUUID();
  const target = path.join(dataDir, 'downloads');
  await mkdir(target, { recursive: true, mode: 0o700 });
  await exec('zip', ['-q', path.join(target, `${id}.zip`), '--', ...files], { cwd: directory, timeout: 120_000 });
  return `/api/downloads/${id}`;
}
export function downloadRoutes(app: Hono, dataDir: string): void {
  app.get('/api/downloads/:id', (c) => {
    const id = c.req.param('id');
    if (!/^[a-f0-9-]{36}$/.test(id)) return c.notFound();
    const file = path.join(dataDir, 'downloads', `${id}.zip`);
    if (!existsSync(file)) return c.notFound();
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="seedance-export.zip"', 'cache-control': 'private, no-store' },
    });
  });
}
