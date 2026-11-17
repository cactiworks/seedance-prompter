import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, serialize } from '../storage/atomic.ts';
import { CanvasAiError, StoredCanvasAiRunSchema, type StoredCanvasAiRun } from './types.ts';

const RUN_ID = /^cai-[a-f0-9-]{36}$/;
/** Independent durable records: Flow carries only the currently displayed projection. */
export function createCanvasAiStore(dataDir: string) {
  const root = path.join(dataDir, 'canvas-ai');
  const dirOf = (id: string) => {
    if (!RUN_ID.test(id)) throw new CanvasAiError('NOT_FOUND', 'AI-запуск не найден.', 404);
    return path.join(root, id);
  };
  const fileOf = (id: string) => path.join(dirOf(id), 'run.json');
  async function get(id: string): Promise<StoredCanvasAiRun | undefined> {
    try { return StoredCanvasAiRunSchema.parse(JSON.parse(await readFile(fileOf(id), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof CanvasAiError) throw error;
      throw new CanvasAiError('INVALID_RUN', 'Историю AI не удалось прочитать. Исходный файл сохранён.', 409);
    }
  }
  async function write(run: StoredCanvasAiRun) {
    const parsed = StoredCanvasAiRunSchema.parse(run);
    await atomicWrite(fileOf(parsed.id), `${JSON.stringify(parsed, null, 1)}\n`);
    return parsed;
  }
  return {
    get,
    exclusive: <T>(key: string, fn: () => Promise<T>) => serialize(path.join(root, `lock-${key}`), fn),
    async create(run: StoredCanvasAiRun) { return serialize(fileOf(run.id), async () => { if (await get(run.id)) throw new CanvasAiError('CONFLICT', 'Этот запуск уже сохранён.', 409); return write(run); }); },
    async update(id: string, change: (run: StoredCanvasAiRun) => void | Promise<void>) {
      return serialize(fileOf(id), async () => {
        const run = await get(id);
        if (!run) throw new CanvasAiError('NOT_FOUND', 'AI-запуск не найден.', 404);
        await change(run); run.revision += 1; run.updatedAt = new Date().toISOString();
        return write(run);
      });
    },
    async list(flowId: string, nodeId?: string) {
      const names = await readdir(root).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
      const runs: StoredCanvasAiRun[] = [];
      for (const name of names.filter(n => RUN_ID.test(n))) {
        const run = await get(name);
        if (run?.flowId === flowId && (!nodeId || run.nodeId === nodeId)) runs.push(run);
      }
      return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt));
    },
    async image(id: string, file: string) {
      if (!/^image-\d+\.(png|jpg|webp)$/.test(file)) throw new CanvasAiError('BAD_IMAGE', 'Неверный файл AI-референса.');
      return readFile(path.join(dirOf(id), file));
    },
    async saveImage(id: string, file: string, bytes: Uint8Array) {
      if (!/^image-\d+\.(png|jpg|webp)$/.test(file)) throw new CanvasAiError('BAD_IMAGE', 'Неверный файл AI-референса.');
      await atomicWrite(path.join(dirOf(id), file), bytes);
    },
  };
}
