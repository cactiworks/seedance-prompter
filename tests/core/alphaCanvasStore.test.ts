import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlowSchema, type Flow } from '../../src/core/model/canvas.ts';
import { blankNode, useCanvas } from '../../src/web/canvas/canvasStore.ts';

let flows: Map<string, Flow>;
let writes: Flow[];
beforeEach(() => {
  const mk = (id: string): Flow => FlowSchema.parse({ id, name: id, rev: 1, nodes: [], edges: [], createdAt: '', updatedAt: '' });
  flows = new Map(['f-alpha-123', 'f-other-123'].map((id) => [id, mk(id)])); writes = [];
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const id = url.split('/').at(-1)!;
    if (url === '/api/canvas/flows' && init?.method === 'POST') {
      const created = { ...mk('f-copy-123'), name: JSON.parse(init.body as string).name };
      flows.set(created.id, created); return Response.json(created);
    }
    if (init?.method === 'PUT') {
      const incoming = JSON.parse(init.body as string) as Flow;
      if (incoming.rev !== flows.get(id)?.rev) return Response.json({ messageRu: 'Конфликт' }, { status: 409 });
      const saved = { ...incoming, rev: (incoming.rev ?? 0) + 1 }; flows.set(id, saved); writes.push(saved); return Response.json(saved);
    }
    return Response.json(url === '/api/canvas/flows' ? [...flows.values()] : flows.get(id));
  }));
  useCanvas.setState({ flow: null, flows: [], past: [], future: [], save: 'saved', error: null });
});
afterEach(async () => { await useCanvas.getState().flush(); vi.unstubAllGlobals(); });

it('B02: switching immediately after typing flushes the captured old flow, and saved means the confirmed payload', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const id = useCanvas.getState().addNode('prompt', 0, 0);
  useCanvas.getState().patchNode(id, { text: 'Last keystroke' });
  await useCanvas.getState().openFlow('f-other-123');
  expect(writes.map((f) => f.id)).toEqual(['f-alpha-123']);
  await useCanvas.getState().openFlow('f-alpha-123');
  expect(useCanvas.getState().flow?.nodes[0]?.text).toBe('Last keystroke');
  expect(useCanvas.getState().save).toBe('saved');
});

it('B03: a late processing result cannot attach after its inputs or target flow changed', async () => {
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

it('B12: duplicate and clipboard keep source videos but not generated outputs', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const video = { ...blankNode('video', 0, 0), mediaId: 'm-source-video' };
  useCanvas.getState().update((f) => ({ ...f, nodes: [video] }));
  useCanvas.getState().select(video.id);
  const text = useCanvas.getState().copySelected()!;
  useCanvas.getState().duplicateSelected();
  expect(useCanvas.getState().pasteNodes(text, { x: 500, y: 0 })).toBe(1);
  expect(useCanvas.getState().flow?.nodes.map((n) => n.mediaId)).toEqual(['m-source-video', 'm-source-video', 'm-source-video']);
});

it('B02: a keystroke during a pending save is sent with the acknowledged revision before navigation', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (first && init?.method === 'PUT') { first = false; entered(); await gate; }
    return realFetch(url, init);
  }));
  useCanvas.getState().rename('First edit');
  const saving = useCanvas.getState().flush(); await started;
  useCanvas.getState().rename('Second edit'); release();
  expect(await saving).toBe(true);
  expect(writes.map((f) => [f.name, f.rev])).toEqual([['First edit', 2], ['Second edit', 3]]);
  expect(useCanvas.getState().save).toBe('saved');
});

it('B13: invalid clipboard graphs are rejected before entering the open flow', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const node = blankNode('prompt', 0, 0);
  const text = `sp-canvas:${JSON.stringify({ nodes: [node, node], edges: [] })}`;
  expect(useCanvas.getState().pasteNodes(text, { x: 0, y: 0 })).toBe(0);
  expect(useCanvas.getState().flow?.nodes).toHaveLength(0);
});

it('B02: edits made while the next flow is loading are saved before it replaces the view', async () => {
  await useCanvas.getState().openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('f-other-123') && !init?.method) { entered(); await gate; }
    return realFetch(url, init);
  }));
  const opening = useCanvas.getState().openFlow('f-other-123'); await started;
  useCanvas.getState().rename('Typed during navigation'); release(); await opening;
  expect(flows.get('f-alpha-123')?.name).toBe('Typed during navigation');
  expect(useCanvas.getState().flow?.id).toBe('f-other-123');
});

it('refreshing the current production flow loads newly handed-off branches without losing saved edits', async () => {
  const canvas = useCanvas.getState();
  await canvas.openFlow('f-alpha-123');
  canvas.rename('My manual title');
  await canvas.flush();
  const saved = flows.get('f-alpha-123')!;
  flows.set(saved.id, { ...saved, rev: saved.rev! + 1, nodes: [blankNode('image', 80, 80)] });
  await canvas.openFlow(saved.id, true);
  expect(useCanvas.getState().flow?.nodes).toHaveLength(1);
  expect(useCanvas.getState().flow?.name).toBe('My manual title');
  canvas.rename('After the next handoff');
  expect(await canvas.flush()).toBe(true);
});

it('refreshing the same flow cannot replace edits made while its snapshot was loading', async () => {
  const canvas = useCanvas.getState();
  await canvas.openFlow('f-alpha-123');
  const realFetch = globalThis.fetch;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const result = await realFetch(url, init);
    if (url.endsWith('f-alpha-123') && !init?.method) { entered(); await gate; }
    return result;
  }));
  const opening = canvas.openFlow('f-alpha-123', true);
  await started;
  canvas.rename('Typed while refreshing');
  release(); await opening;
  expect(useCanvas.getState().flow?.name).toBe('Typed while refreshing');
  expect(flows.get('f-alpha-123')?.name).toBe('Typed while refreshing');
});

it('saving a recovery copy gives Seedance drafts independent ownership and keeps historical results', async () => {
  const canvas = useCanvas.getState();
  await canvas.openFlow('f-alpha-123');
  const image = blankNode('image', 80, 80);
  const seedance = { ...blankNode('seedance', 440, 80), slug:'cv-original', shotId:'shot-1', jobIds:['historical-job'], production:{ runId:'series',shotId:'shot-1',artifactId:'photo' } };
  canvas.update(f => ({ ...f, nodes:[image,seedance], edges:[{id:'e-original',from:image.id,to:seedance.id,port:'ref'}] }));
  await canvas.flush();
  await canvas.saveCopy();
  const copy = useCanvas.getState().flow!;
  const copied = copy.nodes.find(n => n.type === 'seedance')!;
  expect(copy.id).not.toBe('f-alpha-123');
  expect(copied.id).not.toBe(seedance.id);
  expect(copied.slug).toBe(''); expect(copied.copyFrom).toBe(seedance.slug);
  expect(copied.production).toBeUndefined(); expect(copied.jobIds).toEqual(['historical-job']);
  expect(copy.edges[0]?.to).toBe(copied.id);
  expect(flows.get('f-alpha-123')?.nodes[1]?.slug).toBe(seedance.slug);
});
