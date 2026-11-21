import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, serialize } from './atomic.ts';
import { StoreError } from './fsStore.ts';
import { invalidateChanged } from '../../core/canvas/freshness.ts';
import { mergeCanvasFlow } from '../../core/canvas/merge.ts';
import { FlowSchema, type Flow } from '../../core/model/canvas.ts';

export const FLOW_ID = /^f-[a-z0-9-]{6,64}$/;
const HISTORY_ID = /^(?:r-\d+-[a-f0-9]{16}|legacy-[a-f0-9]{64}|recovery-[a-f0-9]{64})$/;
const MAX_REVISIONS = 50;
const PatchSchema = z.object({ base: FlowSchema, flow: FlowSchema });
type HistoryKind = 'revision' | 'legacy' | 'recovery';
interface SavedVersion { kind: HistoryKind; flow: Flow; createdAt: string }
interface PendingWrite { key: string; previousDigest: string; next: Flow; desired: Flow }
export interface FlowHistoryEntry { id: string; kind: HistoryKind; rev: number; name: string; nodes: number; createdAt: string }

/** A failed graph merge is already retained on the server, beside its current canonical flow. */
export class FlowMergeError extends StoreError {
  readonly current: Flow;
  readonly historyId: string;
  constructor(current: Flow, historyId: string) {
    super('CONFLICT', 'Одновременные изменения связей несовместимы. Твои изменения сохранены в истории холста на сервере. Обнови холст и восстанови нужную версию через историю.');
    this.current = current; this.historyId = historyId;
  }
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameContent = (first: Flow, second: Flow): boolean => {
  const { rev: _firstRev, updatedAt: _firstDate, ...a } = first;
  const { rev: _secondRev, updatedAt: _secondDate, ...b } = second;
  return JSON.stringify(a) === JSON.stringify(b);
};

/** Canonical Canvas state and recovery history live exclusively in the shared server data. */
export function createFlows(dataDir: string, now: () => number = Date.now) {
  const dir = path.join(dataDir, 'canvas');
  const fileOf = (id: string): string => {
    if (!FLOW_ID.test(id)) throw new StoreError('INVALID', 'Недопустимый id flow.');
    return path.join(dir, `${id}.json`);
  };
  const iso = (): string => new Date(now()).toISOString();
  const historyDir = (id: string): string => { fileOf(id); return path.join(dir, 'history', id); };
  const recoveryDir = (id: string): string => { fileOf(id); return path.join(dir, 'recovery', id); };
  const pendingFile = (id: string): string => { fileOf(id); return path.join(dir, 'pending', `${id}.json`); };
  const receiptFile = (id: string): string => {
    fileOf(id);
    return path.join(dir, 'receipts', `${id}.log`);
  };
  const versionFile = (id: string, version: string): string => {
    fileOf(id);
    if (!HISTORY_ID.test(version)) throw new StoreError('INVALID', 'Недопустимая версия холста.');
    const folder = version.startsWith('legacy-') ? path.join(dir, 'legacy-drafts') : version.startsWith('recovery-') ? recoveryDir(id) : historyDir(id);
    return path.join(folder, `${version}.json`);
  };

  async function write(flow: Flow): Promise<Flow> {
    await atomicWrite(fileOf(flow.id), `${JSON.stringify(flow, null, 1)}\n`);
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

  async function savedVersion(id: string, version: string): Promise<SavedVersion | undefined> {
    try {
      const value = JSON.parse(await readFile(versionFile(id, version), 'utf8')) as SavedVersion;
      const flow = FlowSchema.parse(value.flow);
      if (flow.id !== id || !['revision', 'legacy', 'recovery'].includes(value.kind) || typeof value.createdAt !== 'string') return undefined;
      return { kind: value.kind, flow, createdAt: value.createdAt };
    } catch (error) {
      if (error instanceof StoreError) throw error;
      return undefined;
    }
  }

  async function archive(kind: HistoryKind, flow: Flow): Promise<string> {
    const hash = digest(flow);
    const version = kind === 'revision' ? `r-${flow.rev ?? 0}-${hash.slice(0, 16)}` : `${kind}-${hash}`;
    const file = versionFile(flow.id, version);
    try { await readFile(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await atomicWrite(file, `${JSON.stringify({ kind, flow, createdAt: iso() } satisfies SavedVersion, null, 1)}\n`);
    }
    return version;
  }

  async function revisionFiles(id: string): Promise<string[]> {
    return (await readdir(historyDir(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    })).filter(name => /^r-\d+-[a-f0-9]{16}\.json$/.test(name)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
  }

  async function commit(current: Flow | undefined, desired: Flow): Promise<Flow> {
    if (current && sameContent(current, desired)) return current;
    if (current) await archive('revision', current);
    const next = await write({ ...desired, rev: (current?.rev ?? 0) + 1, updatedAt: iso() });
    const revisions = await revisionFiles(next.id);
    for (const old of revisions.slice(0, Math.max(0, revisions.length - MAX_REVISIONS))) await rm(path.join(historyDir(next.id), old), { force: true });
    return next;
  }

  async function merged(current: Flow, base: Flow, desired: Flow): Promise<Flow> {
    const merged = mergeCanvasFlow(base, desired, current);
    const parsed = FlowSchema.safeParse(merged);
    if (!parsed.success) throw new FlowMergeError(current, await archive('recovery', desired));
    // Concurrent deletion wins, while an edited version of that node remains recoverable.
    if (desired.nodes.some(node => {
      const old = base.nodes.find(value => value.id === node.id);
      const latest = current.nodes.find(value => value.id === node.id);
      return old ? !latest && JSON.stringify(old) !== JSON.stringify(node) : latest && JSON.stringify(latest) !== JSON.stringify(node);
    }) || desired.edges.some(edge => {
      const old = base.edges.find(value => value.id === edge.id);
      return JSON.stringify(old) !== JSON.stringify(edge) && !parsed.data.edges.some(value => JSON.stringify(value) === JSON.stringify(edge));
    })) await archive('recovery', desired);
    return FlowSchema.parse(invalidateChanged(current, parsed.data));
  }

  async function applied(id: string, key: string): Promise<boolean> {
    let content: string;
    try { content = await readFile(receiptFile(id), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    // A torn final append is not a receipt. Leading/trailing newlines keep the
    // next append independent of that fragment, and a pending journal replays it.
    return content.split('\n').some(line => /^[a-f0-9]{64}$/.test(line) && line === key);
  }

  async function remember(id: string, key: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new StoreError('INVALID', 'Недопустимый запрос сохранения.');
    const file = receiptFile(id); await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, 'a');
    try { await handle.writeFile(`\n${key}\n`); await handle.sync(); }
    finally { await handle.close(); }
  }

  /** Recover before opening or mutating a flow; the journal closes the two-file crash window. */
  async function recover(id: string): Promise<Flow | undefined> {
    const current = await get(id);
    let pending: PendingWrite;
    try { pending = JSON.parse(await readFile(pendingFile(id), 'utf8')) as PendingWrite; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return current; throw error; }
    if (!/^[a-f0-9]{64}$/.test(pending.key) || !FlowSchema.safeParse(pending.next).success || !FlowSchema.safeParse(pending.desired).success || pending.next.id !== id || pending.desired.id !== id) throw new StoreError('INVALID', 'Серверная очередь сохранения повреждена. Материалы сохранены; требуется восстановление очереди.');
    let result = current;
    if (!await applied(id, pending.key)) {
      if (current && digest(current) === pending.previousDigest) result = await commit(current, pending.next);
      else if (!current || !sameContent(current, pending.next)) await archive('recovery', pending.desired);
      await remember(id, pending.key);
    }
    await rm(pendingFile(id), { force: true });
    return result;
  }

  function transaction<T>(id: string, operation: (current: Flow | undefined) => Promise<T>): Promise<T> {
    return serialize(fileOf(id), async () => operation(await recover(id)));
  }

  async function saveOnce(current: Flow, next: Flow, desired: Flow, key: string): Promise<Flow> {
    if (await applied(current.id, key)) return current;
    const pending: PendingWrite = { key, previousDigest: digest(current), next, desired };
    await atomicWrite(pendingFile(current.id), `${JSON.stringify(pending)}\n`);
    return (await recover(current.id))!;
  }

  async function listHistory(id: string): Promise<FlowHistoryEntry[]> {
    fileOf(id);
    const files = await Promise.all([historyDir(id), recoveryDir(id), path.join(dir, 'legacy-drafts')].map(async folder => (await readdir(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    })).filter(name => HISTORY_ID.test(name.replace(/\.json$/, ''))).map(name => name.replace(/\.json$/, ''))));
    const result: FlowHistoryEntry[] = [];
    for (const version of files.flat()) {
      const value = await savedVersion(id, version);
      if (value) result.push({ id: version, kind: value.kind, rev: value.flow.rev ?? 0, name: value.flow.name, nodes: value.flow.nodes.length, createdAt: value.createdAt });
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.rev - a.rev);
  }

  return {
    get: (id: string): Promise<Flow | undefined> => FLOW_ID.test(id) ? transaction(id, async current => current) : Promise.resolve(undefined),
    listHistory,
    async history(id: string, version: string): Promise<Flow | undefined> { return (await savedVersion(id, version))?.flow; },
    async restoreVersion(id: string, version: string, expectedRev: unknown, requestId?: unknown): Promise<Flow | undefined> {
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(requestId))) throw new StoreError('INVALID', 'Недопустимый запрос восстановления.');
      return transaction(id, async current => {
        if (!current) return undefined;
        const key = requestId === undefined ? null : digest(['restore', id, version, requestId]);
        if (key && await applied(id, key)) return current;
        const archived = await savedVersion(id, version);
        if (!archived) return undefined;
        if (expectedRev !== (current.rev ?? 0)) throw new StoreError('CONFLICT', 'Холст успел измениться. Обнови историю перед восстановлением.');
        const next: Flow = { ...archived.flow, createdAt: current.createdAt, nodes: archived.flow.nodes.map(node => ({ ...node,
          aiApproval: undefined, acceptedJobId: null, acceptedMediaId: null,
          ai: node.ai ? { ...node.ai, runId: null, status: node.ai.status === 'running' ? 'interrupted' as const : node.ai.status,
            idea: node.ai.idea ? { ...node.ai.idea, approval: null } : null, prompt: node.ai.prompt ? { ...node.ai.prompt, approval: null } : null } : undefined,
        })) };
        const restored = FlowSchema.parse(invalidateChanged(current, next));
        return key ? saveOnce(current, restored, restored, key) : commit(current, restored);
      });
    },
    async ensureProduction(id: string, name: string, update: (flow: Flow) => Flow | Promise<Flow>): Promise<Flow> {
      return transaction(id, async current => {
        const base = current ? structuredClone(current) : { id, name, rev: 0, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: iso(), updatedAt: iso() };
        return commit(current, FlowSchema.parse(await update(base)));
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
    /** Legacy optimistic whole-document writes remain strict for older clients. */
    async save(id: string, incoming: unknown): Promise<Flow | null> {
      const parsed = FlowSchema.safeParse(incoming);
      if (!parsed.success || parsed.data.id !== id) return null;
      return transaction(id, async current => {
        if (current === undefined) throw new StoreError('NOT_FOUND', 'Холст не найден.');
        if ((parsed.data.rev ?? 0) !== (current.rev ?? 0)) throw new StoreError('CONFLICT', 'Холст изменён на сервере. Обнови страницу, чтобы получить текущую версию.');
        return commit(current, parsed.data);
      });
    },
    async patch(id: string, incoming: unknown): Promise<Flow | null> {
      const parsed = PatchSchema.safeParse(incoming);
      if (!parsed.success || parsed.data.base.id !== id || parsed.data.flow.id !== id) return null;
      return transaction(id, async current => {
        if (!current) throw new StoreError('NOT_FOUND', 'Холст не найден.');
        if ((parsed.data.base.rev ?? 0) > (current.rev ?? 0)) throw new StoreError('CONFLICT', 'Серверная версия холста отстаёт от открытой. Обнови страницу.');
        const key = digest(['patch', parsed.data.base, parsed.data.flow]);
        if (await applied(id, key)) return current;
        return saveOnce(current, await merged(current, parsed.data.base, parsed.data.flow), parsed.data.flow, key);
      });
    },
    async archiveLegacy(incoming: unknown): Promise<{ archived: true; flow: Flow | null } | null> {
      const parsed = FlowSchema.safeParse(incoming);
      if (!parsed.success || !FLOW_ID.test(parsed.data.id)) return null;
      const desired = parsed.data;
      return transaction(desired.id, async current => {
        await archive('legacy', desired);
        const key = digest(['legacy', desired]);
        if (await applied(desired.id, key)) return { archived: true, flow: current ?? null };
        if (!current) { await remember(desired.id, key); return { archived: true, flow: null }; }
        let base = (desired.rev ?? 0) === (current.rev ?? 0) ? current : undefined;
        if (!base) {
          const prefix = `r-${desired.rev ?? 0}-`;
          for (const file of await revisionFiles(desired.id)) {
            if (file.startsWith(prefix)) { base = (await savedVersion(desired.id, file.slice(0, -5)))?.flow; break; }
          }
        }
        if (!base) { await remember(desired.id, key); return { archived: true, flow: current }; }
        try { return { archived: true, flow: await saveOnce(current, await merged(current, base, desired), desired, key) }; }
        catch (error) {
          if (error instanceof FlowMergeError) { await remember(desired.id, key); return { archived: true, flow: current }; }
          throw error;
        }
      });
    },
    async restore(id: string): Promise<Flow | undefined> {
      return transaction(id, async current => {
        if (current !== undefined) throw new StoreError('CONFLICT', 'Холст уже существует.');
        try { await rename(path.join(dir, 'trash', `${id}.json`), fileOf(id)); }
        catch { return undefined; }
        return get(id);
      });
    },
    async remove(id: string): Promise<boolean> {
      return transaction(id, async current => {
        if (!current) return false;
        await archive('revision', current);
        const trash = path.join(dir, 'trash');
        await mkdir(trash, { recursive: true });
        await rename(fileOf(id), path.join(trash, `${id}.json`));
        return true;
      });
    },
  };
}

export type Flows = ReturnType<typeof createFlows>;
