import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { newRun } from '../../src/core/production/engine.ts';
import { DEMO_INPUT } from '../../src/core/production/model.ts';

let storage: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); storage = new Map();
  const api = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) };
  vi.stubGlobal('localStorage', api); vi.stubGlobal('sessionStorage', api);
});
afterEach(() => vi.unstubAllGlobals());
const run = (id: string) => newRun(id, DEMO_INPUT, Date.now(), 1);
it('B16/B21: a late list cannot erase a newly created run; other series refresh by revision', async () => {
  const { useProduction } = await import('../../src/web/production/store.ts');
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/issues') ? Promise.resolve(Response.json([])) : new Promise<Response>((resolve) => { finish = resolve; })));
  const loading = useProduction.getState().load();
  const fresh = run('pr-new-abcdef');
  useProduction.setState({ runs: [fresh], run: fresh, activeId: fresh.id, initialized: true });
  finish(Response.json([])); await loading;
  expect(useProduction.getState().runs.map((r) => r.id)).toEqual([fresh.id]);
  const updated = { ...fresh, rev: fresh.rev + 1, paused: true };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/issues') ? [] : [updated])));
  await useProduction.getState().load();
  expect(useProduction.getState().runs[0]?.paused).toBe(true);
});
it('B17: an incomplete draft survives module reload with empty fields and its selected mode', async () => {
  const { useProduction } = await import('../../src/web/production/store.ts');
  const draft = { ...DEMO_INPUT, title: '', script: 'Unfinished draft', direction: '', planningMode: 'mock' as const };
  useProduction.getState().setDraft(draft); useProduction.getState().newForm();
  vi.resetModules();
  const reloaded = await import('../../src/web/production/store.ts');
  expect(reloaded.useProduction.getState().draft).toEqual(draft);
});
it('B18: successful polling clears connection errors while retaining mutation errors', async () => {
  const { useProduction } = await import('../../src/web/production/store.ts');
  const current = run('pr-one-abcdef');
  useProduction.setState({ runs: [current], run: current, activeId: current.id, error: 'Keep this action error' });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  await useProduction.getState().refresh(); expect(useProduction.getState().connectionError).toContain('offline');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)));
  await useProduction.getState().refresh();
  expect(useProduction.getState().connectionError).toBeNull(); expect(useProduction.getState().error).toBe('Keep this action error');
});
it('B06: retry after a lost create response uses the same request ID', async () => {
  const { useProduction } = await import('../../src/web/production/store.ts');
  const ids: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    ids.push((JSON.parse(init.body as string) as { requestId: string }).requestId);
    if (ids.length === 1) throw new Error('response lost');
    return Response.json(run('pr-one-abcdef'));
  }));
  await useProduction.getState().create(DEMO_INPUT); await useProduction.getState().create(DEMO_INPUT);
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  expect(storage.has('sp-production-create-request')).toBe(false);
});
