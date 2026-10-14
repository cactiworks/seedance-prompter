import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { createServer as createViteServer } from 'vite';
import { createApp, HOST, PORT } from './app.ts';
import { createGenRuntime } from './gen/runtime.ts';
import { createProductionRuntime } from './production/runtime.ts';
import { acquireDataLock } from './storage/dataLock.ts';
import { APP_NAME } from '../core/meta.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL_BASE = `http://${HOST}:${PORT}`;

function openBrowser(url: string): void {
  if (process.env.SP_NO_OPEN === '1') return;
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

/** Уже запущенный экземпляр отвечает на /api/health — тогда просто открываем вкладку. */
async function isAlreadyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${URL_BASE}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const body = (await res.json()) as { name?: string };
    return body.name === APP_NAME;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (await isAlreadyRunning()) {
    console.log(`Уже запущен: ${URL_BASE}`);
    openBrowser(URL_BASE);
    return;
  }

  const dataDir = process.env.SP_DATA_DIR ?? path.join(ROOT, 'data');
  const releaseDataLock = await acquireDataLock(dataDir);
  // Фоновый опрос задач генерации: продолжает незаконченные после перезапуска и скачивает результаты.
  const gen = createGenRuntime({ dataDir });
  await gen.start();
  const production = createProductionRuntime({ dataDir, gen });
  await production.start();
  const app = createApp({ rootDir: ROOT, dataDir, gen, production });
  const apiListener = getRequestListener(app.fetch);

  const httpServer = createHttpServer();
  const vite = await createViteServer({
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: 'spa',
  });

  httpServer.on('request', (req, res) => {
    if (req.url !== undefined && req.url.startsWith('/api/')) {
      void apiListener(req, res);
      return;
    }
    vite.middlewares(req, res);
  });

  const shutdown = (): void => {
    gen.stop();
    production.stop();
    void vite.close().finally(() => {
      httpServer.close(() => { void releaseDataLock().finally(() => process.exit(0)); });
      setTimeout(() => process.exit(0), 1500).unref();
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, shutdown);

  httpServer.listen(PORT, HOST, () => {
    console.log(`Seedance Prompter: ${URL_BASE}  (остановить — Ctrl+C)`);
    openBrowser(URL_BASE);
  });
}

main().catch((error: unknown) => {
  console.error('Не удалось запустить сервер:', error);
  process.exit(1);
});
