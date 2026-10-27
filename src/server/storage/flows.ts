import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serialize } from './atomic.ts';
import { StoreError } from './fsStore.ts';
import { FlowSchema, type Flow } from '../../core/model/canvas.ts';

export const FLOW_ID = /^f-[a-z0-9-]{6,64}$/;

/** Flows canvas — по файлу: data/canvas/<id>.json. Пишет клиент (автосейв), сервер только хранит. */
export function createFlows(dataDir: string, now: () => number = Date.now) {
  const dir = path.join(dataDir, 'canvas');
  const fileOf = (id: string): string => {
    if (!FLOW_ID.test(id)) throw new Error('Недопустимый id flow.');
    return path.join(dir, `${id}.json`);
  };
  const iso = (): string => new Date(now()).toISOString();

  async function write(flow: Flow): Promise<Flow> {
    await mkdir(dir, { recursive: true });
    const file = fileOf(flow.id);
    const tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(flow, null, 1)}\n`);
    await rename(tmp, file);
    return flow;
  }

  async function get(id: string): Promise<Flow | undefined> {
    if (!FLOW_ID.test(id)) return undefined;
    try {
      return FlowSchema.parse(JSON.parse(await readFile(fileOf(id), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new StoreError('INVALID', 'Холст не удалось прочитать. Файл сохранён; восстанови его из резервной копии перед продолжением.');
    }
  }

  return {
    get,
    async ensureProduction(id: string, name: string, update: (flow: Flow) => Flow | Promise<Flow>): Promise<Flow> {
      return serialize(fileOf(id), async () => {
        const base = await get(id) ?? { id, name, rev: 0, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: iso(), updatedAt: iso() };
        const next = FlowSchema.parse(await update(base));
        if (JSON.stringify(next) === JSON.stringify(base)) return base;
        return write({ ...next, rev: (base.rev ?? 0) + 1, updatedAt: iso() });
      });
    },
    async list(): Promise<{ id: string; name: string; nodes: number; updatedAt: string; production?: Flow['production'] }[]> {
      await mkdir(dir, { recursive: true });
      const out = [];
      for (const file of await readdir(dir)) {
        if (!file.endsWith('.json')) continue;
        const flow = await get(file.slice(0, -5)).catch(() => undefined);
        if (flow !== undefined) out.push({ id: flow.id, name: flow.name, nodes: flow.nodes.length, updatedAt: flow.updatedAt, production: flow.production });
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async create(name: string): Promise<Flow> {
      return write({ id: `f-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, name: name.trim() || 'Новый flow', rev: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: iso(), updatedAt: iso() });
    },
    /** null — тело не flow или id не совпал. */
    async save(id: string, incoming: unknown): Promise<Flow | null> {
      const parsed = FlowSchema.safeParse(incoming);
      if (!parsed.success || parsed.data.id !== id) return null;
      return serialize(fileOf(id), async () => {
        const current = await get(id);
        if (current === undefined) throw new StoreError('NOT_FOUND', 'Холст не найден.');
        if ((parsed.data.rev ?? 0) !== (current.rev ?? 0)) throw new StoreError('CONFLICT', 'Холст изменён в другом окне. Твой черновик сохранён локально; сохрани его копией.');
        return write({ ...parsed.data, rev: (current.rev ?? 0) + 1, updatedAt: iso() });
      });
    },
    async restore(id: string): Promise<Flow | undefined> {
      return serialize(fileOf(id), async () => {
        if (await get(id) !== undefined) throw new StoreError('CONFLICT', 'Холст уже существует.');
        try { await rename(path.join(dir, 'trash', `${id}.json`), fileOf(id)); }
        catch { return undefined; }
        return get(id);
      });
    },
    async remove(id: string): Promise<boolean> {
      return serialize(fileOf(id), async () => {
        if ((await get(id)) === undefined) return false;
        const trash = path.join(dir, 'trash');
        await mkdir(trash, { recursive: true });
        await rename(fileOf(id), path.join(trash, `${id}.json`));
        return true;
      });
    },
  };
}

export type Flows = ReturnType<typeof createFlows>;
