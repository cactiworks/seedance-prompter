import { mkdir, readdir, readFile, rm, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, serialize } from './atomic.ts';
import { ProjectSchema, type Project } from '../../core/model/project.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REF_FILE = /^[a-z0-9][a-z0-9-]*\.(?:jpg|jpeg|png|webp)$/;
const MAX_BACKUPS = 20;
const BACKUP_EVERY_MS = 10 * 60 * 1000;

export class StoreError extends Error {
  readonly code: 'BAD_SLUG' | 'BAD_FILE' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID';
  constructor(code: StoreError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** Проекты — обычные файлы: data/projects/<slug>/project.json, refs/, backups/. */
export function createStore(dataDir: string) {
  const projectsDir = path.join(dataDir, 'projects');

  // Слаг и имя файла проверяются регуляркой ДО склейки пути: никаких «..» и абсолютных путей.
  const dirOf = (slug: string): string => {
    if (!SLUG.test(slug)) throw new StoreError('BAD_SLUG', 'Недопустимое имя проекта.');
    return path.join(projectsDir, slug);
  };

  async function backup(dir: string): Promise<void> {
    const source = path.join(dir, 'project.json');
    const backups = path.join(dir, 'backups');
    await mkdir(backups, { recursive: true });
    const existing = (await readdir(backups)).filter((f) => f.endsWith('.json')).sort();
    const last = existing.at(-1);
    if (last !== undefined && Date.now() - (await stat(path.join(backups, last))).mtimeMs < BACKUP_EVERY_MS) return;
    await copyFile(source, path.join(backups, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)).catch(() => undefined);
    for (const stale of existing.slice(0, Math.max(0, existing.length + 1 - MAX_BACKUPS))) await rm(path.join(backups, stale), { force: true });
  }

  return {
    async list(): Promise<{ slug: string; title: string; shots: number; updatedAt: number }[]> {
      await mkdir(projectsDir, { recursive: true });
      const out = [];
      for (const slug of await readdir(projectsDir)) {
        if (!SLUG.test(slug)) continue;
        try {
          const file = path.join(projectsDir, slug, 'project.json');
          const project = ProjectSchema.parse(JSON.parse(await readFile(file, 'utf8')));
          out.push({ slug, title: project.title, shots: project.shots.length, updatedAt: (await stat(file)).mtimeMs });
        } catch {
          /* повреждённый проект не роняет список */
        }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async read(slug: string): Promise<Project> {
      try {
        return ProjectSchema.parse(JSON.parse(await readFile(path.join(dirOf(slug), 'project.json'), 'utf8')));
      } catch (error) {
        if (error instanceof StoreError) throw error;
        throw new StoreError('NOT_FOUND', `Проект «${slug}» не найден или повреждён.`);
      }
    },

    /** Запись целиком с оптимистичной блокировкой: rev клиента обязан совпасть с rev на диске. */
    async write(slug: string, incoming: unknown, expectedRev: number | null): Promise<Project> {
      return serialize(path.join(dirOf(slug), 'project.json'), async () => {
        const dir = dirOf(slug);
        const parsed = ProjectSchema.safeParse(incoming);
        if (!parsed.success) throw new StoreError('INVALID', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        if (parsed.data.slug !== slug) throw new StoreError('INVALID', 'slug в теле не совпадает с адресом.');

        let currentRev: number | null = null;
        try {
          currentRev = ProjectSchema.parse(JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))).rev;
        } catch {
          currentRev = null;
        }
        if (currentRev !== null && expectedRev !== currentRev) throw new StoreError('CONFLICT', `Проект изменён в другом окне (rev ${currentRev}).`);
        if (currentRev !== null) await backup(dir);

        const next: Project = { ...parsed.data, rev: (currentRev ?? 0) + 1 };
        await atomicWrite(path.join(dir, 'project.json'), `${JSON.stringify(next, null, 1)}\n`);
        return next;
      });
    },

    async writeRef(slug: string, fileName: string, bytes: Uint8Array): Promise<void> {
      if (!REF_FILE.test(fileName)) throw new StoreError('BAD_FILE', 'Недопустимое имя файла референса.');
      await atomicWrite(path.join(dirOf(slug), 'refs', fileName), bytes);
    },

    /** Файлы референсов одного проекта — в другой (копия черновика Seedance-промптера из canvas). */
    async copyRefs(fromSlug: string, toSlug: string): Promise<number> {
      const from = path.join(dirOf(fromSlug), 'refs');
      const to = path.join(dirOf(toSlug), 'refs');
      await mkdir(to, { recursive: true });
      let copied = 0;
      for (const file of await readdir(from).catch(() => [] as string[])) {
        if (!REF_FILE.test(file)) continue;
        await copyFile(path.join(from, file), path.join(to, file));
        copied += 1;
      }
      return copied;
    },

    async readRef(slug: string, fileName: string): Promise<Uint8Array> {
      if (!REF_FILE.test(fileName)) throw new StoreError('BAD_FILE', 'Недопустимое имя файла референса.');
      try {
        return await readFile(path.join(dirOf(slug), 'refs', fileName));
      } catch {
        throw new StoreError('NOT_FOUND', 'Файл референса не найден.');
      }
    },

    /**
     * Панель кадра пронумерованными файлами: 01-<key>.jpg, 02-… — в Finder они лежат в порядке
     * панели, и перепутать порядок загрузки в Higgsfield становится трудно. Папка пересобирается с нуля.
     */
    async exportPanel(slug: string, shotId: string, items: { key: string; fileName: string | null }[]): Promise<{ dir: string; files: { n: number; key: string; file: string | null }[] }> {
      if (!SLUG.test(shotId)) throw new StoreError('BAD_SLUG', 'Недопустимый id кадра.');
      const dir = path.join(dirOf(slug), 'export', shotId);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      const files: { n: number; key: string; file: string | null }[] = [];
      for (const [i, item] of items.entries()) {
        const n = i + 1;
        if (item.fileName === null || !REF_FILE.test(item.fileName)) {
          files.push({ n, key: item.key, file: null });
          continue;
        }
        const ext = item.fileName.split('.').pop() ?? 'jpg';
        const target = `${String(n).padStart(2, '0')}-${item.key}.${ext}`;
        try {
          await copyFile(path.join(dirOf(slug), 'refs', item.fileName), path.join(dir, target));
          files.push({ n, key: item.key, file: target });
        } catch {
          files.push({ n, key: item.key, file: null });
        }
      }
      return { dir, files };
    },
  };
}

export type Store = ReturnType<typeof createStore>;
