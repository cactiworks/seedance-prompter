import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlowSchema, type Flow } from '../../src/core/model/canvas.ts';
import { mergeCanvasFlow } from '../../src/core/canvas/merge.ts';
import type * as CanvasModule from '../../src/web/canvas/canvasStore.ts';

let useCanvas: typeof CanvasModule.useCanvas;
let blankNode: typeof CanvasModule.blankNode;
let flows: Map<string, Flow>;
let writes: Flow[];
let storage: Map<string, string>;
let archived: Flow[];
const mk = (id: string): Flow => FlowSchema.parse({ id, name: id, rev: 1, nodes: [], edges: [], createdAt: '', updatedAt: '' });
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  flows = new Map(['f-alpha-123', 'f-other-123'].map(id => [id, mk(id)])); writes = []; archived = [];
  storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null, getItem: (key: string) => storage.get(key) ?? null, setItem: vi.fn((key: string, value: string) => storage.set(key, value)), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const id = url.split('/').at(-1)!;
    if (url === '/api/canvas/legacy-drafts') {
      const { flow } = JSON.parse(String(init?.body)) as { flow: Flow };
      archived.push(flow);
      return Response.json({ archived: true, flow: flows.get(flow.id) ?? null });
    }
    if (url === '/api/canvas/flows' && init?.method === 'POST') {
      const created = { ...mk('f-created-123'), name: JSON.parse(init.body as string).name };
      flows.set(created.id, created); return Response.json(created);
    }
    if (init?.method === 'PATCH') {
      const incoming = JSON.parse(init.body as string) as { base: Flow; flow: Flow };
      const current = flows.get(id)!;
      const merged = mergeCanvasFlow(incoming.base, incoming.flow, current);
      if (JSON.stringify(merged) === JSON.stringify(current)) return Response.json(current);
      const saved = { ...merged, rev: (current.rev ?? 0) + 1 }; flows.set(id, saved); writes.push(saved); return Response.json(saved);
    }
    return Response.json(url === '/api/canvas/flows' ? [...flows.values()] : flows.get(id));
  }));
  ({ useCanvas, blankNode } = await import('../../src/web/canvas/canvasStore.ts'));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('switching immediately after typing saves the captured old flow, and saved means the server confirmed it', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const id = useCanvas.getState().addNode('prompt', 0, 0);
  useCanvas.getState().patchNode(id, { text: 'Last keystroke' });
  await useCanvas.getState().openFlow('f-other-123');
  expect(writes.map(flow => flow.id)).toEqual(['f-alpha-123']);
  await useCanvas.getState().openFlow('f-alpha-123');
  expect(useCanvas.getState().flow?.nodes[0]?.text).toBe('Last keystroke');
  expect(useCanvas.getState().save).toBe('saved');
  expect(localStorage.setItem).not.toHaveBeenCalled();
});

it('a late processing result cannot attach after its inputs or target flow changed', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const id = useCanvas.getState().addNode('resize', 0, 0);
  const finish = useCanvas.getState().captureResult(id);
  useCanvas.getState().patchNode(id, { width: 720 });
  expect(finish({ mediaId: 'm-obsolete' })).toBe(false);
  const second = useCanvas.getState().captureResult(id);
  await useCanvas.getState().openFlow('f-other-123');
  expect(second({ mediaId: 'm-wrong-flow' })).toBe(false);
  expect(flows.get('f-alpha-123')?.nodes[0]?.mediaId).toBeNull();
});

it('duplicate and clipboard keep source videos but not generated outputs', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const video = { ...blankNode('video', 0, 0), mediaId: 'm-source-video' };
  useCanvas.getState().update(flow => ({ ...flow, nodes: [video] }));
  useCanvas.getState().select(video.id);
  const text = useCanvas.getState().copySelected()!;
  useCanvas.getState().duplicateSelected();
  expect(useCanvas.getState().pasteNodes(text, { x: 500, y: 0 })).toBe(1);
  expect(useCanvas.getState().flow?.nodes.map(node => node.mediaId)).toEqual(['m-source-video', 'm-source-video', 'm-source-video']);
});

it('a keystroke during a save is rebased onto its server acknowledgement', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (first && init?.method === 'PATCH') { first = false; entered(); await gate; }
    return realFetch(url, init);
  }));
  useCanvas.getState().rename('First edit');
  const saving = useCanvas.getState().flush(); await started;
  useCanvas.getState().rename('Second edit'); release();
  expect(await saving).toBe(true);
  expect(writes.map(flow => [flow.name, flow.rev])).toEqual([['First edit', 2], ['Second edit', 3]]);
  expect(useCanvas.getState().save).toBe('saved');
});

it('invalid clipboard graphs are rejected before entering the open flow', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const node = blankNode('prompt', 0, 0);
  expect(useCanvas.getState().pasteNodes(`sp-canvas:${JSON.stringify({ nodes: [node, node], edges: [] })}`, { x: 0, y: 0 })).toBe(0);
  expect(useCanvas.getState().flow?.nodes).toHaveLength(0);
});

it('edits made while the next flow loads are saved without replacing that view', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('f-other-123') && !init?.method) { entered(); await gate; }
    return realFetch(url, init);
  }));
  const opening = useCanvas.getState().openFlow('f-other-123'); await started;
  useCanvas.getState().rename('Typed during navigation'); release(); await opening;
  expect(flows.get('f-alpha-123')?.name).toBe('Typed during navigation');
  expect(useCanvas.getState().flow?.id).toBe('f-other-123');
});

it('refresh loads new server branches and keeps the acknowledged title', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  canvas.rename('My manual title'); await canvas.flush();
  const saved = flows.get('f-alpha-123')!;
  flows.set(saved.id, { ...saved, rev: saved.rev! + 1, nodes: [blankNode('image', 80, 80)] });
  await canvas.openFlow(saved.id, true);
  expect(useCanvas.getState().flow?.nodes).toHaveLength(1);
  expect(useCanvas.getState().flow?.name).toBe('My manual title');
  canvas.rename('After handoff'); expect(await canvas.flush()).toBe(true);
});

it('refresh cannot replace edits made while its snapshot loads', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const result = await realFetch(url, init);
    if (url.endsWith('f-alpha-123') && !init?.method) { entered(); await gate; }
    return result;
  }));
  const opening = canvas.openFlow('f-alpha-123', true); await started;
  canvas.rename('Typed while refreshing'); release(); await opening;
  expect(useCanvas.getState().flow?.name).toBe('Typed while refreshing');
  expect(flows.get('f-alpha-123')?.name).toBe('Typed while refreshing');
});

it('server AI updates do not conflict with a title or viewport save', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  canvas.rename('Local title'); canvas.setViewport({ x: 80, y: 10, zoom: 1 });
  const remoteNode = blankNode('prompt', 0, 0);
  flows.set('f-alpha-123', { ...flows.get('f-alpha-123')!, rev: 7, nodes: [remoteNode] });
  expect(await canvas.flush()).toBe(true);
  expect(useCanvas.getState().flow).toMatchObject({ name: 'Local title', rev: 8, viewport: { x: 80 }, nodes: [{ id: remoteNode.id }] });
});

it.each(['before a save starts', 'while its acknowledgement is pending'])('submits edits for recovery after a poll drops their node %s', async timing => {
  const canvas = useCanvas.getState();
  const node = blankNode('comment', 0, 0);
  const base = { ...flows.get('f-alpha-123')!, nodes: [node] };
  flows.set(base.id, base);
  await canvas.openFlow(base.id);
  const realFetch = globalThis.fetch;
  const candidates: Flow[] = [];
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return realFetch(url, init);
    const { flow } = JSON.parse(String(init.body)) as { flow: Flow };
    candidates.push(flow);
    if (timing === 'while its acknowledgement is pending' && candidates.length === 1) { entered(); await gate; }
    return realFetch(url, init);
  }));
  let saving: Promise<boolean> | undefined;
  if (timing === 'while its acknowledgement is pending') {
    canvas.rename('First edit');
    saving = canvas.flush();
    await started;
  }
  canvas.patchNode(node.id, { text: 'Unsaved text' });
  const remote = { ...base, rev: 2, nodes: [] };
  flows.set(base.id, remote);
  canvas.applyServerFlow(remote, base);
  release();
  expect(await (saving ?? canvas.flush())).toBe(true);
  expect(candidates.at(-1)?.nodes[0]?.text).toBe('Unsaved text');
  expect(useCanvas.getState().flow?.nodes).toEqual([]);
});

it('submits the valid pre-poll graph and converges after its conflict is archived', async () => {
  const canvas = useCanvas.getState();
  const first = blankNode('resize', 0, 0);
  const second = blankNode('resize', 100, 0);
  const base = { ...flows.get('f-alpha-123')!, nodes: [first, second] };
  flows.set(base.id, base);
  await canvas.openFlow(base.id);
  expect(canvas.connect(first.id, second.id, 'media')).toBeNull();
  const remote: Flow = { ...base, rev: 2, edges: [{ id: 'remote', from: second.id, to: first.id, port: 'media' }] };
  flows.set(base.id, remote);
  canvas.applyServerFlow(remote, base);
  const realFetch = globalThis.fetch;
  const candidates: Flow[] = [];
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return realFetch(url, init);
    const { flow } = JSON.parse(String(init.body)) as { flow: Flow };
    candidates.push(FlowSchema.parse(flow));
    if (candidates.length > 1) return realFetch(url, init);
    entered(); await gate;
    return Response.json({ error: 'CONFLICT', messageRu: 'Правки сохранены в истории холста.', current: remote, historyId: 'recovery-test' }, { status: 409 });
  }));
  const saving = canvas.flush();
  await started;
  canvas.rename('Typed during response');
  release();
  expect(await saving).toBe(true);
  expect(candidates).toHaveLength(2);
  expect(candidates[0]?.edges).toMatchObject([{ from: first.id, to: second.id }]);
  expect(useCanvas.getState()).toMatchObject({ flow: { name: 'Typed during response', edges: remote.edges }, save: 'saved', error: 'Правки сохранены в истории холста.' });
  expect(await canvas.flush()).toBe(true);
  expect(candidates).toHaveLength(2);
});

it('offline edits remain in per-flow memory and another flow can save independently', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => url.endsWith('f-alpha-123') && init?.method === 'PATCH' ? Response.json({ messageRu: 'offline' }, { status: 503 }) : realFetch(url, init)));
  canvas.rename('Queued on first');
  expect(await canvas.openFlow('f-other-123')).toBe(true);
  canvas.rename('Saved on second'); expect(await canvas.flush()).toBe(true);
  expect(flows.get('f-other-123')?.name).toBe('Saved on second');
  expect(useCanvas.getState().save).toBe('saved');
  expect(await canvas.openFlow('f-alpha-123')).toBe(true);
  expect(useCanvas.getState()).toMatchObject({ flow: { name: 'Queued on first' }, save: 'error' });
  expect(localStorage.setItem).not.toHaveBeenCalled();
  vi.stubGlobal('fetch', realFetch);
  expect(await canvas.flush()).toBe(true);
  expect(flows.get('f-alpha-123')?.name).toBe('Queued on first');
});

it('failed destination loading leaves the source queue available for retry', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123'); canvas.rename('Keep this edit');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init?.method === 'PATCH' || url.endsWith('f-other-123') ? Response.json({ messageRu: 'offline' }, { status: 503 }) : realFetch(url, init)));
  expect(await canvas.openFlow('f-other-123')).toBe(false);
  expect(useCanvas.getState().flow?.name).toBe('Keep this edit');
  vi.stubGlobal('fetch', realFetch); expect(await canvas.flush()).toBe(true);
});

it('ordinary saves do not use keepalive, which rejects large browser payloads', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  canvas.update(flow => ({ ...flow, nodes: [{ ...blankNode('prompt', 0, 0), text: 'x'.repeat(70000) }] }));
  expect(await canvas.flush()).toBe(true);
  const patch = vi.mocked(globalThis.fetch).mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(patch?.[1]?.keepalive).not.toBe(true);
});

it('a lost ACK is retried idempotently without creating another flow', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const realFetch = globalThis.fetch; let lost = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const result = await realFetch(url, init);
    if (!lost && init?.method === 'PATCH') { lost = true; throw new TypeError('Lost response'); }
    return result;
  }));
  canvas.rename('Already saved'); expect(await canvas.flush()).toBe(false);
  expect(await canvas.flush()).toBe(true);
  expect(useCanvas.getState()).toMatchObject({ flow: { name: 'Already saved', rev: 2 }, save: 'saved', error: null });
  expect(flows.size).toBe(2); expect(writes).toHaveLength(1);
});

it('creating a flow keeps failed edits queued without carrying its error into the new flow', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => url.endsWith('f-alpha-123') && init?.method === 'PATCH' ? Response.json({ messageRu: 'offline' }, { status: 503 }) : realFetch(url, init)));
  canvas.rename('Queued edit'); await canvas.newFlow({ name: 'New flow', nodes: [], edges: [] });
  expect(useCanvas.getState()).toMatchObject({ flow: { id: 'f-created-123', name: 'New flow' }, error: null, save: 'dirty' });
  vi.stubGlobal('fetch', realFetch); expect(await canvas.flush()).toBe(true);
  expect(flows.get('f-alpha-123')?.name).toBe('Queued edit');
});

it('network failures retry automatically and stop after bounded backoff', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  canvas.rename('Retry me'); expect(await canvas.flush()).toBe(false);
  await vi.advanceTimersByTimeAsync(100000);
  expect(fetch).toHaveBeenCalledTimes(5);
  vi.stubGlobal('fetch', realFetch);
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(flows.get('f-alpha-123')?.name).toBe('Retry me');
  expect(useCanvas.getState().save).toBe('saved');
});

it('invalid merge conflicts require an explicit retry instead of repeating automatically', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'CONFLICT', messageRu: 'Невозможно объединить связи' }, { status: 409 })));
  canvas.rename('Conflicting graph'); expect(await canvas.flush()).toBe(false);
  await vi.advanceTimersByTimeAsync(100000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(useCanvas.getState().save).toBe('error');
});

it('legacy drafts are archived once on the VPS before their browser keys are removed', async () => {
  const legacy = { ...mk('f-alpha-123'), rev: 0, name: 'Old local draft' };
  storage.set('sp-canvas-draft:f-alpha-123', JSON.stringify(legacy));
  storage.set('sp-theme', 'dark');
  await useCanvas.getState().loadFlows();
  expect(archived).toEqual([legacy]);
  expect(storage.has('sp-canvas-draft:f-alpha-123')).toBe(false);
  expect(storage.get('sp-theme')).toBe('dark');
  expect(useCanvas.getState().flow?.name).toBe('f-alpha-123');
  await useCanvas.getState().loadFlows();
  expect(archived).toHaveLength(1);
  expect(localStorage.setItem).not.toHaveBeenCalled();
});

it('a failed legacy archive keeps the old key and retries on the next load', async () => {
  const key = 'sp-canvas-draft:f-alpha-123'; storage.set(key, JSON.stringify(mk('f-alpha-123')));
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => url === '/api/canvas/legacy-drafts' ? Response.json({ error: 'offline' }, { status: 503 }) : realFetch(url, init)));
  await useCanvas.getState().loadFlows(); expect(storage.has(key)).toBe(true);
  vi.stubGlobal('fetch', realFetch);
  await useCanvas.getState().loadFlows(); expect(storage.has(key)).toBe(false);
  expect(archived).toHaveLength(1);
});

it('the unload guard protects only data not yet acknowledged by the VPS', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const saved = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(saved); expect(saved.defaultPrevented).toBe(false);
  canvas.rename('Unsaved edit');
  const pending = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(pending); expect(pending.defaultPrevented).toBe(true);
  await canvas.flush();
  const complete = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(complete); expect(complete.defaultPrevented).toBe(false);
});

it('history browsing is read-only and restoring keeps the same flow ID', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const archivedVersion = { ...mk('f-alpha-123'), name: 'Earlier title', rev: 0 };
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/history')) return Response.json([{ id: 'r-old', kind: 'revision', rev: 0, name: 'Earlier title', nodes: 0, createdAt: '' }]);
    if (url.endsWith('/history/r-old')) return Response.json(archivedVersion);
    if (url.endsWith('/history/r-old/restore')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ rev: 1, requestId: expect.any(String) });
      return Response.json({ ...archivedVersion, rev: 2 });
    }
    return realFetch(url, init);
  }));
  expect(await canvas.loadHistory('f-alpha-123')).toHaveLength(1);
  expect((await canvas.loadHistoryVersion('f-alpha-123', 'r-old')).name).toBe('Earlier title');
  expect(useCanvas.getState().flow?.name).toBe('f-alpha-123');
  expect(await canvas.restoreHistoryVersion('f-alpha-123', 'r-old')).toBe(true);
  expect(useCanvas.getState().flow).toMatchObject({ id: 'f-alpha-123', name: 'Earlier title', rev: 2 });
});

it('flush drains edits enqueued while an empty writer is releasing its resolved promise', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const empty = canvas.flush();
  canvas.rename('Enqueued during empty ACK');
  const joining = canvas.flush();
  expect(await empty).toBe(true);
  expect(await joining).toBe(true);
  expect(useCanvas.getState().save).toBe('saved');
  expect(flows.get('f-alpha-123')?.name).toBe('Enqueued during empty ACK');
});

it('restoring archives an unsaveable target queue, ignores other failed flows, and keeps only edits made during restore', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let locked = false;
  let targetWritesDuringRestore = 0;
  const prior = { ...mk('f-alpha-123'), name: 'Restored title' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      if (locked && url.endsWith('f-alpha-123')) targetWritesDuringRestore += 1;
      return Response.json({ messageRu: 'Conflicting connections' }, { status: 409 });
    }
    if (url.endsWith('/history/r-old/restore')) {
      locked = true; entered(); await gate;
      const next = { ...prior, rev: 2 }; flows.set(prior.id, next); return Response.json(next);
    }
    return realFetch(url, init);
  }));
  canvas.rename('Pre-click rejected graph');
  expect(await canvas.flush()).toBe(false);
  await canvas.openFlow('f-other-123'); canvas.rename('Other failed queue');
  expect(await canvas.flush()).toBe(false);
  await canvas.openFlow('f-alpha-123');
  const restoring = canvas.restoreHistoryVersion('f-alpha-123', 'r-old'); await started;
  expect(archived.at(-1)?.name).toBe('Pre-click rejected graph');
  canvas.rename('Typed after restore click');
  await vi.advanceTimersByTimeAsync(1000);
  expect(targetWritesDuringRestore).toBe(0);
  release(); expect(await restoring).toBe(true); locked = false;
  expect(useCanvas.getState().flow).toMatchObject({ id: 'f-alpha-123', name: 'Typed after restore click', rev: 2 });
  vi.stubGlobal('fetch', realFetch); expect(await canvas.flush()).toBe(true);
  expect(flows.get('f-alpha-123')?.name).toBe('Typed after restore click');
  expect(flows.get('f-other-123')?.name).toBe('Other failed queue');
  expect(flows.size).toBe(2);
});

it('restoring keeps the pending target intact when the server cannot archive it', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  canvas.rename('Must survive failed archive');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ messageRu: 'Offline archive' }, { status: 503 })));
  await expect(canvas.restoreHistoryVersion('f-alpha-123', 'r-old')).rejects.toThrow('Offline archive');
  expect(useCanvas.getState().flow?.name).toBe('Must survive failed archive');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/canvas/legacy-drafts');
});

it('a restore waits for a target save already in flight before archiving and replacing it', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  let first = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (first && init?.method === 'PATCH') {
      first = false; calls.push('save started'); entered(); await gate;
      const result = await realFetch(url, init); calls.push('save finished'); return result;
    }
    if (url === '/api/canvas/legacy-drafts') calls.push('archive');
    if (url.endsWith('/history/r-old/restore')) {
      calls.push('restore'); expect(JSON.parse(String(init?.body))).toMatchObject({ rev: 2, requestId: expect.any(String) });
      const restored = { ...mk('f-alpha-123'), rev: 3, name: 'Chosen old version' };
      flows.set(restored.id, restored); return Response.json(restored);
    }
    return realFetch(url, init);
  }));
  canvas.rename('Edit already sending');
  const saving = canvas.flush(); await started;
  const restoring = canvas.restoreHistoryVersion('f-alpha-123', 'r-old');
  await vi.advanceTimersByTimeAsync(0); expect(calls).toEqual(['save started']);
  release(); await saving; expect(await restoring).toBe(true);
  expect(calls).toEqual(['save started', 'save finished', 'archive', 'restore']);
  expect(archived[0]?.name).toBe('Edit already sending');
  expect(useCanvas.getState().flow).toMatchObject({ rev: 3, name: 'Chosen old version' });
  expect(useCanvas.getState().save).toBe('saved');
});

it('acknowledging a deletion keeps its inverse history available for undo and redo', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const id = canvas.addNode('comment', 0, 0); await canvas.flush();
  canvas.removeNode(id); await canvas.flush();
  expect(useCanvas.getState().flow?.nodes).toHaveLength(0);
  canvas.undo(); expect(useCanvas.getState().flow?.nodes.map(node => node.id)).toEqual([id]);
  canvas.redo(); expect(useCanvas.getState().flow?.nodes).toHaveLength(0);
});

it('a lost PATCH acknowledgement replays its exact envelope after polling a later edit from another tab', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const base = useCanvas.getState().flow!;
  const realFetch = globalThis.fetch;
  let firstBody: string | null = null;
  let first = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      if (first) {
        first = false; firstBody = String(init.body); await realFetch(url, init);
        throw new TypeError('Lost acknowledged response');
      }
      if (String(init.body) === firstBody) return Response.json(flows.get('f-alpha-123'));
    }
    return realFetch(url, init);
  }));
  canvas.rename('A saved but ACK lost'); expect(await canvas.flush()).toBe(false);
  const otherTab = { ...flows.get(base.id)!, name: 'B later edit', rev: 3 };
  flows.set(base.id, otherTab);
  expect(canvas.applyServerFlow(otherTab, base)).toBe(true);
  expect(await canvas.flush()).toBe(true);
  const requests = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH');
  expect(String(requests[1]?.[1]?.body)).toBe(String(requests[0]?.[1]?.body));
  expect(useCanvas.getState().flow?.name).toBe('B later edit');
  expect(flows.get(base.id)?.name).toBe('B later edit');
  expect(writes).toHaveLength(1);
});

it('only fresh user edits are rebased after a lost ACK even when polls changed the visible graph', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const base = useCanvas.getState().flow!;
  const realFetch = globalThis.fetch;
  let failedBody: string | null = null;
  let first = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      if (first) {
        first = false; failedBody = String(init.body); await realFetch(url, init); throw new TypeError('Lost response');
      }
      if (String(init.body) === failedBody) return Response.json(flows.get(base.id));
    }
    return realFetch(url, init);
  }));
  canvas.rename('A'); expect(await canvas.flush()).toBe(false);
  const remoteNode = blankNode('comment', 0, 0);
  const otherTab = { ...flows.get(base.id)!, name: 'B', rev: 3, nodes: [remoteNode] };
  flows.set(base.id, otherTab); canvas.applyServerFlow(otherTab, base);
  canvas.setViewport({ x: 100, y: 20, zoom: 1 });
  expect(await canvas.flush()).toBe(true);
  expect(flows.get(base.id)).toMatchObject({ name: 'B', nodes: [{ id: remoteNode.id }], viewport: { x: 100 } });
});

it('a lost restore response pauses the old queue and replays the same receipt on explicit retry', async () => {
  const canvas = useCanvas.getState(); await canvas.openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  let firstRestore = true;
  const restoreBodies: string[] = [];
  let patchCount = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { patchCount += 1; return realFetch(url, init); }
    if (url.endsWith('/history/r-old/restore')) {
      restoreBodies.push(String(init?.body));
      if (firstRestore) {
        firstRestore = false;
        flows.set('f-alpha-123', { ...mk('f-alpha-123'), name: 'Restored historical version', rev: 2 });
        throw new TypeError('Lost restore response');
      }
      return Response.json(flows.get('f-alpha-123'));
    }
    return realFetch(url, init);
  }));
  canvas.rename('Old unsaved version');
  await expect(canvas.restoreHistoryVersion('f-alpha-123', 'r-old')).rejects.toThrow('Ответ сервера не получен.');
  await vi.advanceTimersByTimeAsync(60000);
  expect(await canvas.flush()).toBe(false);
  expect(patchCount).toBe(0);
  expect(flows.get('f-alpha-123')?.name).toBe('Restored historical version');
  canvas.setViewport({ x: 120, y: 40, zoom: 1 });
  await vi.advanceTimersByTimeAsync(1000); expect(patchCount).toBe(0);
  expect(await canvas.retrySave()).toBe(true);
  expect(restoreBodies[1]).toBe(restoreBodies[0]);
  expect(archived).toHaveLength(1);
  expect(useCanvas.getState().flow?.name).toBe('Restored historical version');
  expect(await canvas.flush()).toBe(true);
  expect(flows.get('f-alpha-123')).toMatchObject({ name: 'Restored historical version', viewport: { x: 120 } });
  expect(patchCount).toBe(1);
});
