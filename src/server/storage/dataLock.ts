import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/** One running server per data directory; different test directories remain independent. */
export async function acquireDataLock(dataDir: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, '.server.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await handle.close(); }
      return async () => {
        const owner = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as { token?: string };
        if (owner.token === token) await rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: number };
      try { owner = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('Папка данных занята или её блокировка повреждена. Проверь запущенные серверы перед повторным запуском.'); }
      let alive = true;
      if (Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0) {
        try { process.kill(owner.pid!, 0); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      }
      if (alive) throw new Error('Эта папка данных уже используется сервером. Для второго экземпляра укажи отдельный SP_DATA_DIR.');
      // Only one contender may reclaim a dead process' lock. Re-read after acquiring
      // the guard: another contender may already have replaced the original owner.
      const guardFile = `${file}.recovery`;
      let guard;
      try { guard = await open(guardFile, 'wx', 0o600); }
      catch { throw new Error('Другой запуск восстанавливает блокировку папки данных. Повтори запуск.'); }
      try {
        const latest = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as { pid?: number };
        if (latest.pid === owner.pid) await rm(file, { force: true });
      } finally { await guard.close(); await rm(guardFile, { force: true }); }
    }
  }
  throw new Error('Не удалось занять папку данных. Повтори запуск.');
}
