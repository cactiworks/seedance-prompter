import { create } from 'zustand';
import type { ProductionRun, RunAction, RunInput } from '../../core/production/model.ts';
const ACTIVE_KEY = 'sp-production-active';
function savedActive(): string | null { try { return sessionStorage.getItem(ACTIVE_KEY); } catch { return null; } }
function rememberActive(id: string | null): void { try { if (id === null) sessionStorage.removeItem(ACTIVE_KEY); else sessionStorage.setItem(ACTIVE_KEY, id); } catch { /* selection still works */ } }
const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };
type Command = RunAction extends infer A ? A extends RunAction ? Omit<A, 'rev'> : never : never;
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const value = await response.json() as T & { messageRu?: string };
  if (!response.ok) throw new Error(value.messageRu ?? 'Не удалось открыть серию.');
  return value;
}
interface State {
  runs: ProductionRun[]; run: ProductionRun | null; activeId: string | null; initialized: boolean; busy: boolean; error: string | null;
  load: () => Promise<void>; refresh: () => Promise<void>; select: (id: string) => void; newForm: () => void;
  create: (input: RunInput) => Promise<void>; act: (action: Command) => Promise<boolean>;
  setCharacter: (characterId: string | null) => Promise<boolean>;
}
export const useProduction = create<State>((set, get) => ({
  runs: [], run: null, activeId: savedActive(), initialized: false, busy: false, error: null,
  load: async () => {
    try {
      const runs = await request<ProductionRun[]>('/api/production');
      const activeId = get().initialized ? get().activeId : runs.find((r) => r.id === get().activeId)?.id ?? runs[0]?.id ?? null;
      set({ runs, initialized: true, activeId, run: runs.find((r) => r.id === activeId) ?? null, error: null });
    } catch (error) { set({ initialized: true, error: String(error) }); }
  },
  refresh: async () => {
    const id = get().activeId;
    if (id === null || get().busy) return;
    try {
      const run = await request<ProductionRun>(`/api/production/${id}`);
      if (get().activeId !== id || (get().run?.rev ?? -1) > run.rev) return;
      set({ run, runs: get().runs.map((r) => r.id === id ? run : r) });
    } catch (error) { if (get().activeId === id) set({ error: String(error) }); }
  },
  select: (activeId) => { rememberActive(activeId); set({ activeId, run: get().runs.find((r) => r.id === activeId) ?? null, error: null }); void get().refresh(); },
  newForm: () => { rememberActive(null); set({ activeId: null, run: null, initialized: true, error: null }); },
  create: async (input) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try { const run = await request<ProductionRun>('/api/production', input); rememberActive(run.id); set({ run, activeId: run.id, initialized: true, runs: [run, ...get().runs] }); }
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
