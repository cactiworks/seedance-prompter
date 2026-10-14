import { afterEach, expect, it, vi } from 'vitest';
import { advanceRun, newRun } from '../../src/core/production/engine.ts';
import { DEMO_INPUT } from '../../src/core/production/model.ts';
import { useProduction } from '../../src/web/production/store.ts';

afterEach(() => { vi.unstubAllGlobals(); });
function setup() {
  const run = advanceRun(newRun('pr-client-123', DEMO_INPUT, 0, 1), 10, 1);
  useProduction.setState({ run, activeId: run.id, runs: [run], initialized: true, busy: false, error: null });
  return run;
}
it('refreshes run revision before approval while preserving the selected artifact IDs', async () => {
  const run = setup(); const latest = { ...run, rev: run.rev + 2 };
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(latest)).mockResolvedValueOnce(Response.json({ ...latest, rev: latest.rev + 1 }));
  vi.stubGlobal('fetch', fetch);
  expect(await useProduction.getState().act({ type: 'approvePhotos', ids: ['shot-1-photo-v1'] })).toBe(true);
  const init = fetch.mock.calls[1]?.[1] as RequestInit;
  expect(JSON.parse(init.body as string)).toEqual({ type: 'approvePhotos', ids: ['shot-1-photo-v1'], rev: latest.rev });
  expect(useProduction.getState().busy).toBe(false);
});
it('does not replay a mutation after conflict and keeps the error visible', async () => {
  const run = setup();
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(run)).mockResolvedValueOnce(Response.json({ messageRu: 'Конфликт версий' }, { status: 409 })).mockResolvedValueOnce(Response.json({ ...run, rev: run.rev + 1 }));
  vi.stubGlobal('fetch', fetch);
  expect(await useProduction.getState().act({ type: 'approvePhotos', ids: ['shot-1-photo-v1'] })).toBe(false);
  expect(fetch.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
  expect(useProduction.getState().error).toContain('Конфликт версий');
  expect(useProduction.getState().run?.rev).toBe(run.rev + 1);
});
