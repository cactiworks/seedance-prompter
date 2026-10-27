import { studioFetch as fetch } from '../remoteFetch.ts';
import { create } from 'zustand';
import { modelsOf, paramsFor, type MediaKind } from '../../core/gen/models.ts';
import { CanvasEdgeSchema, CanvasNodeSchema, FlowSchema, portAccepts, inputsOf, dropStaleEdges, outputOf, type CanvasEdge, type CanvasNode, type CanvasNodeType, type Flow, type InputPort } from '../../core/model/canvas.ts';
import { wouldCycle } from '../../core/canvas/plan.ts';
import { inputFingerprint, invalidateChanged } from '../../core/canvas/freshness.ts';
import { cloneSeedance } from '../../core/canvas/seedance.ts';

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
  production?: Flow['production'];
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

let seq = 0;
export const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1).toString(36)}`;

/** Ширина нод — фиксированная: по ней считаются координаты портов для рёбер. */
export const NODE_WIDTH: Record<CanvasNodeType, number> = { prompt: 260, image: 260, generator: 300, frame: 240, trim: 280, video: 260, resize: 260, seedance: 300, upscale: 280 };
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

interface CanvasState {
  flows: FlowListItem[];
  flow: Flow | null;
  save: SaveState;
  /** Последняя выбранная нода — к ней относятся одиночные действия. */
  selected: string | null;
  /** Все выделенные ноды: Shift+клик, рамка Shift+протяжкой, ⌘A. Группа двигается, удаляется и копируется вместе. */
  selection: string[];
  error: string | null;
  past: Flow[];
  future: Flow[];
  loadFlows: () => Promise<void>;
  openFlow: (id: string, reload?: boolean) => Promise<boolean>;
  newFlow: (from?: Pick<Flow, 'nodes' | 'edges' | 'name'>) => Promise<void>;
  deleteFlow: (id: string) => Promise<void>;
  restoreFlow: (id: string) => Promise<void>;
  saveCopy: () => Promise<void>;
  flush: () => Promise<boolean>;
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
  /**
   * «В canvas» из просмотра работы: файл библиотеки — новой нодой (картинка или видео) правее всего графа в
   * открытом flow; flow нет — создаётся. Вид сдвигается к новой ноде.
   */
  sendMedia: (item: { id: string; kind: 'image' | 'video'; label: string }) => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastKey: { key: string; at: number } | null = null;

export const useCanvas = create<CanvasState>((set, get) => {
  let pending: Flow | null = null;
  let writing: Promise<boolean> | null = null;
  let navigation = 0;
  const revisions = new Map<string, number>();
  const draftKey = (id: string): string => `sp-canvas-draft:${id}`;
  const remember = (flow: Flow): void => { try { localStorage.setItem(draftKey(flow.id), JSON.stringify(flow)); } catch { /* in-memory draft remains */ } };
  const flush = async (): Promise<boolean> => {
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    if (writing !== null) return writing;
    writing = (async () => {
      while (pending !== null) {
        const snapshot = pending;
        const outgoing = { ...snapshot, rev: revisions.get(snapshot.id) ?? snapshot.rev ?? 0 };
        remember(outgoing);
        if (get().flow?.id === snapshot.id) set({ save: 'saving' });
        try {
          const saved = await json<Flow>(await fetch(`/api/canvas/flows/${snapshot.id}`, { method: 'PUT', headers: HEADERS, body: JSON.stringify(outgoing), keepalive: true }));
          revisions.set(snapshot.id, saved.rev ?? outgoing.rev + 1);
          set((state) => ({ flows: state.flows.map((item) => item.id === saved.id ? { id: saved.id, name: saved.name, nodes: saved.nodes.length, updatedAt: saved.updatedAt, production: saved.production } : item) }));
          if (pending === snapshot) {
            pending = null;
            try { localStorage.removeItem(draftKey(snapshot.id)); } catch { /* storage unavailable */ }
            if (get().flow?.id === snapshot.id) set((state) => ({ flow: state.flow === null ? null : { ...state.flow, rev: saved.rev }, save: 'saved', error: null }));
          } else if (pending !== null) remember({ ...pending, rev: saved.rev });
        } catch (error) {
          if (get().flow?.id === snapshot.id) set({ save: 'error', error: error instanceof Error ? error.message : 'Не сохранилось. Черновик сохранён в этом браузере.' });
          return false;
        }
      }
      return true;
    })();
    try { return await writing; } finally { writing = null; }
  };
  const persist = (): void => {
    const snapshot = get().flow;
    if (snapshot === null) return;
    pending = snapshot;
    remember(snapshot);
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, 600);
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

  /** Копия ноды без результатов: запуски принадлежат исходной ноде. Seedance-промптер получит копию черновика при открытии. */
  const cloneNode = (node: CanvasNode, dx: number, dy: number): CanvasNode => ({ ...node, production: undefined, id: newId('n'), x: node.x + dx, y: node.y + dy, jobIds: [], selected: 0, mediaId: node.type === 'video' ? node.mediaId : null, stale: false, runInputFingerprint: undefined, ...cloneSeedance(node) });

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
    error: null,
    past: [],
    future: [],

    loadFlows: async () => {
      try {
        const flows = await json<FlowListItem[]>(await fetch('/api/canvas/flows'));
        set({ flows });
        if (get().flow === null && flows[0] !== undefined) await get().openFlow(flows[0].id);
      } catch (error) { set({ error: String(error) }); }
    },
    flush,
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
      if (!await flush()) return false;
      if (get().flow?.id === id && !reload) return true;
      let saved: Flow;
      try { saved = FlowSchema.parse(await json<Flow>(await fetch(`/api/canvas/flows/${id}`))); }
      catch (error) { if (request === navigation) set({ error: error instanceof Error ? error.message : 'Не удалось открыть холст.' }); return false; }
      if (request !== navigation || !await flush() || request !== navigation) return false;
      // A forced refresh may race with typing into this same flow. Its newer
      // acknowledged save is authoritative over the snapshot fetched earlier.
      const current = get().flow;
      if (current?.id === id && (current.rev ?? 0) > (saved.rev ?? 0)) saved = current;
      revisions.set(id, saved.rev ?? 0);
      let flow = saved;
      try {
        const raw = localStorage.getItem(draftKey(id));
        if (raw !== null) flow = FlowSchema.parse(JSON.parse(raw));
      } catch { /* invalid browser draft must not hide the server copy */ }
      lastKey = null;
      const restored = flow !== saved;
      const conflict = restored && (flow.rev ?? 0) !== (saved.rev ?? 0);
      if (conflict) revisions.set(id, flow.rev ?? 0);
      set({ flow, selected: null, selection: [], save: restored ? 'dirty' : 'saved', past: [], future: [], error: conflict ? 'Есть локальный черновик и другая версия на сервере. Сохрани схему или создай копию, чтобы не потерять правки.' : null });
      if (restored) { pending = flow; if (!conflict) persist(); }
      return true;
    },
    saveCopy: async () => {
      let draft = get().flow;
      if (draft === null) return;
      if (writing !== null) await writing;
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
      try {
        const created = await json<Flow>(await fetch('/api/canvas/flows', { method: 'POST', headers: HEADERS, body: JSON.stringify({ name: `${draft.name} — копия` }) }));
        if (get().flow?.id === draft.id) draft = get().flow!;
        // Recovery copies own their drafts; reusing slugs would edit the original
        // Prompter from a different flow. Saved media/jobs remain as history.
        const ids = new Map(draft.nodes.map(node => [node.id, newId('n')]));
        const nodes = draft.nodes.map(node => ({ ...node, id:ids.get(node.id)!, production:undefined, ...cloneSeedance(node) }));
        const edges = draft.edges.map(edge => ({ ...edge, id:newId('e'), from:ids.get(edge.from)!, to:ids.get(edge.to)! }));
        // The original browser draft is retained until the new copy is confirmed on disk.
        navigation += 1;
        revisions.set(created.id, created.rev ?? 0);
        set({ flow: { ...created, nodes, edges, viewport: draft.viewport }, save: 'dirty', error: null, past: [], future: [] });
        persist();
        if (await flush()) { try { localStorage.removeItem(draftKey(draft.id)); } catch { /* storage unavailable */ } }
        await get().loadFlows();
      } catch (error) { set({ error: String(error), save: 'error' }); }
    },
    newFlow: async (from) => {
      const request = ++navigation;
      if (!await flush()) return;
      const created = await json<Flow>(await fetch('/api/canvas/flows', { method: 'POST', headers: HEADERS, body: JSON.stringify({ name: from?.name ?? '' }) }));
      if (request !== navigation || !await flush() || request !== navigation) { await get().loadFlows(); return; }
      lastKey = null;
      set({ flow: from === undefined ? created : { ...created, nodes: from.nodes, edges: from.edges }, selected: null, selection: [], past: [], future: [] });
      if (from !== undefined) persist();
      await get().loadFlows();
    },
    deleteFlow: async (id) => {
      if (!await flush()) return;
      await json(await fetch(`/api/canvas/flows/${id}`, { method: 'DELETE', headers: HEADERS }));
      if (get().flow?.id === id) set({ flow: null, past: [], future: [] });
      await get().loadFlows();
    },

    restoreFlow: async (id) => {
      await json(await fetch(`/api/canvas/flows/${id}/restore`, { method: 'POST', headers: HEADERS }));
      await get().openFlow(id);
      await get().loadFlows();
    },
    update: (recipe, historyKey = null) => {
      const flow = get().flow;
      if (flow === null) return;
      if (historyKey !== false) pushHistory(flow, historyKey);
      set({ flow: invalidateChanged(flow, recipe(flow)), save: 'dirty' });
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
      const replace = (e: CanvasEdge): boolean => e.to === to && e.port === port && (port === 'start' || port === 'end' || port === 'video' || port === 'media');
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
