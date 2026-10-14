import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, serialize } from './atomic.ts';
import { z } from 'zod';
import { StudioSessionSchema, type StudioSession } from '../../core/model/media.ts';

export const SESSION_ID = /^s-[a-z0-9-]{6,64}$/;

/** Сессии студии одним файлом data/studio/sessions.json: их десятки, не тысячи. */
export function createSessions(dataDir: string, now: () => number = Date.now) {
  const file = path.join(dataDir, 'studio', 'sessions.json');

  async function all(): Promise<StudioSession[]> {
    try {
      return z.array(StudioSessionSchema).parse(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      return [];
    }
  }

  async function persist(next: StudioSession[]): Promise<void> {
    await atomicWrite(file, `${JSON.stringify(next, null, 1)}\n`);
  }

  const iso = (): string => new Date(now()).toISOString();

  return {
    /** Закреплённые сверху, дальше — последние изменённые. */
    async list(kind?: StudioSession['kind']): Promise<StudioSession[]> {
      return (await all()).filter((s) => kind === undefined || s.kind === kind).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    },
    async get(id: string): Promise<StudioSession | undefined> {
      return (await all()).find((s) => s.id === id);
    },
    async create(kind: StudioSession['kind'], title: string): Promise<StudioSession> {
      return serialize(file, async () => {
      const session: StudioSession = { id: `s-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, kind, title: title.trim() || 'Новая сессия', pinned: false, createdAt: iso(), updatedAt: iso() };
      await persist([...(await all()), session]);
      return session;
      });
    },
    async update(id: string, patch: Partial<Pick<StudioSession, 'title' | 'pinned'>>): Promise<StudioSession | undefined> {
      return serialize(file, async () => {
      const list = await all();
      const current = list.find((s) => s.id === id);
      if (current === undefined) return undefined;
      const next = StudioSessionSchema.parse({ ...current, ...patch, title: (patch.title ?? current.title).trim() || current.title, updatedAt: iso() });
      await persist(list.map((s) => (s.id === id ? next : s)));
      return next;
      });
    },
    /** Отмечает активность: сессия поднимается в списке. */
    async touch(id: string): Promise<void> {
      return serialize(file, async () => {
      const list = await all();
      if (!list.some((s) => s.id === id)) return;
      await persist(list.map((s) => (s.id === id ? { ...s, updatedAt: iso() } : s)));
      });
    },
    async remove(id: string): Promise<boolean> {
      return serialize(file, async () => {
      const list = await all();
      if (!list.some((s) => s.id === id)) return false;
      await persist(list.filter((s) => s.id !== id));
      return true;
      });
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;
