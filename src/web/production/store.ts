import { create } from 'zustand';
import { z } from 'zod';
import { CreateRunSchema, DEMO_INPUT, type ProductionRun, type RunAction, type RunInput } from '../../core/production/model.ts';
const ACTIVE_KEY = 'sp-production-active';
function savedActive(): string | null { try { return sessionStorage.getItem(ACTIVE_KEY); } catch { return null; } }
function rememberActive(id: string | null): void { try { if (id === null) sessionStorage.removeItem(ACTIVE_KEY); else sessionStorage.setItem(ACTIVE_KEY, id); } catch { /* selection still works */ } }
const DRAFT_KEY = 'sp-production-draft';
const REQUEST_KEY = 'sp-production-create-request';
const DraftSchema = CreateRunSchema.extend({ title: z.string().max(100), script: z.string().max(12_000), direction: z.string().max(3000) });
function savedDraft(): RunInput {
  try { const raw = localStorage.getItem(DRAFT_KEY); if (raw) { const draft = DraftSchema.parse(JSON.parse(raw)); return draft.planningMode === 'codex' ? { ...draft, mode: 'photos', scenario: 'normal' } : draft; } } catch { /* use starter brief */ }
  return { ...DEMO_INPUT, mode: 'photos', planningMode: 'codex', scenario: 'normal' };
}
function createRequestId(): string {
  try { const old = localStorage.getItem(REQUEST_KEY); if (old) return old; } catch { /* memory fallback */ }
  const id = crypto.randomUUID();
  try { localStorage.setItem(REQUEST_KEY, id); } catch { /* memory fallback */ }
  return id;
}
let pendingRequest: string | null = null;
const mergeRuns = (current: ProductionRun[], incoming: ProductionRun[]): ProductionRun[] => {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) if ((byId.get(run.id)?.rev ?? -1) <= run.rev) byId.set(run.id, run);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};
const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };
type Command = RunAction extends infer A ? A extends RunAction ? Omit<A, 'rev'> : never : never;
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const value = await response.json() as T & { messageRu?: string };
  if (!response.ok) throw new Error(value.messageRu ?? 'Не удалось открыть серию.');
  return value;
}
interface State {
  draft: RunInput; setDraft: (input: RunInput) => void; connectionError: string | null; warnings: string[];
  runs: ProductionRun[]; run: ProductionRun | null; activeId: string | null; initialized: boolean; busy: boolean; error: string | null;
  load: () => Promise<void>; refresh: () => Promise<void>; select: (id: string) => void; newForm: () => void;
  create: (input: RunInput) => Promise<void>; act: (action: Command) => Promise<boolean>;
  photoCommand: (endpoint: 'photos/start' | 'photos/retry' | 'fork-photos' | 'review', body: object) => Promise<boolean>;
  setCharacter: (characterId: string | null) => Promise<boolean>;
}
export const useProduction = create<State>((set, get) => ({
  draft: savedDraft(), connectionError: null, warnings: [],
  setDraft: (draft) => { set({ draft }); try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* in-memory draft */ } },
  runs: [], run: null, activeId: savedActive(), initialized: false, busy: false, error: null,
  load: async () => {
    try {
      const incoming = await request<ProductionRun[]>('/api/production');
      const runs = mergeRuns(get().runs, incoming);
      const activeId = get().initialized ? get().activeId : runs.find((r) => r.id === get().activeId)?.id ?? runs[0]?.id ?? null;
      set({ runs, initialized: true, activeId, run: runs.find((r) => r.id === activeId) ?? null, connectionError: null });
      void request<string[]>('/api/production/issues').then((warnings) => set({ warnings })).catch(() => undefined);
    } catch (error) { set({ initialized: true, connectionError: String(error) }); }
  },
  refresh: async () => {
    const id = get().activeId;
    if (id === null || get().busy) return;
    try {
      const run = await request<ProductionRun>(`/api/production/${id}`);
      if (get().activeId !== id || (get().run?.rev ?? -1) > run.rev) return;
      set({ run, runs: mergeRuns(get().runs, [run]), connectionError: null });
    } catch (error) { if (get().activeId === id) set({ connectionError: String(error) }); }
  },
  select: (activeId) => { rememberActive(activeId); set({ activeId, run: get().runs.find((r) => r.id === activeId) ?? null, error: null }); void get().refresh(); },
  newForm: () => {
    const requestId = pendingRequest ?? (() => { try { return localStorage.getItem(REQUEST_KEY); } catch { return null; } })();
    if (requestId && get().runs.some((run) => run.requestId === requestId)) { pendingRequest = null; try { localStorage.removeItem(REQUEST_KEY); } catch { /* storage unavailable */ } }
    rememberActive(null); set({ activeId: null, run: null, initialized: true, error: null }); },
  create: async (input) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    pendingRequest ??= createRequestId();
    try {
      const run = await request<ProductionRun>('/api/production', { ...input, requestId: pendingRequest });
      rememberActive(run.id);
      set({ run, activeId: run.id, initialized: true, runs: mergeRuns(get().runs, [run]) });
      pendingRequest = null;
      try { localStorage.removeItem(REQUEST_KEY); } catch { /* memory fallback */ }
    }
    catch (error) { set({ error: String(error) }); }
    finally { set({ busy: false }); }
  },
  act: async (action) => {
    const run = get().run;
    if (run === null || get().busy) return false;
    set({ busy: true, error: null });
    try {
      // Refresh the run revision, but keep the exact artifact IDs the owner selected.
      // No mutation is automatically retried; the server still rejects stale inputs.
      const latest = await request<ProductionRun>(`/api/production/${run.id}`);
      const next = await request<ProductionRun>(`/api/production/${run.id}/actions`, { ...action, rev: latest.rev });
      set({ runs: get().runs.map((r) => r.id === next.id ? next : r), ...(get().activeId === next.id ? { run: next } : {}) });
      return true;
    } catch (error) {
      set({ error: String(error), busy: false }); await get().refresh(); return false;
    } finally { set({ busy: false }); }
  },
  photoCommand: async (endpoint, body) => {
    const run = get().run;
    if (!run || get().busy) return false;
    set({ busy: true, error: null });
    try {
      const next = await request<ProductionRun>(`/api/production/${run.id}/${endpoint}`, body);
      set({ runs: mergeRuns(get().runs, [next]), ...(get().activeId === run.id ? { run: next, activeId: next.id } : {}) });
      if (get().activeId === next.id) rememberActive(next.id);
      return true;
    } catch (error) { set({ error: String(error) }); return false; }
    finally { set({ busy: false }); await get().refresh(); }
  },
  setCharacter: async (characterId) => {
    const run = get().run;
    if (!run || get().busy) return false;
    set({ busy: true, error: null });
    try {
      const latest = await request<ProductionRun>(`/api/production/${run.id}`);
      const next = await request<ProductionRun>(`/api/production/${run.id}/character`, { rev: latest.rev, characterId });
      set({ runs: get().runs.map((r) => r.id === next.id ? next : r), ...(get().activeId === next.id ? { run: next } : {}) });
      return true;
    } catch (error) { set({ error: String(error) }); return false; }
    finally { set({ busy: false }); }
  },
}));
