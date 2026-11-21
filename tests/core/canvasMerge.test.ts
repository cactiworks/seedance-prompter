import { expect, it } from 'vitest';
import { mergeCanvasFlow } from '../../src/core/canvas/merge.ts';
import { CanvasNodeSchema, FlowSchema, type CanvasNode, type Flow } from '../../src/core/model/canvas.ts';

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => CanvasNodeSchema.parse({ id, type: 'generator', x: 0, y: 0, ...patch });
const flow = (nodes = [node('one')]): Flow => FlowSchema.parse({ id: 'f-merge-test', name: 'Example', rev: 1, createdAt: '', updatedAt: '', nodes, edges: [] });

it('merges concurrent node edits and server additions without replacing AI projections', () => {
  const base = flow();
  const desired = { ...base, nodes: [{ ...base.nodes[0]!, x: 150 }], viewport: { x: 50, y: 0, zoom: 1 } };
  const current = { ...base, rev: 2, nodes: [{ ...base.nodes[0]!, ai: { runId: 'finished', status: 'ready' as const, stage: 'idea' as const, idea: null, prompt: null, errorRu: null } }, node('server-created')], viewport: { x: 0, y: 60, zoom: 1 } };
  const merged = mergeCanvasFlow(base, desired, current);
  expect(merged.nodes.map(n => n.id)).toEqual(['one', 'server-created']);
  expect(merged.nodes[0]).toMatchObject({ x: 150, ai: { runId: 'finished', status: 'ready' } });
  expect(merged.viewport).toEqual({ x: 50, y: 60, zoom: 1 });
  expect(merged.rev).toBe(2);
});

it('merges params and refSync keys, while same-field edits use the latest caller', () => {
  const base = flow([node('one', { params: { seed: 1, durationSec: 5 }, refSync: { old: 'a' } })]);
  const desired = { ...base, nodes: [{ ...base.nodes[0]!, params: { seed: 2, durationSec: 5 }, refSync: { old: 'a', mine: 'b' } }] };
  const current = { ...base, nodes: [{ ...base.nodes[0]!, params: { seed: 3, durationSec: 10 }, refSync: { old: 'changed', theirs: 'c' } }] };
  expect(mergeCanvasFlow(base, desired, current).nodes[0]).toMatchObject({ params: { seed: 2, durationSec: 10 }, refSync: { old: 'changed', mine: 'b', theirs: 'c' } });
});

it('keeps concurrent jobs and resolves selection by job identity', () => {
  const base = flow([node('one', { jobIds: ['j1'], selected: 0 })]);
  const desired = { ...base, nodes: [{ ...base.nodes[0]!, jobIds: ['j1', 'mine'], selected: 1 }] };
  const current = { ...base, nodes: [{ ...base.nodes[0]!, jobIds: ['j1', 'theirs'], selected: 1 }] };
  const merged = mergeCanvasFlow(base, desired, current).nodes[0]!;
  expect(merged.jobIds).toEqual(['j1', 'theirs', 'mine']);
  expect(merged.jobIds[merged.selected]).toBe('mine');
  const moved = { ...base, nodes: [{ ...base.nodes[0]!, x: 10 }] };
  const unchangedSelection = mergeCanvasFlow(base, moved, current).nodes[0]!;
  expect(unchangedSelection.jobIds[unchangedSelection.selected]).toBe('theirs');
});

it('does not resurrect removed jobs or nodes when an old tab saves unrelated edits', () => {
  const base = flow([node('one', { jobIds: ['removed', 'keep'], selected: 1 }), node('gone')]);
  const desired = { ...base, nodes: base.nodes.map(n => ({ ...n, x: 10 })) };
  const current = { ...base, nodes: [{ ...base.nodes[0]!, jobIds: ['keep'], selected: 0 }] };
  const merged = mergeCanvasFlow(base, desired, current);
  expect(merged.nodes).toHaveLength(1); expect(merged.nodes[0]?.jobIds).toEqual(['keep']);
  expect(merged.nodes[0]?.selected).toBe(0);
});

it('deletes only entities removed relative to the caller base and cleans dangling connections', () => {
  const base = flow([node('one', { type: 'resize' }), node('two', { type: 'resize' })]);
  const desired = { ...base, nodes: [base.nodes[0]!] };
  const current: Flow = { ...base, nodes: [...base.nodes, node('server', { type: 'resize' })], edges: [{ id: 'new-edge', from: 'server', to: 'two', port: 'media' }] };
  const merged = mergeCanvasFlow(base, desired, current);
  expect(merged.nodes.map(n => n.id)).toEqual(['one', 'server']);
  expect(merged.edges).toEqual([]);
});

it('keeps caller input order changes without losing newly added server connections', () => {
  const base = flow([node('one', { type: 'comment' }), node('two', { type: 'comment' }), node('ai', { type: 'ai' })]);
  base.edges = [{ id: 'a', from: 'one', to: 'ai', port: 'context' }, { id: 'b', from: 'two', to: 'ai', port: 'context' }];
  const current: Flow = { ...base, nodes: [...base.nodes, node('extra', { type: 'comment' })], edges: [...base.edges, { id: 'c', from: 'extra', to: 'ai', port: 'context' }] };
  const desired = { ...base, edges: [...base.edges].reverse() };
  expect(mergeCanvasFlow(base, desired, current).edges.map(edge => edge.id)).toEqual(['b', 'a', 'c']);
});

it('replayed additions preserve server changes already attached to the added node', () => {
  const base = flow([]); const added = node('new');
  const desired = { ...base, nodes: [added] };
  const current = { ...base, nodes: [{ ...added, label: 'Server result', jobIds: ['finished'] }] };
  expect(mergeCanvasFlow(base, desired, current).nodes[0]).toMatchObject({ label: 'Server result', jobIds: ['finished'] });
});
