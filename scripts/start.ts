import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { ROOT, revision, syncRole, updateRepository } from './sync.ts';

const url = `http://127.0.0.1:${process.env.SP_PORT ?? '4317'}`;
const localOnly = process.env.SP_SKIP_UPDATE === '1';

async function main(): Promise<void> {
  const remoteFile = path.join(ROOT, '.seedance-remote.json');
  if (!localOnly && process.env.SP_PORT === undefined && process.env.SP_DATA_DIR === undefined && existsSync(remoteFile)) {
    const remote = JSON.parse(readFileSync(remoteFile, 'utf8')) as { url?: string };
    const destination = new URL(remote.url ?? '');
    if (destination.protocol !== 'https:' || destination.username || destination.password) throw new Error('Нужен HTTPS-адрес общей студии без пароля в URL.');
    console.log(`Общая студия: ${destination.origin}`);
    if (process.platform === 'darwin' && process.env.SP_NO_OPEN !== '1') spawn('open', [destination.href], { stdio: 'ignore', detached: true }).unref();
    return;
  }

  let running = false;
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (response.ok) {
      const health = await response.json() as { name?: string };
      running = health.name === 'seedance-prompter';
    }
  } catch { /* Обычный первый запуск — сервера ещё нет. */ }
  if (running) {
    console.log(`Приложение уже работает: ${url}\nЧтобы получить обновление, останови его через Ctrl+C в прежнем окне и запусти снова. Сейчас файлы не изменялись.`);
    if (process.env.SP_NO_OPEN !== '1') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    return;
  }

  const role = syncRole(ROOT);
  if (!localOnly && (role === 'source' || role === 'replica')) {
    try {
      console.log('Проверяю обновления на GitHub…');
      const result = updateRepository(ROOT);
      console.log(`${result.updated ? 'Обновлено' : 'Актуальная версия'}: ${result.revision.slice(0, 7)}`);
    } catch (error) {
      if (role === 'replica') throw error;
      console.warn(`Рабочая копия основного Mac: ${error instanceof Error ? error.message : 'обновление пропущено'}`);
    }
  } else if (!localOnly) {
    console.warn('Автообновление не настроено. Для Git clone: npm run sync:replica. ZIP автоматически не обновляется.');
  }

  const lockHash = createHash('sha256').update(readFileSync(path.join(ROOT, 'package-lock.json'))).digest('hex');
  const marker = path.join(ROOT, 'node_modules', '.seedance-lock.sha256');
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== lockHash) {
    console.log('Устанавливаю зависимости этой версии…');
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit' });
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, lockHash);
  }
  console.log(`Запуск версии ${revision(ROOT)?.slice(0, 7) ?? 'из ZIP'}`);
  const child = spawn(process.execPath, ['src/server/index.ts'], { cwd: ROOT, stdio: 'inherit', env: process.env });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 0; });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Запуск не завершён.');
  console.error('Если нужна сохранённая локальная версия без сети: npm run start:offline.');
  process.exitCode = 1;
});
