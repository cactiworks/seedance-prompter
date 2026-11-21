import { studioFetch as fetch } from '../remoteFetch.ts';
import { create } from 'zustand';
import { modelsOf, paramsFor, type MediaKind } from '../../core/gen/models.ts';
import { CanvasEdgeSchema, CanvasNodeSchema, FlowSchema, portAccepts, inputsOf, dropStaleEdges, outputOf, type CanvasEdge, type CanvasNode, type CanvasNodeType, type Flow, type InputPort } from '../../core/model/canvas.ts';
import { wouldCycle } from '../../core/canvas/plan.ts';
import { inputFingerprint, invalidateChanged } from '../../core/canvas/freshness.ts';
import { cloneSeedance } from '../../core/canvas/seedance.ts';
import { mergeCanvasFlow } from '../../core/canvas/merge.ts';

const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };
/** Префикс нод в системном буфере — чтобы вставка работала между flows и вкладками. */
export const CLIPBOARD_PREFIX = 'sp-canvas:';

class CanvasHttpError extends Error {
  status: number;
  recovery?: Flow;
  constructor(message: string, status: number, recovery?: Flow) { super(message); this.status = status; this.recovery = recovery; }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { messageRu?: string; error?: string; current?: unknown; historyId?: string };
    const recovery = res.status === 409 && body.historyId ? FlowSchema.safeParse(body.current).data : undefined;
    throw new CanvasHttpError(body.messageRu ?? body.error ?? `HTTP ${res.status}`, res.status, recovery);
  }
  return (await res.json()) as T;
}

export interface FlowListItem {
  id: string;
  name: string;
  nodes: number;
  updatedAt: string;
  production?: Flow['production'];
}

export interface FlowHistoryItem {
  id: string;
  kind: 'revision' | 'legacy' | 'recovery';
  rev: number;
  name: string;
  nodes: number;
  createdAt: string;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

let seq = 0;
export const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1).toString(36)}`;

/** Ширина нод — фиксированная: по ней считаются координаты портов для рёбер. */
export const NODE_WIDTH: Record<CanvasNodeType, number> = { comment: 280, ai: 300, prompt: 260, image: 260, generator: 300, frame: 240, trim: 280, video: 260, resize: 260, seedance: 300, upscale: 280 };
/** Вертикаль портов: выход и первый вход — под шапкой, остальные входы — шагом PORT_STEP. */
export const PORT_TOP = 58;
export const PORT_STEP = 30;

const HISTORY_LIMIT = 60;
/** Правки с одним ключом подряд (движение ноды, набор текста) — один шаг отмены. */
const COALESCE_MS = 1_500;

export function blankNode(type: CanvasNodeType, x: number, y: number, kind: MediaKind = 'image'): CanvasNode {
  const model = modelsOf(kind)[0];
  return CanvasNodeSchema.parse({
    id: newId('n'),
    type,
    x,
    y,
    kind,
    modelId: type === 'generator' ? (model?.id ?? '') : '',
    params: type === 'generator' && model !== undefined ? paramsFor(model, {}) : type === 'upscale' ? { upscaleFactor: '2' } : {},
  });
}

/** Imported copies keep material history, never a current AI approval from another graph. */
export function remapCanvasCopy(node: CanvasNode, ids: ReadonlyMap<string, string>): CanvasNode {
  return { ...node, id: ids.get(node.id) ?? node.id, production: undefined, ai: undefined, aiSource: node.aiSource ? { ...node.aiSource, aiNodeId: ids.get(node.aiSource.aiNodeId) ?? node.aiSource.aiNodeId } : undefined, aiApproval: undefined,
    targetGeneratorId: node.targetGeneratorId ? ids.get(node.targetGeneratorId) ?? null : null,
    acceptedJobId: null, acceptedMediaId: null, runInputFingerprint: undefined, ...cloneSeedance(node) };
}

interface CanvasState {
  flows: FlowListItem[];
  flow: Flow | null;
  save: SaveState;
  /** Последняя выбранная нода — к ней относятся одиночные действия. */
  selected: string | null;
  /** Все выделенные ноды: Shift+клик, рамка Shift+протяжкой, ⌘A. Группа двигается, удаляется и копируется вместе. */
  selection: string[];
  aiDrawer: { nodeId: string; stage: 'idea' | 'prompt' } | null;
  openAi: (nodeId: string, stage?: 'idea' | 'prompt') => void;
  closeAi: () => void;
  /** Create/reuse a visible prompt step; never runs AI or changes an approved idea. */
  addAiPrompt: (aiNodeId: string) => string | null;
  focusNode: (nodeId: string) => void;
  /** A server operation may update approval/projection and flow revision. Never replace newer local edits. */
  applyServerFlow: (flow: Flow, expected: Flow) => boolean;
  error: string | null;
  past: Flow[];
  future: Flow[];
  loadFlows: () => Promise<void>;
  openFlow: (id: string, reload?: boolean) => Promise<boolean>;
  newFlow: (from?: Pick<Flow, 'nodes' | 'edges' | 'name'>) => Promise<void>;
  deleteFlow: (id: string) => Promise<void>;
  restoreFlow: (id: string) => Promise<void>;
  loadHistory: (id: string) => Promise<FlowHistoryItem[]>;
  loadHistoryVersion: (id: string, version: string) => Promise<Flow>;
  restoreHistoryVersion: (id: string, version: string) => Promise<boolean>;
  flush: () => Promise<boolean>;
  retrySave: () => Promise<boolean>;
  captureResult: (id: string) => (patch: Partial<CanvasNode>) => boolean;
  /**
   * Единственный путь менять flow: чистая функция, автосейв сам. `historyKey` — правки с одним ключом подряд
   * склеиваются в один шаг отмены; null — отдельный шаг; false — без истории (вид холста).
   */
  update: (recipe: (flow: Flow) => Flow, historyKey?: string | null | false) => void;
  undo: () => void;
  redo: () => void;
  rename: (name: string) => void;
  addNode: (type: CanvasNodeType, x: number, y: number, kind?: MediaKind) => string;
  patchNode: (id: string, patch: Partial<CanvasNode>, historyKey?: string | null | false) => void;
  removeNode: (id: string) => void;
  /** `additive` — Shift: добавить к выделению или убрать из него. */
  select: (id: string | null, additive?: boolean) => void;
  selectMany: (ids: string[]) => void;
  removeSelected: () => void;
  /** Сдвиг нескольких нод одним шагом истории (перетаскивание группы). */
  moveNodes: (positions: { id: string; x: number; y: number }[], historyKey: string) => void;
  /** null — связь создана; строка — почему нельзя. */
  connect: (from: string, to: string, port: InputPort) => string | null;
  disconnect: (edgeId: string) => void;
  setViewport: (viewport: Flow['viewport']) => void;
  /** Копия выделенных нод со связями между ними (связи наружу группы не копируются). */
  copySelected: () => string | null;
  /** Вставить ноды из текста буфера `sp-canvas:`; возвращает число вставленных. */
  pasteNodes: (text: string, at: { x: number; y: number }) => number;
  duplicateSelected: () => void;
  createCorrectionBranch: (generatorId: string) => string | null;
  /**
   * «В canvas» из просмотра работы: файл библиотеки — новой нодой (картинка или видео) правее всего графа в
   * открытом flow; flow нет — создаётся. Вид сдвигается к новой ноде.
   */
  sendMedia: (item: { id: string; kind: 'image' | 'video'; label: string }) => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastKey: { key: string; at: number } | null = null;

export const useCanvas = create<CanvasState>((set, get) => {
  // Only server snapshots are durable. Unsaved edits stay in this tab's memory
  // until acknowledged, independently for every flow visited in the session.
  const pending = new Map<string, Flow>();
  const acknowledgedBase = new Map<string, Flow>();
  const failures = new Map<string, string>();
  const recoveryNotes = new Map<string, string>();
  const attempts = new Map<string, number>();
  const restoring = new Set<string>();
  const restoreBusy = new Set<string>();
  const restoreRequests = new Map<string, { version: string; requestId: string; clicked: Flow; hadPending: boolean; archived: boolean; rev?: number }>();
  const restoreEdits = new Map<string, { base: Flow; flow: Flow }[]>();
  const inFlight = new Map<string, Promise<Flow>>();
  const submissions = new Map<string, { base: Flow; flow: Flow; edits: { base: Flow; flow: Flow }[] }>();
  let writing: Promise<boolean> | null = null;
  let migrating: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let navigation = 0;
  const retryDelays = [1_500, 5_000, 15_000, 30_000];
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const listItem = (flow: Flow): FlowListItem => ({ id: flow.id, name: flow.name, nodes: flow.nodes.length, updatedAt: flow.updatedAt, production: flow.production });
  const updateList = (flow: Flow): void => set(state => ({ flows: state.flows.map(item => item.id === flow.id ? listItem(flow) : item) }));
  const rebaseHistory = (before: Flow | null, after: Flow): void => {
    if (before?.id !== after.id || get().flow?.id !== after.id) return;
    // History represents user changes relative to the visible graph, including
    // deliberate deletions. Preserve those inverse changes over server results.
    set(state => ({ past: state.past.map(snapshot => mergeCanvasFlow(before, snapshot, after)), future: state.future.map(snapshot => mergeCanvasFlow(before, snapshot, after)) }));
  };
  const rebaseEdit = (base: Flow, desired: Flow, canonical: Flow): Flow | null => {
    const merged = mergeCanvasFlow(base, desired, canonical);
    if (!FlowSchema.safeParse(merged).success) return null;
    // Let the server receive the original edit if it would otherwise disappear
    // behind a deletion or a competing addition during a client-side rebase.
    const before = new Map(base.nodes.map(node => [node.id, node]));
    const latest = new Map(canonical.nodes.map(node => [node.id, node]));
    if (desired.nodes.some(node => {
      const old = before.get(node.id); const current = latest.get(node.id);
      return old ? !current && !same(old, node) : current && !same(current, node);
    })) return null;
    const oldEdges = new Map(base.edges.map(edge => [edge.id, edge]));
    const mergedEdges = new Map(merged.edges.map(edge => [edge.id, edge]));
    if (desired.edges.some(edge => !same(oldEdges.get(edge.id), edge) && !same(mergedEdges.get(edge.id), edge))) return null;
    return merged;
  };
  const showCanonical = (canonical: Flow, base: Flow): Flow => {
    const latestBase = acknowledgedBase.get(canonical.id);
    if (latestBase && (latestBase.rev ?? 0) > (canonical.rev ?? 0)) return pending.get(canonical.id) ?? latestBase;
    const desired = pending.get(canonical.id);
    const merged = desired ? rebaseEdit(base, desired, canonical) : canonical;
    if (!merged) return desired!;
    rebaseHistory(get().flow, merged);
    acknowledgedBase.set(canonical.id, canonical);
    if (same(merged, canonical) && !submissions.has(canonical.id)) pending.delete(canonical.id); else pending.set(canonical.id, merged);
    updateList(canonical);
    return merged;
  };
  const acknowledge = (response: Flow, edits: { base: Flow; flow: Flow }[]): void => {
    const id = response.id;
    const previous = acknowledgedBase.get(id);
    const canonical = previous && (previous.rev ?? 0) > (response.rev ?? 0) ? previous : response;
    let merged = canonical;
    submissions.delete(id);
    for (const [index, edit] of edits.entries()) {
      const rebased = rebaseEdit(edit.base, edit.flow, merged);
      if (rebased) { merged = rebased; continue; }
      // Send any successfully rebased edits first, then submit the original
      // conflicting graph so the server can preserve it in recovery history.
      if (same(merged, canonical)) submissions.set(id, { ...edit, edits: edits.slice(index + 1) });
      else submissions.set(id, { base: canonical, flow: merged, edits: edits.slice(index) });
      merged = pending.get(id) ?? merged;
      break;
    }
    rebaseHistory(get().flow, merged);
    acknowledgedBase.set(id, canonical);
    if (same(merged, canonical) && !submissions.has(id)) pending.delete(id); else pending.set(id, merged);
    failures.delete(id); attempts.delete(id);
    updateList(canonical);
    if (get().flow?.id === id) set({ flow: merged, save: pending.has(id) ? 'dirty' : 'saved', error: recoveryNotes.get(id) ?? null });
  };
  const transientFailure = (error: unknown): boolean => error instanceof CanvasHttpError ? error.status === 408 || error.status === 429 || error.status >= 500 : error instanceof TypeError;
  const scheduleRetry = (id: string, error: unknown): void => {
    const transient = transientFailure(error);
    const attempt = attempts.get(id) ?? 0;
    if (!transient || attempt >= retryDelays.length) return;
    attempts.set(id, attempt + 1);
    if (retryTimer !== null) return;
    retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, retryDelays[attempt]);
  };
  const migrateLegacyDrafts = async (): Promise<void> => {
    if (migrating !== null) return migrating;
    migrating = (async () => {
      let keys: string[];
      try { keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => key?.startsWith('sp-canvas-draft:') === true); }
      catch { return; }
      for (const key of keys) {
        try {
          const raw = localStorage.getItem(key);
          if (raw === null) continue;
          const legacy = FlowSchema.parse(JSON.parse(raw));
          const result = await json<{ archived: boolean; flow: Flow | null }>(await fetch('/api/canvas/legacy-drafts', { method: 'POST', headers: HEADERS, body: JSON.stringify({ flow: legacy }) }));
          if (!result.archived) continue;
          // Never delete an old browser draft until the VPS confirms its archive.
          if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
          if (result.flow !== null) {
            const base = acknowledgedBase.get(result.flow.id) ?? result.flow;
            const flow = showCanonical(result.flow, base);
            if (get().flow?.id === flow.id) set({ flow, save: failures.has(flow.id) ? 'error' : pending.has(flow.id) ? 'dirty' : 'saved', error: failures.get(flow.id) ?? recoveryNotes.get(flow.id) ?? null });
          }
        } catch {
          // A failed archive stays available for the next load/reconnect. It is
          // never restored over a newer server flow or discarded on a GET error.
        }
      }
    })();
    try { await migrating; } finally { migrating = null; }
  };
  const drain = async (): Promise<boolean> => {
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    if (writing !== null) {
      const saved = await writing;
      return saved && [...pending.keys()].some(id => !restoring.has(id)) ? drain() : saved;
    }
    writing = (async () => {
      const failed = new Set<string>();
      while ([...pending.keys()].some(id => !failed.has(id) && !restoring.has(id))) {
        const entry = [...pending.entries()].find(([id]) => !failed.has(id) && !restoring.has(id));
        if (!entry) break;
        const [id, snapshot] = entry;
        const submission = submissions.get(id) ?? { base: acknowledgedBase.get(id) ?? snapshot, flow: snapshot, edits: [] };
        submissions.set(id, submission);
        if (get().flow?.id === id) set({ save: 'saving', error: null });
        try {
          const operation = fetch(`/api/canvas/flows/${id}`, { method: 'PATCH', headers: HEADERS, body: JSON.stringify({ base: submission.base, flow: submission.flow }) }).then(json<Flow>).then(value => FlowSchema.parse(value));
          inFlight.set(id, operation);
          // Apply only edits made after this request. The ACK may contain server
          // AI results, added nodes and approvals absent from the submitted flow.
          acknowledge(await operation, submission.edits);
        } catch (error) {
          if (error instanceof CanvasHttpError && error.recovery?.id === id) {
            recoveryNotes.set(id, error.message);
            acknowledge(error.recovery, submission.edits);
            continue;
          }
          const message = error instanceof Error ? error.message : 'Не удалось сохранить на сервере. Повторим при восстановлении связи.';
          if (!transientFailure(error)) submissions.delete(id);
          failures.set(id, message); failed.add(id);
          if (get().flow?.id === id) set({ save: 'error', error: message });
          scheduleRetry(id, error);
        } finally { inFlight.delete(id); }
      }
      return pending.size === 0;
    })();
    let saved: boolean;
    try { saved = await writing; } finally { writing = null; }
    // Another caller can enqueue an edit in the microtask between the empty
    // drain completing and its Promise finally releasing the writer.
    return saved && [...pending.keys()].some(id => !restoring.has(id)) ? drain() : saved;
  };
  const flush = async (): Promise<boolean> => {
    const focused = get().flow?.id;
    const allSaved = await drain();
    return focused === undefined ? allSaved : !pending.has(focused) && !restoring.has(focused);
  };
  const persist = (): void => {
    const snapshot = get().flow;
    if (snapshot === null) return;
    const before = pending.get(snapshot.id) ?? acknowledgedBase.get(snapshot.id);
    if (before) {
      submissions.get(snapshot.id)?.edits.push({ base: before, flow: snapshot });
      if (restoring.has(snapshot.id)) restoreEdits.get(snapshot.id)?.push({ base: before, flow: snapshot });
    }
    pending.set(snapshot.id, snapshot);
    failures.delete(snapshot.id); attempts.delete(snapshot.id);
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, 600);
  };
  if (typeof window !== 'undefined') {
    const reconnect = (): void => { attempts.clear(); void migrateLegacyDrafts(); void flush(); };
    window.addEventListener('online', reconnect);
    window.addEventListener('focus', reconnect);
    window.addEventListener('beforeunload', event => {
      if (pending.size === 0 && restoring.size === 0) return;
      event.preventDefault(); event.returnValue = '';
    });
  }

  const pushHistory = (flow: Flow, key: string | null): void => {
    const now = Date.now();
    if (key !== null && lastKey !== null && lastKey.key === key && now - lastKey.at < COALESCE_MS) {
      lastKey = { key, at: now };
      return;
    }
    lastKey = key === null ? null : { key, at: now };
    set((s) => ({ past: [...s.past.slice(-(HISTORY_LIMIT - 1)), flow], future: [] }));
  };

  /** Копия ноды без результатов: запуски принадлежат исходной ноде. Seedance-промптер получит копию черновика при открытии. */
  const cloneNode = (node: CanvasNode, dx: number, dy: number): CanvasNode => ({ ...node, production: undefined, id: newId('n'), x: node.x + dx, y: node.y + dy, jobIds: [], selected: 0, mediaId: node.type === 'video' ? node.mediaId : null, stale: false, runInputFingerprint: undefined, ai: undefined, aiSource: undefined, aiApproval: undefined, targetGeneratorId: null, acceptedJobId: null, acceptedMediaId: null, ...cloneSeedance(node) });

  /** Выделенные ноды и связи внутри группы — то, что копируется и дублируется вместе. */
  const group = (): { nodes: CanvasNode[]; edges: CanvasEdge[] } => {
    const { flow, selection } = get();
    if (flow === null) return { nodes: [], edges: [] };
    const ids = new Set(selection);
    return { nodes: flow.nodes.filter((n) => ids.has(n.id)), edges: flow.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  };

  /** Вставить копии нод со сдвигом; связи переносятся по новым id. Возвращает id копий. */
  const insertCopies = (nodes: CanvasNode[], edges: CanvasEdge[], dx: number, dy: number): string[] => {
    const ids = new Map<string, string>();
    const copies = nodes.map((n) => {
      const c = cloneNode(n, dx, dy);
      ids.set(n.id, c.id);
      return c;
    });
    for (let index = 0; index < copies.length; index += 1) {
      const original = nodes[index];
      const copy = copies[index];
      if (original && copy && original.type === 'ai') copy.targetGeneratorId = original.targetGeneratorId ? ids.get(original.targetGeneratorId) ?? null : null;
      if (original?.aiSource && copy) copy.aiSource = { ...original.aiSource, aiNodeId: ids.get(original.aiSource.aiNodeId) ?? original.aiSource.aiNodeId };
    }
    const copiedEdges = edges.flatMap((e) => {
      const from = ids.get(e.from);
      const to = ids.get(e.to);
      return from === undefined || to === undefined ? [] : [{ ...e, id: newId('e'), from, to }];
    });
    get().update((f) => ({ ...f, nodes: [...f.nodes, ...copies], edges: [...f.edges, ...copiedEdges] }));
    const created = copies.map((c) => c.id);
    set({ selection: created, selected: created.at(-1) ?? null });
    return created;
  };

  return {
    flows: [],
    flow: null,
    save: 'saved',
    selected: null,
    selection: [],
    aiDrawer: null,
    openAi: (nodeId, stage = 'idea') => set({ aiDrawer: { nodeId, stage } }),
    closeAi: () => set({ aiDrawer: null }),
    addAiPrompt: (aiNodeId) => {
      const flow = get().flow;
      const ai = flow?.nodes.find(n => n.id === aiNodeId && n.type === 'ai');
      if (!flow || !ai) return null;
      const existingEdge = flow.edges.find(e => e.from === ai.id && e.port === 'idea' && flow.nodes.some(n => n.id === e.to && n.type === 'prompt'));
      const existing = flow.nodes.find(n => n.id === existingEdge?.to) ?? flow.nodes.find(n => n.type === 'prompt' && n.aiSource?.aiNodeId === ai.id);
      if (existing) return existing.id;
      const prompt = { ...blankNode('prompt', ai.x + NODE_WIDTH.ai + 60, ai.y, ai.kind), label: 'AI · промпт' };
      const edges: CanvasEdge[] = [{ id: newId('e'), from: ai.id, to: prompt.id, port: 'idea' }];
      if (ai.targetGeneratorId && flow.nodes.some(n => n.id === ai.targetGeneratorId && n.type === 'generator')) edges.push({ id: newId('e'), from: prompt.id, to: ai.targetGeneratorId, port: 'prompt' });
      get().update(f => ({ ...f, nodes: [...f.nodes, prompt], edges: [...f.edges, ...edges] }));
      return prompt.id;
    },
    focusNode: (nodeId) => {
      const flow = get().flow;
      const node = flow?.nodes.find(n => n.id === nodeId);
      if (!flow || !node) return;
      set({ selected: nodeId, selection: [nodeId] });
      get().setViewport({ ...flow.viewport, x: 80 - node.x * flow.viewport.zoom, y: 120 - node.y * flow.viewport.zoom });
    },
    applyServerFlow: (flow, expected) => {
      const current = get().flow;
      if (flow.id !== expected.id || current?.id !== flow.id || (flow.rev ?? 0) < (acknowledgedBase.get(flow.id)?.rev ?? current.rev ?? 0)) return false;
      const merged = showCanonical(flow, acknowledgedBase.get(flow.id) ?? expected);
      if (acknowledgedBase.get(flow.id) !== flow) return false;
      failures.delete(flow.id);
      set({ flow: merged, save: pending.has(flow.id) ? 'dirty' : 'saved', error: recoveryNotes.get(flow.id) ?? null });
      return true;
    },
    error: null,
    past: [],
    future: [],

    loadFlows: async () => {
      await migrateLegacyDrafts();
      try {
        const flows = await json<FlowListItem[]>(await fetch('/api/canvas/flows'));
        set({ flows });
        if (get().flow === null && flows[0] !== undefined) await get().openFlow(flows[0].id);
      } catch (error) { set({ error: String(error) }); }
    },
    flush,
    retrySave: async () => {
      const id = get().flow?.id;
      const intention = id ? restoreRequests.get(id) : undefined;
      return id && intention ? get().restoreHistoryVersion(id, intention.version) : flush();
    },
    captureResult: (id) => {
      const started = get().flow;
      const fingerprint = started === null ? null : inputFingerprint(started, id);
      return (patch) => {
        const current = get().flow;
        if (current === null || current.id !== started?.id || !current.nodes.some((n) => n.id === id) || inputFingerprint(current, id) !== fingerprint) return false;
        get().patchNode(id, { ...patch, stale: false });
        return true;
      };
    },
    openFlow: async (id, reload = false) => {
      const request = ++navigation;
      if (get().flow?.id === id && !reload) return true;
      await flush();
      if (request !== navigation) return false;
      let saved: Flow;
      try { saved = FlowSchema.parse(await json<Flow>(await fetch(`/api/canvas/flows/${id}`))); }
      catch (error) { if (request === navigation) set({ error: error instanceof Error ? error.message : 'Не удалось открыть холст.' }); return false; }
      if (request !== navigation) return false;
      // Capture keystrokes made while the destination was loading. Failure does
      // not block navigation: each flow keeps its own pending in-memory queue.
      await flush();
      if (request !== navigation) return false;
      const base = acknowledgedBase.get(id) ?? saved;
      const flow = showCanonical(saved, base);
      lastKey = null;
      set({ flow, selected: null, selection: [], save: failures.has(id) ? 'error' : pending.has(id) ? 'dirty' : 'saved', past: [], future: [], error: failures.get(id) ?? recoveryNotes.get(id) ?? null });
      return true;
    },
    newFlow: async (from) => {
      const request = ++navigation;
      await flush();
      if (request !== navigation) return;
      const created = FlowSchema.parse(await json<Flow>(await fetch('/api/canvas/flows', { method: 'POST', headers: HEADERS, body: JSON.stringify({ name: from?.name ?? '' }) })));
      await flush();
      if (request !== navigation) { await get().loadFlows(); return; }
      lastKey = null;
      acknowledgedBase.set(created.id, created);
      set({ flow: from === undefined ? created : { ...created, nodes: from.nodes, edges: from.edges }, save: from === undefined ? 'saved' : 'dirty', error: null, selected: null, selection: [], past: [], future: [] });
      if (from !== undefined) persist();
      await get().loadFlows();
    },
    deleteFlow: async (id) => {
      if (!await flush()) return;
      await json(await fetch(`/api/canvas/flows/${id}`, { method: 'DELETE', headers: HEADERS }));
      pending.delete(id); submissions.delete(id); acknowledgedBase.delete(id); failures.delete(id); attempts.delete(id); recoveryNotes.delete(id);
      if (get().flow?.id === id) set({ flow: null, past: [], future: [] });
      await get().loadFlows();
    },

    restoreFlow: async (id) => {
      await json(await fetch(`/api/canvas/flows/${id}/restore`, { method: 'POST', headers: HEADERS }));
      await get().openFlow(id);
      await get().loadFlows();
    },
    loadHistory: async (id) => json<FlowHistoryItem[]>(await fetch(`/api/canvas/flows/${encodeURIComponent(id)}/history`)),
    loadHistoryVersion: async (id, version) => FlowSchema.parse(await json<Flow>(await fetch(`/api/canvas/flows/${encodeURIComponent(id)}/history/${encodeURIComponent(version)}`))),
    restoreHistoryVersion: async (id, version) => {
      const clicked = get().flow;
      if (clicked?.id !== id || restoreBusy.has(id)) return false;
      let intention = restoreRequests.get(id);
      if (intention && intention.version !== version) throw new Error('Повтори восстановление выбранной версии, чтобы подтвердить результат.');
      if (!intention) {
        intention = { version, requestId: newId('restore-'), clicked, hadPending: pending.has(id), archived: false };
        restoreRequests.set(id, intention); restoreEdits.set(id, []);
      }
      restoring.add(id); restoreBusy.add(id);
      let restoreSent = false;
      let uncertain = false;
      try {
        // Stop this flow's autosave before replacing it. A request already on the
        // wire may finish; unrelated failed queues do not prevent restoration.
        await inFlight.get(id)?.catch(() => undefined);
        if (intention.hadPending && !intention.archived) {
          const archived = await json<{ archived: boolean }>(await fetch('/api/canvas/legacy-drafts', { method: 'POST', headers: HEADERS, body: JSON.stringify({ flow: intention.clicked }) }));
          if (!archived.archived) throw new Error('Не удалось сохранить текущие изменения перед восстановлением.');
          intention.archived = true;
        }
        if (intention.rev === undefined) {
          const latest = FlowSchema.parse(await json<Flow>(await fetch(`/api/canvas/flows/${encodeURIComponent(id)}`)));
          intention.rev = latest.rev ?? 0;
        }
        restoreSent = true;
        const restored = FlowSchema.parse(await json<Flow>(await fetch(`/api/canvas/flows/${encodeURIComponent(id)}/history/${encodeURIComponent(version)}/restore`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ rev: intention.rev, requestId: intention.requestId }) })));
        // Only user edits made after the restore click survive. Remote AI updates
        // observed while waiting must not restore revoked approvals or old data.
        recoveryNotes.delete(id);
        acknowledge(restored, restoreEdits.get(id) ?? []);
        if (get().flow?.id === id) set({ selected: null, selection: [], past: [], future: [] });
        return true;
      } catch (error) {
        uncertain = restoreSent && transientFailure(error);
        if (uncertain) {
          const message = 'Ответ сервера не получен. Повтори сохранение, чтобы подтвердить восстановление выбранной версии.';
          if (get().flow?.id === id) set({ save: 'error', error: message });
          throw new Error(message);
        }
        throw error;
      } finally {
        restoreBusy.delete(id);
        // An uncertain restore keeps the old queue paused. Explicit retry uses
        // the exact receipt key, so it can never apply the replacement twice.
        if (!uncertain) {
          restoring.delete(id); restoreEdits.delete(id); restoreRequests.delete(id);
          if (pending.has(id)) {
            if (saveTimer !== null) clearTimeout(saveTimer);
            saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, 600);
          }
        }
      }
    },
    update: (recipe, historyKey = null) => {
      const flow = get().flow;
      if (flow === null) return;
      if (!acknowledgedBase.has(flow.id)) acknowledgedBase.set(flow.id, flow);
      if (historyKey !== false) pushHistory(flow, historyKey);
      set({ flow: invalidateChanged(flow, recipe(flow)), save: 'dirty', error: null });
      persist();
    },
    undo: () => {
      const { flow, past } = get();
      const prev = past.at(-1);
      if (flow === null || prev === undefined) return;
      lastKey = null;
      // Вид холста не откатываем: отмена правит граф, а не то, куда смотрит владелец.
      set((s) => ({ flow: { ...prev, rev: flow.rev, viewport: flow.viewport }, past: s.past.slice(0, -1), future: [...s.future, flow], save: 'dirty', selected: prev.nodes.some((n) => n.id === s.selected) ? s.selected : null, selection: s.selection.filter((id) => prev.nodes.some((n) => n.id === id)) }));
      persist();
    },
    redo: () => {
      const { flow, future } = get();
      const next = future.at(-1);
      if (flow === null || next === undefined) return;
      lastKey = null;
      set((s) => ({ flow: { ...next, rev: flow.rev, viewport: flow.viewport }, future: s.future.slice(0, -1), past: [...s.past, flow], save: 'dirty' }));
      persist();
    },
    rename: (name) => get().update((f) => ({ ...f, name }), 'rename'),

    addNode: (type, x, y, kind = 'image') => {
      const node = blankNode(type, x, y, kind);
      get().update((f) => ({ ...f, nodes: [...f.nodes, node] }));
      set({ selected: node.id, selection: [node.id] });
      return node.id;
    },
    patchNode: (id, patch, historyKey = null) => get().update((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }), historyKey),
    removeNode: (id) => {
      get().update((f) => ({ ...f, nodes: f.nodes.filter((n) => n.id !== id), edges: f.edges.filter((e) => e.from !== id && e.to !== id) }));
      set((s) => ({ selected: s.selected === id ? null : s.selected, selection: s.selection.filter((x) => x !== id) }));
    },
    select: (id, additive = false) =>
      set((s) => {
        if (id === null) return additive ? {} : { selected: null, selection: [] };
        if (!additive) return { selected: id, selection: s.selection.includes(id) && s.selection.length > 1 ? s.selection : [id] };
        const on = s.selection.includes(id);
        const selection = on ? s.selection.filter((x) => x !== id) : [...s.selection, id];
        return { selection, selected: on ? (selection.at(-1) ?? null) : id };
      }),
    selectMany: (ids) => set({ selection: ids, selected: ids.at(-1) ?? null }),
    removeSelected: () => {
      const ids = new Set(get().selection);
      if (ids.size === 0) return;
      get().update((f) => ({ ...f, nodes: f.nodes.filter((n) => !ids.has(n.id)), edges: f.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)) }));
      set({ selected: null, selection: [] });
    },
    moveNodes: (positions, historyKey) => {
      const at = new Map(positions.map((p) => [p.id, p]));
      get().update((f) => ({ ...f, nodes: f.nodes.map((n) => (at.has(n.id) ? { ...n, x: at.get(n.id)?.x ?? n.x, y: at.get(n.id)?.y ?? n.y } : n)) }), historyKey);
    },

    connect: (from, to, port) => {
      const flow = get().flow;
      if (flow === null) return 'Нет flow.';
      if (from === to) return 'Нода не соединяется сама с собой.';
      const sourceNode = flow.nodes.find((n) => n.id === from);
      const targetNode = flow.nodes.find((n) => n.id === to);
      if (sourceNode === undefined || targetNode === undefined || !inputsOf(targetNode, ['ref', 'start', 'end']).includes(port) || !portAccepts(port, outputOf(sourceNode))) return 'Несовместимые порты.';
      if (wouldCycle(flow, from, to)) return 'Так получится цикл.';
      // Во входы «Старт», «Финал» и «Видео» — одна связь; повторная заменяет прежнюю.
      const replace = (e: CanvasEdge): boolean => e.to === to && e.port === port && (port === 'start' || port === 'end' || port === 'video' || port === 'media' || port === 'idea');
      if (flow.edges.some((e) => e.from === from && e.to === to && e.port === port)) return null;
      // «Размер» и апскейл отдают то же, что получили: картинку или видео; прежний результат другого вида больше не годится
      // (у апскейла его запуски остаются в библиотеке, но выходом ноды быть не могут).
      const source = flow.nodes.find((n) => n.id === from);
      const kind = source === undefined ? 'image' : outputOf(source) === 'video' ? 'video' : 'image';
      const retype = (n: CanvasNode): CanvasNode => (n.kind === kind ? n : { ...n, kind, mediaId: null, jobIds: [], selected: 0 });
      // Выход сменил вид — связи дальше, которые его больше не принимают, снимаются.
      get().update((f) =>
        dropStaleEdges(
          {
            ...f,
            nodes: port === 'media' ? f.nodes.map((n) => (n.id === to ? retype(n) : n)) : f.nodes,
            edges: [...f.edges.filter((e) => !replace(e)), { id: newId('e'), from, to, port }],
          },
          to,
        ),
      );
      return null;
    },
    disconnect: (edgeId) => get().update((f) => ({ ...f, edges: f.edges.filter((e) => e.id !== edgeId) })),
    setViewport: (viewport) => get().update((f) => ({ ...f, viewport }), false),

    copySelected: () => {
      const copied = group();
      return copied.nodes.length === 0 ? null : `${CLIPBOARD_PREFIX}${JSON.stringify(copied)}`;
    },
    pasteNodes: (text, at) => {
      if (!text.startsWith(CLIPBOARD_PREFIX)) return 0;
      try {
        const parsed = JSON.parse(text.slice(CLIPBOARD_PREFIX.length)) as { nodes?: unknown; edges?: unknown };
        const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).map((n) => CanvasNodeSchema.parse(n));
        const edges = (Array.isArray(parsed.edges) ? parsed.edges : []).map((e) => CanvasEdgeSchema.parse(e));
        if (nodes.length === 0) return 0;
        FlowSchema.parse({ ...get().flow, nodes, edges });
        const minX = Math.min(...nodes.map((n) => n.x));
        const minY = Math.min(...nodes.map((n) => n.y));
        return insertCopies(nodes, edges, at.x - minX, at.y - minY).length;
      } catch {
        return 0;
      }
    },
    duplicateSelected: () => {
      const copied = group();
      if (copied.nodes.length > 0) insertCopies(copied.nodes, copied.edges, 32, 32);
    },
    createCorrectionBranch: (generatorId) => {
      const flow = get().flow;
      const generator = flow?.nodes.find(n => n.id === generatorId && n.type === 'generator');
      const ai = flow?.nodes.find(n => n.type === 'ai' && n.targetGeneratorId === generatorId);
      if (!flow || !generator || !ai) return null;
      const y = Math.max(...flow.nodes.map(n => n.y)) + 600;
      const nextGenerator = { ...cloneNode(generator, 0, y - generator.y), label: generator.label ? `${generator.label} · правки` : '' };
      const nextAi = { ...blankNode('ai', generator.x - 720, y, generator.kind), targetGeneratorId: nextGenerator.id };
      const comment = { ...blankNode('comment', generator.x - 1080, y), text: `Правки к результату ${generator.label || generator.id}.\n${ai.ai?.idea?.text ? `Прежняя идея (исходный материал):\n${ai.ai.idea.text}\n\n` : ''}${ai.ai?.prompt?.text ? `Прежний prompt (исходный материал):\n${ai.ai.prompt.text}\n\n` : ''}Что сохранить и что изменить: ` };
      const copiedInputs = flow.edges.filter(e => (e.to === ai.id && (e.port === 'context' || e.port === 'ref')) || (e.to === generator.id && e.port !== 'prompt'))
        .map(e => ({ ...e, id: newId('e'), to: e.to === ai.id ? nextAi.id : nextGenerator.id }));
      const prompt = { ...blankNode('prompt', nextAi.x + NODE_WIDTH.ai + 60, y, generator.kind), label: 'AI · промпт' };
      get().update(f => ({ ...f, nodes: [...f.nodes, comment, nextAi, prompt, nextGenerator], edges: [...f.edges, ...copiedInputs, { id: newId('e'), from: comment.id, to: nextAi.id, port: 'context' }, { id: newId('e'), from: nextAi.id, to: prompt.id, port: 'idea' }, { id: newId('e'), from: prompt.id, to: nextGenerator.id, port: 'prompt' }], viewport: { ...f.viewport, x: 80 - comment.x * f.viewport.zoom, y: 80 - y * f.viewport.zoom } }));
      set({ selected: comment.id, selection: [comment.id] });
      return nextAi.id;
    },
    sendMedia: async (item) => {
      if (get().flow === null) await get().loadFlows();
      if (get().flow === null) await get().newFlow();
      const flow = get().flow;
      if (flow === null) return;
      const x = flow.nodes.length === 0 ? 0 : Math.max(...flow.nodes.map((n) => n.x + NODE_WIDTH[n.type])) + 80;
      const y = flow.nodes.length === 0 ? 0 : Math.min(...flow.nodes.map((n) => n.y));
      const id = get().addNode(item.kind === 'video' ? 'video' : 'image', x, y);
      get().patchNode(id, item.kind === 'video' ? { mediaId: item.id, label: item.label } : { source: { type: 'media', mediaId: item.id }, label: item.label }, false);
      const zoom = get().flow?.viewport.zoom ?? 1;
      get().setViewport({ zoom, x: 240 - x * zoom, y: 160 - y * zoom });
    },
  };
});
