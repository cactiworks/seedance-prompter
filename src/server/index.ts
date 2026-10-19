import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp, HOST, PORT } from './app.ts';
import { createGenRuntime } from './gen/runtime.ts';
import { createProductionRuntime } from './production/runtime.ts';
import { acquireDataLock } from './storage/dataLock.ts';
import { createAccounts } from './accounts/service.ts';
import { APP_NAME } from '../core/meta.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL_BASE = `http://${HOST}:${PORT}`;

function openBrowser(url: string): void {
  if (process.env.SP_NO_OPEN === '1' || process.platform !== 'darwin') return;
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
  const productionMode = process.env.SP_SERVE_STATIC === '1';
  const accountsDir = process.env.SP_ACCOUNTS_DIR?.trim() || (productionMode ? path.join(path.dirname(path.resolve(dataDir)), 'accounts') : undefined);
  if (accountsDir && [path.resolve(dataDir), path.join(ROOT, 'dist')].some(publicDir => path.resolve(accountsDir) === publicDir || path.resolve(accountsDir).startsWith(`${publicDir}${path.sep}`))) throw new Error('Account credentials must live outside shared data and static files');
  const accounts = accountsDir ? createAccounts({ dir: accountsDir, secureCookie: productionMode }) : undefined;
  // Фоновый опрос задач генерации: продолжает незаконченные после перезапуска и скачивает результаты.
  const gen = createGenRuntime({ dataDir });
  await gen.start();
  const production = createProductionRuntime({ dataDir, gen, runLlmForAccount: accounts?.runnerFor });
  await production.start();
  const app = createApp({ rootDir: ROOT, dataDir, gen, production, accounts });
  const httpServer = createHttpServer();
  const vite = productionMode ? null : await (await import('vite')).createServer({
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: 'spa',
  });
  if (productionMode) {
    // Never expose source files, data or credentials through the static handler.
    app.get('/api/*', (c) => c.json({ error: 'NOT_FOUND' }, 404));
    app.use('*', serveStatic({ root: path.join(ROOT, 'dist') }));
    app.get('*', serveStatic({ path: path.join(ROOT, 'dist/index.html') }));
  }
  const apiListener = getRequestListener(app.fetch);

  httpServer.on('request', (req, res) => {
    if (productionMode || (req.url !== undefined && req.url.startsWith('/api/'))) {
      void apiListener(req, res);
      return;
    }
    vite?.middlewares(req, res);
  });

  const shutdown = (): void => {
    gen.stop();
    production.stop();
    void accounts?.close();
    void (vite?.close() ?? Promise.resolve()).finally(() => {
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
