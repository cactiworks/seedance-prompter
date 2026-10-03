import { describe, expect, it } from 'vitest';
import { flowCost, frameInput, nodeTitle, planRun, sourceKey } from '../../src/core/canvas/plan.ts';
import { nextRefSync, seedanceInputs, type SeedanceInput } from '../../src/core/canvas/seedance.ts';
import { billedSeconds, estimate, findModel, modelsOf, paramsFor, upscaleModelOf, validateGen, type GenModel } from '../../src/core/gen/models.ts';
import { CanvasNodeSchema, dropStaleEdges, forgetMedia, inputsOf, outputOf, type CanvasNode, type Flow } from '../../src/core/model/canvas.ts';

const node = (patch: Partial<CanvasNode> & Pick<CanvasNode, 'id' | 'type'>): CanvasNode => CanvasNodeSchema.parse({ x: 0, y: 0, ...patch });
const flow = (nodes: CanvasNode[], edges: Flow['edges']): Flow => ({ id: 'f-test', name: 't', nodes, edges, viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' });
const mediaOf = (jobId: string): string | null => (jobId === 'j-draft' ? 'm-draft' : jobId === 'j-img' ? 'm-img' : jobId === 'j-up' ? 'm-up' : null);

describe('Topaz Video Upscale в каталоге (решение 39)', () => {
  const topaz = findModel('kie/topaz-video-upscale') as GenModel;

  it('цена по секундам исходника: 1× и 2× — 8 кр/с, 4× — 14 кр/с', () => {
    expect(estimate(topaz, paramsFor(topaz, { upscaleFactor: '2', sourceSec: 5 })).credits).toBe(40);
    expect(estimate(topaz, paramsFor(topaz, { upscaleFactor: '1', sourceSec: 5 })).credits).toBe(40);
    expect(estimate(topaz, paramsFor(topaz, { upscaleFactor: '4', sourceSec: 10 })).credits).toBe(140);
  });

  it('секунды к оплате — вверх, с допуском 0.1 с на контейнер', () => {
    expect(billedSeconds(5.04)).toBe(5);
    expect(billedSeconds(5.2)).toBe(6);
    expect(billedSeconds(0.3)).toBe(1);
  });

  it('инструмент: в выборе моделей видео его нет; без видео не запускается, промпт не нужен', () => {
    expect(modelsOf('video').some((m) => m.id === topaz.id)).toBe(false);
    expect(upscaleModelOf('video').id).toBe(topaz.id);
    expect(upscaleModelOf('image').id).toBe('kie/topaz-upscale');
    expect(validateGen(topaz, '', paramsFor(topaz, {}), [])).toEqual(['Topaz Video Upscale нужно входное видео.']);
    expect(validateGen(topaz, '', paramsFor(topaz, {}), ['ref'])).toEqual([]);
    expect(topaz.input('', paramsFor(topaz, { upscaleFactor: '4' }), [{ url: 'https://kie/v.mp4', role: 'ref' }])).toEqual({ video_url: 'https://kie/v.mp4', upscale_factor: '4' });
  });
});

describe('нода canvas «Апскейл Topaz»', () => {
  const draft = node({ id: 'sd', type: 'seedance', jobIds: ['j-draft'], selected: 0 });
  const up = (patch: Partial<CanvasNode> = {}): CanvasNode => node({ id: 'up', type: 'upscale', kind: 'video', params: { upscaleFactor: '2' }, ...patch });
  const graph = (upNode: CanvasNode): Flow => flow([draft, upNode], [{ id: 'e', from: 'sd', to: 'up', port: 'media' }]);
  const measuredFor = sourceKey({ type: 'media', mediaId: 'm-draft' });

  it('вход «Файл», выход — того же вида, что пришло; в шапке — увеличение', () => {
    expect(inputsOf(up(), [])).toEqual(['media']);
    expect(outputOf(up())).toBe('video');
    expect(outputOf(up({ kind: 'image' }))).toBe('image');
    expect(nodeTitle(up({ params: { upscaleFactor: '4' } }))).toBe('Апскейл Topaz · 4×');
  });

  it('черновик Seedance → Topaz для видео; пока исходник не измерен — запуск закрыт', () => {
    const plan = planRun(graph(up()), 'up', mediaOf);
    expect(plan.modelId).toBe('kie/topaz-video-upscale');
    expect(plan.refs).toEqual([{ label: 'Апскейл', source: { type: 'media', mediaId: 'm-draft' }, role: 'ref' }]);
    expect(plan.problems).toEqual(['Меряю исходник…']);
  });

  it('замер этого входа → цена по его секундам; замер другого входа не годится', () => {
    const ready = planRun(graph(up({ params: { upscaleFactor: '4', sourceSec: 10, measuredFor } })), 'up', mediaOf);
    expect(ready.problems).toEqual([]);
    expect(ready.params).toEqual({ upscaleFactor: '4', sourceSec: 10 });
    expect(ready.estimate?.credits).toBe(140);
    const stale = planRun(graph(up({ params: { upscaleFactor: '2', sourceSec: 10, measuredFor: sourceKey({ type: 'media', mediaId: 'm-old' }) } })), 'up', mediaOf);
    expect(stale.problems).toEqual(['Меряю исходник…']);
  });

  it('без входа — причина, без запуска; черновик без результата — «сначала запусти»', () => {
    expect(planRun(flow([up()], []), 'up', mediaOf).problems[0]).toContain('Подключи ко входу «Файл»');
    const noRun = flow([node({ id: 'sd', type: 'seedance' }), up()], [{ id: 'e', from: 'sd', to: 'up', port: 'media' }]);
    expect(planRun(noRun, 'up', mediaOf).problems[0]).toContain('Сначала запусти');
  });

  it('апскейл картинки идёт дальше: в генератор рефом и в панель Seedance-промптера; видео в реф — нельзя', () => {
    const img = node({ id: 'g', type: 'generator', kind: 'image', modelId: 'kie/gpt-image-2-5', jobIds: ['j-img'] });
    const upImg = up({ kind: 'image', jobIds: ['j-up'], selected: 0 });
    const next = node({ id: 'g2', type: 'generator', kind: 'image', modelId: 'kie/gpt-image-2-5', text: 'Same shot, dusk.' });
    const sd = node({ id: 'sd2', type: 'seedance' });
    const f = flow([img, upImg, next, sd], [
      { id: 'e1', from: 'g', to: 'up', port: 'media' },
      { id: 'e2', from: 'up', to: 'g2', port: 'ref' },
      { id: 'e3', from: 'up', to: 'sd2', port: 'ref' },
    ]);
    expect(planRun(f, 'g2', mediaOf).refs).toEqual([{ label: 'Апскейл Topaz · 2×', source: { type: 'media', mediaId: 'm-up' }, role: 'ref' }]);
    expect(seedanceInputs(f, 'sd2', (jobId) => ({ mediaId: mediaOf(jobId), prompt: '' })).inputs.map((i) => i.source)).toEqual([{ type: 'media', mediaId: 'm-up' }]);
    const upVid = up({ jobIds: ['j-up'] });
    const vf = flow([draft, upVid, next], [
      { id: 'e1', from: 'sd', to: 'up', port: 'media' },
      { id: 'e2', from: 'up', to: 'g2', port: 'ref' },
    ]);
    expect(planRun(vf, 'g2', mediaOf).problems.join(' ')).toContain('видео на вход генератора пока не подаётся');
  });

  it('сумма flow включает апскейл по последнему замеру', () => {
    expect(flowCost(graph(up({ params: { upscaleFactor: '2', sourceSec: 10, measuredFor } })))).toEqual({ credits: 80, usd: 0.4 });
  });
});

describe('находки ревью PR #1', () => {
  it('«Размер» сменил вид на видео — связь во вход картинки снимается, остальные остаются', () => {
    const resize = node({ id: 'rs', type: 'resize', kind: 'video' });
    const g = node({ id: 'g', type: 'generator', kind: 'image', modelId: 'kie/gpt-image-2-5' });
    const fr = node({ id: 'fr', type: 'frame' });
    const f = flow([resize, g, fr], [
      { id: 'to-ref', from: 'rs', to: 'g', port: 'ref' },
      { id: 'to-frame', from: 'rs', to: 'fr', port: 'video' },
    ]);
    expect(dropStaleEdges(f, 'rs').edges.map((e) => e.id)).toEqual(['to-frame']);
    expect(dropStaleEdges(f, 'g')).toBe(f);
  });

  it('импортированный flow со старой связью: видео во вход картинки и картинка во вход «Видео» — причина, не запуск', () => {
    const resize = node({ id: 'rs', type: 'resize', kind: 'video', mediaId: 'm-vid' });
    const g = node({ id: 'g', type: 'generator', kind: 'image', modelId: 'kie/gpt-image-2-5', text: 'x' });
    const plan = planRun(flow([resize, g], [{ id: 'e', from: 'rs', to: 'g', port: 'ref' }]), 'g', mediaOf);
    expect(plan.refs).toEqual([]);
    expect(plan.problems.join(' ')).toContain('отдаёт видео');
    const img = node({ id: 'ri', type: 'resize', kind: 'image', mediaId: 'm-img' });
    const fr = node({ id: 'fr', type: 'frame' });
    expect(frameInput(flow([img, fr], [{ id: 'e', from: 'ri', to: 'fr', port: 'video' }]), 'fr', mediaOf)).toEqual({ mediaId: null, problemRu: '«Размер · 1080×1920» отдаёт картинку, а сюда нужно видео.' });
  });

  it('удалённый файл библиотеки уходит из нод: файл ноды и картинка-источник', () => {
    const f = flow([node({ id: 'v', type: 'video', mediaId: 'm-del' }), node({ id: 'i', type: 'image', source: { type: 'media', mediaId: 'm-del' } }), node({ id: 'k', type: 'image', source: { type: 'media', mediaId: 'm-keep' } })], []);
    const next = forgetMedia(f, ['m-del']);
    expect(next.nodes.map((n) => [n.mediaId, n.source])).toEqual([[null, null], [null, null], [null, { type: 'media', mediaId: 'm-keep' }]]);
    expect(forgetMedia(f, ['m-other'])).toBe(f);
  });

  it('отпечаток снятого проводка остаётся, пока его референс в черновике: вернёшь ту же картинку — не перезальётся', () => {
    const input = (key: string, signature: string): SeedanceInput => ({ nodeId: key, key, label: key, source: { type: 'media', mediaId: signature }, signature, kind: 'frame', note: null });
    const previous = { 'cv-a': 'sig-a', 'cv-b': 'sig-b', 'cv-gone': 'sig-g' };
    // Проводок к «b» снят, «gone» удалён из черновика, «c» новый и не залился.
    expect(nextRefSync(previous, [input('cv-a', 'sig-a2'), input('cv-c', 'sig-c')], new Set(['cv-c']), ['cv-a', 'cv-b', 'cv-c'])).toEqual({ 'cv-a': 'sig-a2', 'cv-b': 'sig-b' });
  });
});
