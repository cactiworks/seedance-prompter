import { describe, expect, it } from 'vitest';
import { aiApprovalCurrent, aiInputContext, aiPromptProblems } from '../../src/core/canvas/ai.ts';
import { inputFingerprint, invalidateChanged } from '../../src/core/canvas/freshness.ts';
import { planRun } from '../../src/core/canvas/plan.ts';
import { CanvasAiProjectionSchema, CanvasNodeSchema, FlowSchema, inputsOf, outputOf, portAccepts, type CanvasNode, type Flow } from '../../src/core/model/canvas.ts';

const node = (id: string, type: CanvasNode['type'], patch: Partial<CanvasNode> = {}): CanvasNode => CanvasNodeSchema.parse({ id, type, x: 0, y: 0, ...patch });
const graph = (): Flow => FlowSchema.parse({ id: 'f-ai', name: 'AI flow', createdAt: '', updatedAt: '', nodes: [
  node('comment', 'comment', { text: 'Человек раскрывает красный зонт в дождливом переулке.' }),
  node('ai', 'ai', { targetGeneratorId: 'gen' }),
  node('prompt', 'prompt'),
  node('gen', 'generator', { modelId: 'higgsfield/soul-2' }),
], edges: [
  { id: 'context', from: 'comment', to: 'ai', port: 'context' },
  { id: 'idea', from: 'ai', to: 'prompt', port: 'idea' },
  { id: 'prompt', from: 'prompt', to: 'gen', port: 'prompt' },
] });

function approved(flow: Flow = graph()): Flow {
  const fingerprint = inputFingerprint(flow, 'ai');
  const approval = { versionId: 'v-prompt', inputFingerprint: fingerprint, approvedAt: '2026-11-17T10:00:00Z' };
  const idea = { id: 'v-idea', text: 'Человек раскрывает красный зонт.', inputFingerprint: fingerprint, createdAt: '2026-11-17T09:58:00Z', approval: { ...approval, versionId: 'v-idea' } };
  const text = 'A person opens a red umbrella in a rainy alley.';
  return { ...flow, nodes: flow.nodes.map(n => n.id === 'ai' ? { ...n, stale: false, ai: CanvasAiProjectionSchema.parse({ status: 'ready', stage: 'prompt', idea, prompt: { id: 'v-prompt', text, inputFingerprint: fingerprint, createdAt: '2026-11-17T09:59:00Z', parentVersionId: idea.id, approval } }) } : n.id === 'prompt' ? { ...n, text, stale: false, aiSource: { aiNodeId: 'ai', versionId: 'v-prompt', inputFingerprint: fingerprint }, aiApproval: approval } : n) };
}

describe('Canvas AI contracts', () => {
  it('loads legacy nodes with safe defaults and keeps draft nodes valid before choosing a target', () => {
    const old = node('old', 'prompt', { text: 'Legacy prompt' });
    expect(old.targetGeneratorId).toBeNull();
    expect(old.ai).toBeUndefined();
    expect(old.acceptedJobId).toBeNull();
    expect(old.acceptedMediaId).toBeNull();
    expect(aiApprovalCurrent({ ...graph(), nodes: [old], edges: [] }, old)).toBe(true);
    expect(FlowSchema.safeParse({ ...graph(), nodes: [node('draft', 'ai')], edges: [] }).success).toBe(true);
  });

  it('separates context, idea and provider prompt ports and rejects a direct AI/comment generation wire', () => {
    const flow = graph();
    expect(inputsOf(flow.nodes[1]!, [])).toEqual(['context', 'ref']);
    expect(inputsOf(flow.nodes[2]!, [])).toEqual(['idea']);
    expect(outputOf(flow.nodes[0]!)).toBe('context');
    expect(outputOf(flow.nodes[1]!)).toBe('idea');
    expect(portAccepts('prompt', 'context')).toBe(false);
    expect(portAccepts('prompt', 'idea')).toBe(false);
    expect(portAccepts('media', 'idea')).toBe(false);
    expect(FlowSchema.safeParse(flow).success).toBe(true);
    for (const from of ['comment', 'ai']) expect(FlowSchema.safeParse({ ...flow, edges: [{ id: 'bad', from, to: 'gen', port: 'prompt' }] }).success).toBe(false);
    expect(FlowSchema.safeParse({ ...flow, nodes: [...flow.nodes, node('other-ai', 'ai')], edges: [...flow.edges, { id: 'duplicate', from: 'other-ai', to: 'prompt', port: 'idea' }] }).success).toBe(false);
  });

  it('resolves ordered comment/image inputs without sending media or starting a generator', () => {
    const flow = graph();
    const image = node('image', 'image', { source: { type: 'upload', uploadId: 'u-local-photo' }, label: 'Свет' });
    const second = node('second', 'comment', { text: 'Тёплый боковой свет.' });
    const withInputs = { ...flow, nodes: [...flow.nodes, image, second], edges: [...flow.edges, { id: 'ref', from: image.id, to: 'ai', port: 'ref' as const }, { id: 'second', from: second.id, to: 'ai', port: 'context' as const }] };
    const input = aiInputContext(withInputs, 'ai', () => null);
    expect(input.contexts.map(c => c.nodeId)).toEqual(['comment', 'second']);
    expect(input.refs).toEqual([{ label: 'Свет', role: 'ref', source: { type: 'upload', uploadId: 'u-local-photo' } }]);
    expect(input.problems).toEqual([]);
    expect(aiInputContext({ ...withInputs, nodes: withInputs.nodes.map(n => n.id === 'image' ? { ...n, source: null } : n) }, 'ai', () => null).problems.join(' ')).toContain('нет изображения');
  });

  it('binds AI attempts to target settings without depending on generated results or canvas geometry', () => {
    const before = graph();
    const fingerprint = inputFingerprint(before, 'ai');
    const targetResult = { ...before, nodes: before.nodes.map(n => n.id === 'gen' ? { ...n, jobIds: ['j-new'], selected: 0 } : { ...n, x: 50, label: 'Метка' }) };
    expect(inputFingerprint(targetResult, 'ai')).toBe(fingerprint);
    const settings = { ...before, nodes: before.nodes.map(n => n.id === 'gen' ? { ...n, params: { aspectRatio: '16:9' } } : n) };
    expect(inputFingerprint(settings, 'ai')).not.toBe(fingerprint);
    const stale = invalidateChanged(before, settings);
    expect(stale.nodes.filter(n => n.stale).map(n => n.id)).toEqual(['ai', 'prompt', 'gen']);
    expect(stale.nodes.find(n => n.id === 'comment')?.stale).toBeUndefined();
  });

  it('keeps an AI completion fingerprint stable while invalidating materialized descendants', () => {
    const before = approved();
    const after = { ...before, nodes: before.nodes.map(n => n.id === 'ai' && n.ai?.prompt ? { ...n, ai: { ...n.ai, prompt: { ...n.ai.prompt, id: 'v-new', text: 'A changed idea.', approval: null } } } : n) };
    expect(inputFingerprint(after, 'ai')).toBe(inputFingerprint(before, 'ai'));
    const stale = invalidateChanged(before, after);
    expect(stale.nodes.find(n => n.id === 'prompt')?.stale).toBe(true);
    expect(stale.nodes.find(n => n.id === 'gen')?.stale).toBe(true);
    expect(stale.nodes.find(n => n.id === 'ai')?.stale).toBe(false);
  });

  it('binds approvals to the actual target refs and their selected results without following its prompt edge', () => {
    const base = graph();
    const image = node('actual-ref', 'image', { source: { type: 'upload', uploadId: 'u-first' } });
    const initial = { ...base, nodes: [...base.nodes, image], edges: [...base.edges, { id: 'actual-ref-edge', from: image.id, to: 'gen', port: 'ref' as const }] };
    const flow = approved(initial);
    const before = inputFingerprint(flow, 'ai');
    const changed = { ...flow, nodes: flow.nodes.map(n => n.id === image.id ? { ...n, source: { type: 'upload' as const, uploadId: 'u-second' } } : n) };
    expect(inputFingerprint(changed, 'ai')).not.toBe(before);
    expect(invalidateChanged(flow, changed).nodes.find(n => n.id === 'ai')?.stale).toBe(true);
    expect(planRun(changed, 'gen', () => null).problems.join(' ')).toContain('Входы AI-промпта изменились');
    const disconnected = { ...flow, edges: flow.edges.filter(e => e.id !== 'actual-ref-edge') };
    expect(inputFingerprint(disconnected, 'ai')).not.toBe(before);
    // The AI's own projected approval and managed prompt are outputs, not inputs.
    const outputOnly = { ...flow, nodes: flow.nodes.map(n => n.id === 'prompt' ? { ...n, text: 'Another draft prompt' } : n) };
    expect(inputFingerprint(outputOnly, 'ai')).toBe(before);
    const generated = node('prior', 'generator', { modelId: 'higgsfield/soul-2', jobIds: ['j-first', 'j-second'], selected: 0 });
    const withPrior = { ...base, nodes: [...base.nodes, generated], edges: [...base.edges, { id: 'prior-ref', from: generated.id, to: 'gen', port: 'ref' as const }] };
    const selected = { ...withPrior, nodes: withPrior.nodes.map(n => n.id === generated.id ? { ...n, selected: 1 } : n) };
    expect(inputFingerprint(selected, 'ai')).not.toBe(inputFingerprint(withPrior, 'ai'));
  });

  it('allows only the exact approved materialized prompt and blocks edits, missing provenance and stale inputs', () => {
    const flow = approved();
    const prompt = flow.nodes.find(n => n.id === 'prompt')!;
    expect(aiPromptProblems(flow, prompt, 'gen')).toEqual([]);
    expect(planRun(flow, 'gen', () => null).problems).toEqual([]);
    expect(aiPromptProblems(flow, { ...prompt, text: `${prompt.text} More.` }, 'gen').join(' ')).toContain('изменён');
    expect(aiPromptProblems(flow, { ...prompt, aiApproval: undefined }, 'gen').join(' ')).toContain('Одобри');
    expect(aiPromptProblems({ ...flow, edges: flow.edges.filter(e => e.port !== 'idea') }, prompt, 'gen').join(' ')).toContain('недоступен');
    expect(aiPromptProblems(flow, prompt, 'other').join(' ')).toContain('другого генератора');
    const changed = { ...flow, nodes: flow.nodes.map(n => n.id === 'comment' ? { ...n, text: 'Другой замысел.' } : n) };
    expect(planRun(changed, 'gen', () => null).problems.join(' ')).toContain('Входы AI-промпта изменились');
    expect(prompt.text).toBe('A person opens a red umbrella in a rainy alley.');
  });

  it('blocks mixed or appended provider text around an approved AI prompt while retaining legacy composition', () => {
    const flow = approved();
    const extra = { ...flow, nodes: flow.nodes.map(n => n.id === 'gen' ? { ...n, text: 'An unreviewed change.' } : n) };
    expect(inputFingerprint(extra, 'ai')).not.toBe(inputFingerprint(flow, 'ai'));
    expect(invalidateChanged(flow, extra).nodes.find(n => n.id === 'ai')?.stale).toBe(true);
    const extraPlan = planRun(extra, 'gen', () => null);
    expect(extraPlan.problems.join(' ')).toContain('Перенеси дополнительный текст');
    expect(extraPlan.prompt).not.toContain('An unreviewed change.');
    const manual = node('manual', 'prompt', { text: 'A second prompt.' });
    const mixed = { ...flow, nodes: [...flow.nodes, manual], edges: [...flow.edges, { id: 'mixed', from: manual.id, to: 'gen', port: 'prompt' as const }] };
    expect(planRun(mixed, 'gen', () => null).problems.join(' ')).toContain('один одобренный промпт');
    const legacy = { ...graph(), nodes: [manual, node('gen', 'generator', { modelId: 'higgsfield/soul-2', text: 'Film grain.' })], edges: [{ id: 'legacy', from: manual.id, to: 'gen', port: 'prompt' as const }] };
    expect(planRun(legacy, 'gen', () => null).prompt).toBe('A second prompt.\n\nFilm grain.');
  });

  it('blocks an old approved prompt after the current idea is replaced or its approval is absent', () => {
    const flow = approved();
    const replaced = { ...flow, nodes: flow.nodes.map(n => n.id === 'ai' && n.ai?.idea ? { ...n, ai: { ...n.ai, idea: { ...n.ai.idea, id: 'v-new-idea', text: 'Новая идея.', approval: { ...n.ai.idea.approval!, versionId: 'v-new-idea' } } } } : n) };
    // Server projections can replace the idea without running client invalidation.
    expect(inputFingerprint(replaced, 'ai')).toBe(inputFingerprint(flow, 'ai'));
    expect(planRun(replaced, 'gen', () => null).problems.join(' ')).toContain('прежней версии идеи');
    const unapproved = { ...flow, nodes: flow.nodes.map(n => n.id === 'ai' && n.ai?.idea ? { ...n, ai: { ...n.ai, idea: { ...n.ai.idea, approval: null } } } : n) };
    expect(planRun(unapproved, 'gen', () => null).problems.join(' ')).toContain('идея не одобрена');
    const withoutIdea = { ...flow, nodes: flow.nodes.map(n => n.id === 'ai' && n.ai ? { ...n, ai: { ...n.ai, idea: null } } : n) };
    expect(planRun(withoutIdea, 'gen', () => null).problems.join(' ')).toContain('идея не одобрена');
  });

  it('requires explicit acceptance of the selected generated photo for a new AI video branch', () => {
    const flow = graph();
    const video = { ...flow, nodes: flow.nodes.map(n => n.id === 'gen' ? { ...n, kind: 'video' as const, modelId: 'higgsfield/seedance-2-5' } : n) };
    const photo = node('photo', 'generator', { modelId: 'higgsfield/soul-2', jobIds: ['j-photo'] });
    const withPhoto = { ...video, nodes: [...video.nodes, photo], edges: [...video.edges, { id: 'photo-ai', from: 'photo', to: 'ai', port: 'ref' as const }, { id: 'photo-video', from: 'photo', to: 'gen', port: 'start' as const }] };
    expect(aiInputContext(withPhoto, 'ai', () => 'm-photo').problems.join(' ')).toContain('прими выбранное фото');
    const accepted = { ...withPhoto, nodes: withPhoto.nodes.map(n => n.id === 'photo' ? { ...n, acceptedJobId: 'j-photo', acceptedMediaId: 'm-photo' } : n) };
    expect(aiInputContext(accepted, 'ai', () => 'm-photo').problems).toEqual([]);
    const compiled = approved(accepted);
    expect(planRun(compiled, 'gen', () => 'm-photo').problems).toEqual([]);
    const changed = { ...compiled, nodes: compiled.nodes.map(n => n.id === 'photo' ? { ...n, jobIds: ['j-photo', 'j-other'], selected: 1 } : n) };
    expect(planRun(changed, 'gen', () => 'm-other').problems.join(' ')).toContain('прими выбранное фото');
  });

  it('allows an unaccepted generated character sheet beside the accepted video start photo', () => {
    const base = graph();
    const video = { ...base, nodes: base.nodes.map(n => n.id === 'gen' ? { ...n, kind: 'video' as const, modelId: 'higgsfield/seedance-2-5' } : n) };
    const photo = node('photo', 'generator', { modelId: 'higgsfield/soul-2', jobIds: ['j-photo'], acceptedJobId: 'j-photo', acceptedMediaId: 'm-photo' });
    const sheet = node('sheet', 'generator', { modelId: 'kie/seedream-5-pro', jobIds: ['j-sheet'] });
    const flow = { ...video, nodes: [...video.nodes, photo, sheet], edges: [...video.edges,
      { id: 'photo-ai', from: photo.id, to: 'ai', port: 'ref' as const },
      { id: 'photo-start', from: photo.id, to: 'gen', port: 'start' as const },
      { id: 'sheet-ai', from: sheet.id, to: 'ai', port: 'ref' as const },
    ] };
    const input = aiInputContext(flow, 'ai', jobId => jobId === 'j-photo' ? 'm-photo' : 'm-sheet');
    expect(input.problems).toEqual([]);
    expect(input.refs.map(ref => ref.source)).toEqual([{ type: 'media', mediaId: 'm-photo' }, { type: 'media', mediaId: 'm-sheet' }]);
    const unacceptedStart = { ...flow, nodes: flow.nodes.map(n => n.id === photo.id ? { ...n, acceptedMediaId: null, acceptedJobId: null } : n) };
    expect(aiInputContext(unacceptedStart, 'ai', jobId => jobId === 'j-photo' ? 'm-photo' : 'm-sheet').problems).toEqual(['Сначала прими выбранное фото для видео.']);
  });
});
