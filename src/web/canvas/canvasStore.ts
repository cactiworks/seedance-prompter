import { create } from 'zustand';
import { modelsOf, paramsFor, type MediaKind } from '../../core/gen/models.ts';
import { CanvasEdgeSchema, CanvasNodeSchema, type CanvasEdge, type CanvasNode, type CanvasNodeType, type Flow, type InputPort } from '../../core/model/canvas.ts';
import { wouldCycle } from '../../core/canvas/plan.ts';

const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };
/** Префикс нод в системном буфере — чтобы вставка работала между flows и вкладками. */
export const CLIPBOARD_PREFIX = 'sp-canvas:';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { messageRu?: string; error?: string };
    throw new Error(body.messageRu ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface FlowListItem {
  id: string;
  name: string;
  nodes: number;
  updatedAt: string;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

let seq = 0;
const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1).toString(36)}`;

/** Ширина нод — фиксированная: по ней считаются координаты портов для рёбер. */
export const NODE_WIDTH: Record<CanvasNodeType, number> = { prompt: 260, image: 260, generator: 300, frame: 240 };
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
    params: type === 'generator' && model !== undefined ? paramsFor(model, {}) : {},
  });
}

interface CanvasState {
  flows: FlowListItem[];
  flow: Flow | null;
  save: SaveState;
  selected: string | null;
  error: string | null;
  past: Flow[];
  future: Flow[];
  loadFlows: () => Promise<void>;
  openFlow: (id: string) => Promise<void>;
  newFlow: (from?: Pick<Flow, 'nodes' | 'edges' | 'name'>) => Promise<void>;
  deleteFlow: (id: string) => Promise<void>;
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
  select: (id: string | null) => void;
  /** null — связь создана; строка — почему нельзя. */
  connect: (from: string, to: string, port: InputPort) => string | null;
  disconnect: (edgeId: string) => void;
  setViewport: (viewport: Flow['viewport']) => void;
  /** Копия выбранной ноды (с входящими рёбрами от нод, которые тоже копируются, — пока одна нода). */
  copySelected: () => string | null;
  /** Вставить ноды из текста буфера `sp-canvas:`; возвращает число вставленных. */
  pasteNodes: (text: string, at: { x: number; y: number }) => number;
  duplicateSelected: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastKey: { key: string; at: number } | null = null;

export const useCanvas = create<CanvasState>((set, get) => {
  const persist = (): void => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const flow = get().flow;
      if (flow === null) return;
      set({ save: 'saving' });
      void fetch(`/api/canvas/flows/${flow.id}`, { method: 'PUT', headers: HEADERS, body: JSON.stringify(flow) })
        .then((res) => json<Flow>(res))
        .then(() => {
          if (get().save === 'saving') set({ save: 'saved' });
          void get().loadFlows();
        })
        .catch((error: unknown) => set({ save: 'error', error: error instanceof Error ? error.message : 'Не сохранилось.' }));
    }, 600);
  };

  const pushHistory = (flow: Flow, key: string | null): void => {
    const now = Date.now();
    if (key !== null && lastKey !== null && lastKey.key === key && now - lastKey.at < COALESCE_MS) {
      lastKey = { key, at: now };
      return;
    }
    lastKey = key === null ? null : { key, at: now };
    set((s) => ({ past: [...s.past.slice(-(HISTORY_LIMIT - 1)), flow], future: [] }));
  };

  /** Копия ноды без результатов: запуски принадлежат исходной ноде. */
  const cloneNode = (node: CanvasNode, dx: number, dy: number): CanvasNode => ({ ...node, id: newId('n'), x: node.x + dx, y: node.y + dy, jobIds: [], selected: 0, mediaId: null });

  return {
    flows: [],
    flow: null,
    save: 'saved',
    selected: null,
    error: null,
    past: [],
    future: [],

    loadFlows: async () => {
      const flows = await json<FlowListItem[]>(await fetch('/api/canvas/flows'));
      set({ flows });
      if (get().flow === null && flows[0] !== undefined) await get().openFlow(flows[0].id);
    },
    openFlow: async (id) => {
      lastKey = null;
      set({ flow: await json<Flow>(await fetch(`/api/canvas/flows/${id}`)), selected: null, save: 'saved', past: [], future: [] });
    },
    newFlow: async (from) => {
      const created = await json<Flow>(await fetch('/api/canvas/flows', { method: 'POST', headers: HEADERS, body: JSON.stringify({ name: from?.name ?? '' }) }));
      lastKey = null;
      set({ flow: from === undefined ? created : { ...created, nodes: from.nodes, edges: from.edges }, selected: null, past: [], future: [] });
      if (from !== undefined) persist();
      await get().loadFlows();
    },
    deleteFlow: async (id) => {
      await json(await fetch(`/api/canvas/flows/${id}`, { method: 'DELETE', headers: HEADERS }));
      if (get().flow?.id === id) set({ flow: null, past: [], future: [] });
      await get().loadFlows();
    },

    update: (recipe, historyKey = null) => {
      const flow = get().flow;
      if (flow === null) return;
      if (historyKey !== false) pushHistory(flow, historyKey);
      set({ flow: recipe(flow), save: 'dirty' });
      persist();
    },
    undo: () => {
      const { flow, past } = get();
      const prev = past.at(-1);
      if (flow === null || prev === undefined) return;
      lastKey = null;
      // Вид холста не откатываем: отмена правит граф, а не то, куда смотрит владелец.
      set((s) => ({ flow: { ...prev, viewport: flow.viewport }, past: s.past.slice(0, -1), future: [...s.future, flow], save: 'dirty', selected: prev.nodes.some((n) => n.id === s.selected) ? s.selected : null }));
      persist();
    },
    redo: () => {
      const { flow, future } = get();
      const next = future.at(-1);
      if (flow === null || next === undefined) return;
      lastKey = null;
      set((s) => ({ flow: { ...next, viewport: flow.viewport }, future: s.future.slice(0, -1), past: [...s.past, flow], save: 'dirty' }));
      persist();
    },
    rename: (name) => get().update((f) => ({ ...f, name }), 'rename'),

    addNode: (type, x, y, kind = 'image') => {
      const node = blankNode(type, x, y, kind);
      get().update((f) => ({ ...f, nodes: [...f.nodes, node] }));
      set({ selected: node.id });
      return node.id;
    },
    patchNode: (id, patch, historyKey = null) => get().update((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }), historyKey),
    removeNode: (id) => {
      get().update((f) => ({ ...f, nodes: f.nodes.filter((n) => n.id !== id), edges: f.edges.filter((e) => e.from !== id && e.to !== id) }));
      if (get().selected === id) set({ selected: null });
    },
    select: (id) => set({ selected: id }),

    connect: (from, to, port) => {
      const flow = get().flow;
      if (flow === null) return 'Нет flow.';
      if (from === to) return 'Нода не соединяется сама с собой.';
      if (wouldCycle(flow, from, to)) return 'Так получится цикл.';
      // Во входы «Старт», «Финал» и «Видео» — одна связь; повторная заменяет прежнюю.
      const replace = (e: CanvasEdge): boolean => e.to === to && e.port === port && (port === 'start' || port === 'end' || port === 'video');
      if (flow.edges.some((e) => e.from === from && e.to === to && e.port === port)) return null;
      get().update((f) => ({ ...f, edges: [...f.edges.filter((e) => !replace(e)), { id: newId('e'), from, to, port }] }));
      return null;
    },
    disconnect: (edgeId) => get().update((f) => ({ ...f, edges: f.edges.filter((e) => e.id !== edgeId) })),
    setViewport: (viewport) => get().update((f) => ({ ...f, viewport }), false),

    copySelected: () => {
      const { flow, selected } = get();
      const node = flow?.nodes.find((n) => n.id === selected);
      if (node === undefined) return null;
      return `${CLIPBOARD_PREFIX}${JSON.stringify({ nodes: [node], edges: [] })}`;
    },
    pasteNodes: (text, at) => {
      if (!text.startsWith(CLIPBOARD_PREFIX)) return 0;
      try {
        const parsed = JSON.parse(text.slice(CLIPBOARD_PREFIX.length)) as { nodes?: unknown; edges?: unknown };
        const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).map((n) => CanvasNodeSchema.parse(n));
        const edges = (Array.isArray(parsed.edges) ? parsed.edges : []).map((e) => CanvasEdgeSchema.parse(e));
        if (nodes.length === 0) return 0;
        const minX = Math.min(...nodes.map((n) => n.x));
        const minY = Math.min(...nodes.map((n) => n.y));
        const ids = new Map<string, string>();
        const copies = nodes.map((n) => {
          const c = cloneNode(n, at.x - minX, at.y - minY);
          ids.set(n.id, c.id);
          return c;
        });
        const copiedEdges = edges.flatMap((e) => {
          const from = ids.get(e.from);
          const to = ids.get(e.to);
          return from === undefined || to === undefined ? [] : [{ ...e, id: newId('e'), from, to }];
        });
        get().update((f) => ({ ...f, nodes: [...f.nodes, ...copies], edges: [...f.edges, ...copiedEdges] }));
        set({ selected: copies[0]?.id ?? null });
        return copies.length;
      } catch {
        return 0;
      }
    },
    duplicateSelected: () => {
      const { flow, selected } = get();
      const node = flow?.nodes.find((n) => n.id === selected);
      if (node === undefined) return;
      const copy = cloneNode(node, 32, 32);
      get().update((f) => ({ ...f, nodes: [...f.nodes, copy] }));
      set({ selected: copy.id });
    },
  };
});
