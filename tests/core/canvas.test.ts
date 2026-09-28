import { describe, expect, it } from 'vitest';
import { flowCost, frameInput, planRun, wouldCycle } from '../../src/core/canvas/plan.ts';
import { paramsFor, findModel } from '../../src/core/gen/models.ts';
import { CanvasNodeSchema, inputsOf, portAccepts, type CanvasNode, type Flow } from '../../src/core/model/canvas.ts';

const node = (patch: Partial<CanvasNode> & Pick<CanvasNode, 'id' | 'type'>): CanvasNode => CanvasNodeSchema.parse({ x: 0, y: 0, ...patch });
const gen = (id: string, modelId: string, patch: Partial<CanvasNode> = {}): CanvasNode => {
  const m = findModel(modelId);
  return node({ id, type: 'generator', kind: m?.kind ?? 'image', modelId, params: m === undefined ? {} : paramsFor(m, {}), ...patch });
};
const flow = (nodes: CanvasNode[], edges: Flow['edges']): Flow => ({ id: 'f-test', name: 't', nodes, edges, viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' });

describe('canvas: что уйдёт в модель при запуске ноды', () => {
  const graph = flow(
    [
      node({ id: 'p1', type: 'prompt', text: 'A woman in a red coat.' }),
      node({ id: 'p2', type: 'prompt', text: 'Rainy street, night.' }),
      node({ id: 'img', type: 'image', source: { type: 'upload', uploadId: 'u-abc123' }, label: 'Лицо' }),
      gen('g1', 'kie/gpt-image-2-5', { text: 'Film grain.' }),
      gen('g2', 'kie/seedance-2-5'),
    ],
    [
      { id: 'e1', from: 'p1', to: 'g1', port: 'prompt' },
      { id: 'e2', from: 'p2', to: 'g1', port: 'prompt' },
      { id: 'e3', from: 'img', to: 'g1', port: 'ref' },
      { id: 'e4', from: 'g1', to: 'g2', port: 'start' },
      { id: 'e5', from: 'p1', to: 'g2', port: 'prompt' },
    ],
  );

  it('промпты входов по порядку рёбер + свой текст ноды; картинка — с ролью', () => {
    const plan = planRun(graph, 'g1', () => null);
    expect(plan.prompt).toBe('A woman in a red coat.\n\nRainy street, night.\n\nFilm grain.');
    expect(plan.refs).toEqual([{ label: 'Лицо', source: { type: 'upload', uploadId: 'u-abc123' }, role: 'ref' }]);
    expect(plan.problems).toEqual([]);
    expect(plan.estimate?.credits).toBe(6);
  });

  it('генератор выше без результата — запуск запрещён, сам он не стартует', () => {
    const plan = planRun(graph, 'g2', () => null);
    expect(plan.problems.join(' ')).toContain('Сначала запусти');
  });

  it('выбранный вариант генератора выше идёт дальше как файл библиотеки', () => {
    const withRuns = flow(
      graph.nodes.map((n) => (n.id === 'g1' ? { ...n, jobIds: ['j-1', 'j-2'], selected: 1 } : n)),
      graph.edges,
    );
    const plan = planRun(withRuns, 'g2', (jobId) => (jobId === 'j-2' ? 'm-second' : 'm-first'));
    expect(plan.refs).toEqual([{ label: 'Картинка · GPT Image 2.5', source: { type: 'media', mediaId: 'm-second' }, role: 'start' }]);
    expect(plan.problems).toEqual([]);
  });

  it('пустая нода картинки — проблема до отправки', () => {
    const empty = flow([node({ id: 'img', type: 'image' }), gen('g', 'kie/gpt-image-2-5', { text: 'x' })], [{ id: 'e', from: 'img', to: 'g', port: 'ref' }]);
    expect(planRun(empty, 'g', () => null).problems.join(' ')).toContain('нет картинки');
  });

  it('цена flow — сумма по одному запуску генераторов', () => {
    expect(flowCost(graph)).toEqual({ credits: 321, usd: 1.605 });
  });

  it('цикл не допускается', () => {
    expect(wouldCycle(graph, 'g2', 'g1')).toBe(true);
    expect(wouldCycle(graph, 'p2', 'g2')).toBe(false);
  });
});

describe('canvas: кадр из видео склеивает клипы', () => {
  const flowWithFrame = (mediaId: string | null) =>
    flow(
      [gen('v1', 'kie/seedance-2-5', { jobIds: ['j-v1'] }), node({ id: 'fr', type: 'frame', which: 'last', mediaId }), gen('v2', 'kie/kling-3', { text: 'Continue the motion.' })],
      [
        { id: 'e1', from: 'v1', to: 'fr', port: 'video' },
        { id: 'e2', from: 'fr', to: 'v2', port: 'start' },
      ],
    );

  it('вход «Видео» — выбранный вариант генератора видео', () => {
    expect(frameInput(flowWithFrame(null), 'fr', () => 'm-video')).toEqual({ mediaId: 'm-video', problemRu: null });
    expect(frameInput(flowWithFrame(null), 'fr', () => null).problemRu).toContain('нет готового видео');
  });

  it('кадр не извлечён — следующий клип не запускается; извлечён — идёт старт-кадром', () => {
    expect(planRun(flowWithFrame(null), 'v2', () => null).problems.join(' ')).toContain('Сначала извлеки кадр');
    const plan = planRun(flowWithFrame('m-frame'), 'v2', () => null);
    expect(plan.refs).toEqual([{ label: 'Последний кадр видео', source: { type: 'media', mediaId: 'm-frame' }, role: 'start' }]);
    expect(plan.problems).toEqual([]);
  });

  it('типы портов: видео только во вход «Видео», картинки — в ref / start / end', () => {
    expect(portAccepts('video', 'video')).toBe(true);
    expect(portAccepts('start', 'video')).toBe(false);
    expect(portAccepts('video', 'image')).toBe(false);
    expect(portAccepts('start', 'image')).toBe(true);
    expect(inputsOf(node({ id: 'f', type: 'frame' }), [])).toEqual(['video']);
    expect(inputsOf(gen('g', 'kie/seedance-2-5'), findModel('kie/seedance-2-5')?.refs.roles ?? [])).toEqual(['prompt', 'ref', 'start', 'end']);
  });
});
