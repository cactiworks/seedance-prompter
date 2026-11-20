import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CanvasAiProjectionSchema, CanvasNodeSchema, FlowSchema, type CanvasNode, type Flow } from '../../src/core/model/canvas.ts';
import { aiPromptProblems } from '../../src/core/canvas/ai.ts';
import type * as CanvasModule from '../../src/web/canvas/canvasStore.ts';

let canvas: typeof CanvasModule;
const node = (patch: Partial<CanvasNode> & { id: string; type: CanvasNode['type'] }) => CanvasNodeSchema.parse({ x: 0, y: 0, ...patch });
const graph = (): Flow => FlowSchema.parse({
  id: 'f-test', rev: 0, name: 'Test', createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z',
  nodes: [
    node({ id: 'comment', type: 'comment', text: 'Creative brief' }),
    node({ id: 'photo', type: 'image', source: { type: 'media', mediaId: 'm-photo' } }),
    node({ id: 'ai', type: 'ai', targetGeneratorId: 'gen', ai: CanvasAiProjectionSchema.parse({ idea: { id: 'v-idea', text: 'Прежняя идея', inputFingerprint: 'fp', createdAt: 'now' }, prompt: { id: 'v-prompt', text: 'Previous English prompt', inputFingerprint: 'fp', createdAt: 'now' } }) }),
    node({ id: 'prompt', type: 'prompt', text: 'Previous English prompt', aiSource: { aiNodeId: 'ai', versionId: 'v-prompt', inputFingerprint: 'fp' }, aiApproval: { versionId: 'v-prompt', inputFingerprint: 'fp', approvedAt: 'now' } }),
    node({ id: 'gen', type: 'generator', modelId: 'higgsfield/seedance-2-5', kind: 'video', jobIds: ['j-old'], acceptedJobId: 'j-old', acceptedMediaId: 'm-old' }),
  ],
  edges: [
    { id: 'e1', from: 'comment', to: 'ai', port: 'context' },
    { id: 'e2', from: 'photo', to: 'ai', port: 'ref' },
    { id: 'e3', from: 'photo', to: 'gen', port: 'start' },
    { id: 'e4', from: 'ai', to: 'prompt', port: 'idea' },
    { id: 'e5', from: 'prompt', to: 'gen', port: 'prompt' },
  ],
});

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const data = init?.body ? JSON.parse(String(init.body)) as Flow : graph();
    return new Response(JSON.stringify({ ...data, rev: (data.rev ?? 0) + 1, updatedAt: 'server-canonical-time' }), { headers: { 'content-type': 'application/json' } });
  }));
  canvas = await import('../../src/web/canvas/canvasStore.ts');
  canvas.useCanvas.setState({ flow: graph(), save: 'saved', selected: null, selection: [], past: [], future: [] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('group duplication remaps the AI target and provenance without carrying approved versions or generated results', () => {
  const original = canvas.useCanvas.getState().flow!;
  canvas.useCanvas.getState().selectMany(['ai', 'prompt', 'gen']);
  canvas.useCanvas.getState().duplicateSelected();
  const result = canvas.useCanvas.getState().flow!;
  const copied = result.nodes.filter(n => !original.nodes.some(old => old.id === n.id));
  const ai = copied.find(n => n.type === 'ai')!;
  const prompt = copied.find(n => n.type === 'prompt')!;
  const generator = copied.find(n => n.type === 'generator')!;
  expect(ai.targetGeneratorId).toBe(generator.id);
  expect(ai.ai).toBeUndefined();
  expect(prompt.aiSource?.aiNodeId).toBe(ai.id);
  expect(prompt.aiApproval).toBeUndefined();
  expect(generator.jobIds).toEqual([]);
  expect(generator.acceptedMediaId).toBeNull();
  expect(result.edges.some(e => e.from === ai.id && e.to === prompt.id && e.port === 'idea')).toBe(true);
  expect(aiPromptProblems(result, prompt, generator.id).length).toBeGreaterThan(0);
  expect(original.nodes.find(n => n.id === 'prompt')?.aiApproval).toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
});

it('a prompt copied alone remains an unapproved managed draft rather than silently becoming a manual prompt', () => {
  canvas.useCanvas.getState().selectMany(['prompt']);
  canvas.useCanvas.getState().duplicateSelected();
  const result = canvas.useCanvas.getState().flow!;
  const copy = result.nodes.at(-1)!;
  expect(copy.aiSource?.aiNodeId).toBe('ai');
  expect(copy.aiApproval).toBeUndefined();
  expect(aiPromptProblems(result, copy).length).toBeGreaterThan(0);
});

it('import/recovery remapping retains media history while resetting AI approvals and remapping links', () => {
  const original = graph();
  const ids = new Map(original.nodes.map(n => [n.id, `copy-${n.id}`]));
  const nodes = original.nodes.map(n => canvas.remapCanvasCopy(n, ids));
  expect(nodes.find(n => n.type === 'ai')?.targetGeneratorId).toBe('copy-gen');
  expect(nodes.find(n => n.type === 'ai')?.ai).toBeUndefined();
  expect(nodes.find(n => n.type === 'prompt')?.aiSource?.aiNodeId).toBe('copy-ai');
  expect(nodes.find(n => n.type === 'prompt')?.aiApproval).toBeUndefined();
  expect(nodes.find(n => n.type === 'generator')?.jobIds).toEqual(['j-old']);
  expect(nodes.find(n => n.type === 'generator')?.acceptedMediaId).toBeNull();
});

it('a correction branch keeps the accepted start source and previous idea/prompt but never treats the rejected video as a visual reference', () => {
  const original = canvas.useCanvas.getState().flow!;
  const originalJson = JSON.stringify(original.nodes);
  const nextAiId = canvas.useCanvas.getState().createCorrectionBranch('gen')!;
  const result = canvas.useCanvas.getState().flow!;
  const nextAi = result.nodes.find(n => n.id === nextAiId)!;
  const nextGenerator = result.nodes.find(n => n.id === nextAi.targetGeneratorId)!;
  const revisionComment = result.nodes.find(n => n.type === 'comment' && n.id !== 'comment')!;
  expect(revisionComment.text).toContain('Прежняя идея');
  expect(revisionComment.text).toContain('Previous English prompt');
  expect(nextGenerator.jobIds).toEqual([]);
  expect(nextAi.ai).toBeUndefined();
  expect(result.edges.some(e => e.from === 'photo' && e.to === nextGenerator.id && e.port === 'start')).toBe(true);
  expect(result.edges.some(e => e.from === 'gen' && e.to === nextAi.id)).toBe(false);
  expect(result.edges.some(e => e.from === 'prompt' && e.to === nextGenerator.id)).toBe(false);
  expect(JSON.stringify(result.nodes.filter(n => original.nodes.some(old => old.id === n.id)))).toBe(originalJson);
  expect(fetch).not.toHaveBeenCalled();
});

it('a server projection cannot overwrite newer local edits and accepted revisions are used for the next save', async () => {
  const captured = canvas.useCanvas.getState().flow!;
  const remote = { ...captured, rev: 7 };
  expect(canvas.useCanvas.getState().applyServerFlow(remote, captured)).toBe(true);
  expect(canvas.useCanvas.getState().applyServerFlow({ ...remote }, captured)).toBe(true);
  expect(canvas.useCanvas.getState().applyServerFlow({ ...remote, rev: 6 }, remote)).toBe(false);
  canvas.useCanvas.getState().patchNode('comment', { text: 'New local input' });
  expect(canvas.useCanvas.getState().applyServerFlow({ ...remote, rev: 8 }, remote)).toBe(false);
  expect(canvas.useCanvas.getState().flow?.nodes[0]?.text).toBe('New local input');
  expect(await canvas.useCanvas.getState().flush()).toBe(true);
  const request = vi.mocked(fetch).mock.calls[0]?.[1];
  expect(JSON.parse(String(request?.body)).rev).toBe(7);
  expect(canvas.useCanvas.getState().flow?.updatedAt).toBe('server-canonical-time');
});


it('creates and reuses a separate prompt step without changing the existing approved idea', () => {
  const original = canvas.useCanvas.getState().flow!;
  const idea = JSON.stringify(original.nodes.find(n => n.id === 'ai')?.ai?.idea);
  const reused = canvas.useCanvas.getState().addAiPrompt('ai');
  expect(reused).toBe('prompt');
  expect(canvas.useCanvas.getState().flow).toBe(original);
  canvas.useCanvas.getState().removeNode('prompt');
  const id = canvas.useCanvas.getState().addAiPrompt('ai')!;
  const flow = canvas.useCanvas.getState().flow!;
  expect(flow.nodes.find(n => n.id === id)?.type).toBe('prompt');
  expect(flow.edges).toContainEqual(expect.objectContaining({ from: 'ai', to: id, port: 'idea' }));
  expect(flow.edges).toContainEqual(expect.objectContaining({ from: id, to: 'gen', port: 'prompt' }));
  expect(JSON.stringify(flow.nodes.find(n => n.id === 'ai')?.ai?.idea)).toBe(idea);
  expect(canvas.useCanvas.getState().addAiPrompt('ai')).toBe(id);
  expect(canvas.useCanvas.getState().flow!.nodes.filter(n => n.type === 'prompt')).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
});

it('opens each visible AI block at its own stage and focuses the prompt node without running a model', () => {
  const state = canvas.useCanvas.getState();
  state.openAi('ai', 'idea');
  expect(canvas.useCanvas.getState().aiDrawer).toEqual({ nodeId: 'ai', stage: 'idea' });
  state.focusNode('prompt');
  state.openAi('ai', 'prompt');
  expect(canvas.useCanvas.getState().selected).toBe('prompt');
  expect(canvas.useCanvas.getState().aiDrawer).toEqual({ nodeId: 'ai', stage: 'prompt' });
  expect(fetch).not.toHaveBeenCalled();
});
