import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
    } catch {
      return undefined;
    }
  }

  return {
    get,
    async list(): Promise<{ id: string; name: string; nodes: number; updatedAt: string }[]> {
      await mkdir(dir, { recursive: true });
      const out = [];
      for (const file of await readdir(dir)) {
        if (!file.endsWith('.json')) continue;
        const flow = await get(file.slice(0, -5));
        if (flow !== undefined) out.push({ id: flow.id, name: flow.name, nodes: flow.nodes.length, updatedAt: flow.updatedAt });
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async create(name: string): Promise<Flow> {
      return write({ id: `f-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, name: name.trim() || 'Новый flow', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: iso(), updatedAt: iso() });
    },
    /** null — тело не flow или id не совпал. */
    async save(id: string, incoming: unknown): Promise<Flow | null> {
      const parsed = FlowSchema.safeParse(incoming);
      if (!parsed.success || parsed.data.id !== id) return null;
      return write({ ...parsed.data, updatedAt: iso() });
    },
    async remove(id: string): Promise<boolean> {
      if ((await get(id)) === undefined) return false;
      await rm(fileOf(id), { force: true });
      return true;
    },
  };
}

export type Flows = ReturnType<typeof createFlows>;
