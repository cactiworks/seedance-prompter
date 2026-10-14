import { expect, it } from 'vitest';
import { FlowSchema, CanvasNodeSchema, type CanvasNode, type Flow } from '../../src/core/model/canvas.ts';
import { invalidateChanged, inputFingerprint } from '../../src/core/canvas/freshness.ts';
import { planRun, mediaInput } from '../../src/core/canvas/plan.ts';
import { validatePrompts, withShotIds } from '../../src/core/production/plan.ts';
import { promptPlan, sceneDraft } from '../production/fixtures.ts';

const node = (id: string, type: CanvasNode['type'], patch: Partial<CanvasNode> = {}): CanvasNode => CanvasNodeSchema.parse({ id, type, x: 0, y: 0, ...patch });
const graph = (): Flow => FlowSchema.parse({ id: 'f-alpha-123', name: 'Example', createdAt: '', updatedAt: '', nodes: [node('source', 'image', { source: { type: 'media', mediaId: 'm-original' } }), node('resize', 'resize', { mediaId: 'm-old-result' }), node('gen', 'generator', { modelId: 'kie/gpt-image-2-5', text: 'A red chair' }), node('other', 'resize')], edges: [{ id: 'e1', from: 'source', to: 'resize', port: 'media' }, { id: 'e2', from: 'resize', to: 'gen', port: 'ref' }] });

it('B03: source replacement invalidates only descendants and blocks an old result from a paid plan', () => {
  const before = graph();
  const after = invalidateChanged(before, { ...before, nodes: before.nodes.map((n) => n.id === 'source' ? { ...n, source: { type: 'media' as const, mediaId: 'm-new' } } : n) });
  expect(after.nodes.filter((n) => n.stale).map((n) => n.id)).toEqual(['resize', 'gen']);
  expect(planRun(after, 'gen', () => null).refs).toEqual([]);
  expect(planRun(after, 'gen', () => null).problems.join(' ')).toContain('вход изменился');
  expect(mediaInput(after, 'resize', () => null).source).toEqual({ type: 'media', mediaId: 'm-new' });
  expect(after.nodes[1]!.mediaId).toBe('m-old-result');
});

it('B03: disconnection/config edits invalidate outputs; dragging and labels do not', () => {
  const before = graph();
  const disconnected = invalidateChanged(before, { ...before, edges: before.edges.slice(1) });
  expect(disconnected.nodes.find((n) => n.id === 'resize')?.stale).toBe(true);
  const moved = { ...before, nodes: before.nodes.map((n) => ({ ...n, x: 42, label: 'Renamed' })) };
  expect(invalidateChanged(before, moved).nodes.some((n) => n.stale)).toBe(false);
  expect(inputFingerprint(before, 'resize')).toBe(inputFingerprint(moved, 'resize'));
  expect(inputFingerprint(before, 'resize')).not.toBe(inputFingerprint(disconnected, 'resize'));
});

it('B13: rejects duplicate IDs, unknown endpoints, self loops, cycles, incompatible ports and zero zoom', () => {
  const before = graph();
  const invalid = [
    { ...before, nodes: [...before.nodes, before.nodes[0]] },
    { ...before, edges: [{ id: 'e', from: 'absent', to: 'resize', port: 'media' }] },
    { ...before, edges: [{ id: 'e', from: 'resize', to: 'resize', port: 'media' }] },
    { ...before, edges: [{ id: 'e', from: 'resize', to: 'other', port: 'media' }, { id: 'e2', from: 'other', to: 'resize', port: 'media' }] },
    { ...before, edges: [{ id: 'e', from: 'source', to: 'resize', port: 'prompt' }] },
    { ...before, viewport: { x: 0, y: 0, zoom: 0 } },
  ];
  for (const flow of invalid) expect(FlowSchema.safeParse(flow).success).toBe(false);
});

it('B20: rejects a Russian one-word prompt and motion beyond the director duration; accepts the valid contract', () => {
  const scene = withShotIds(sceneDraft()); const valid = promptPlan();
  expect(validatePrompts(valid, scene)).toEqual([]);
  const invalid = { ...valid, shots: valid.shots.map((s) => ({ ...s, imagePrompt: 'кот', motionPrompt: '0–30s: a camera moves through another city.' })) };
  const issues = validatePrompts(invalid, scene).join(' ');
  expect(issues).toContain('40–200'); expect(issues).toContain('английском'); expect(issues).toContain('0–6 s');
});

it('B03: Seedance display summary does not invalidate a matching input capture, reference changes do', () => {
  const source = node('source', 'image', { source: { type: 'media', mediaId: 'm-one' } });
  const seedance = node('seedance', 'seedance', { text: 'Old display summary' });
  const flow: Flow = { ...graph(), nodes: [source, seedance], edges: [{ id: 'ref', from: source.id, to: seedance.id, port: 'ref' }] };
  const summary = { ...flow, nodes: [source, { ...seedance, text: 'Updated display summary' }] };
  expect(inputFingerprint(summary, seedance.id)).toBe(inputFingerprint(flow, seedance.id));
  const changed = { ...flow, nodes: [{ ...source, source: { type: 'media' as const, mediaId: 'm-two' } }, seedance] };
  expect(inputFingerprint(changed, seedance.id)).not.toBe(inputFingerprint(flow, seedance.id));
});
