import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GenJobSchema, type GenJob } from '../../core/model/media.ts';

export const JOB_ID = /^j-[a-z0-9-]{6,64}$/;

export const newJobId = (): string => `j-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

/**
 * Задачи генерации — по файлу на задачу: data/jobs/<id>.json. Отдельно от project.json: сервер пишет
 * статусы в фоне, а project.json принадлежит клиенту (rev + автосейв) — фоновая запись увела бы его в конфликт.
 */
export function createJobStore(dataDir: string) {
  const dir = path.join(dataDir, 'jobs');
  const jobs = new Map<string, GenJob>();
  let loaded = false;

  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    await mkdir(dir, { recursive: true });
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.json') || !JOB_ID.test(file.slice(0, -5))) continue;
      try {
        const job = GenJobSchema.parse(JSON.parse(await readFile(path.join(dir, file), 'utf8')));
        jobs.set(job.id, job);
      } catch {
        /* повреждённый файл не роняет очередь */
      }
    }
  }

  return {
    load,

    async put(job: GenJob): Promise<GenJob> {
      await load();
      if (!JOB_ID.test(job.id)) throw new Error(`Недопустимый id задачи: ${job.id}`);
      const next = GenJobSchema.parse(job);
      jobs.set(next.id, next);
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${next.id}.json`);
      // Имя tmp уникально: две записи одной задачи в одну миллисекунду не должны делить файл.
      const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 1)}\n`);
      await rename(tmp, file);
      return next;
    },

    async get(id: string): Promise<GenJob | undefined> {
      await load();
      return jobs.get(id);
    },

    /** Убрать задачу из ленты (файл задачи). Деньги за неё уже списаны — это только запись. */
    async remove(id: string): Promise<boolean> {
      await load();
      if (!jobs.has(id)) return false;
      jobs.delete(id);
      await rm(path.join(dir, `${id}.json`), { force: true });
      return true;
    },

    /** Новые первыми. */
    async all(): Promise<GenJob[]> {
      await load();
      return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}

export type JobStore = ReturnType<typeof createJobStore>;
