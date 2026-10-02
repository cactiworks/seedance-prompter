import { describe, expect, it } from 'vitest';
import { flowCost, frameInput, mediaInput, planRun, trimProblems, wouldCycle } from '../../src/core/canvas/plan.ts';
import { FLOW_TEMPLATES } from '../../src/core/canvas/templates.ts';
import { paramsFor, findModel } from '../../src/core/gen/models.ts';
import { CanvasNodeSchema, inputsOf, outputOf, portAccepts, seedanceSlug, type CanvasNode, type Flow } from '../../src/core/model/canvas.ts';
import { applySeedanceInputs, cloneSeedance, inputsToUpload, seedanceInputs, seedanceSummary } from '../../src/core/canvas/seedance.ts';
import { newProject } from '../../src/core/model/project.ts';

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
    // GPT Image 6 кр + Seedance 5 с в 480p по умолчанию (решение 38) 140 кр.
    expect(flowCost(graph)).toEqual({ credits: 146, usd: 0.73 });
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

describe('canvas: обрезка видео и шаблоны (решение 35)', () => {
  it('обрезка: вход «Видео», выход — видео; кадр берёт видео у обрезки, если она уже сделана', () => {
    const trim = CanvasNodeSchema.parse({ id: 't', type: 'trim', x: 0, y: 0 });
    expect(inputsOf(trim, [])).toEqual(['video']);
    expect(outputOf(trim)).toBe('video');
    const frame = CanvasNodeSchema.parse({ id: 'f', type: 'frame', x: 0, y: 0 });
    const flow = { id: 'x', name: 'x', nodes: [trim, frame], edges: [{ id: 'e', from: 't', to: 'f', port: 'video' as const }], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' };
    expect(frameInput(flow, 'f', () => null).problemRu).toContain('Сначала обрежь видео');
    expect(frameInput({ ...flow, nodes: [{ ...trim, mediaId: 'm-cut' }, frame] }, 'f', () => null)).toEqual({ mediaId: 'm-cut', problemRu: null });
  });

  it('отрезок: конец 0 — до конца; конец раньше начала и выход за видео — сообщения', () => {
    expect(trimProblems(1, 0, 5)).toEqual([]);
    expect(trimProblems(2, 1.5, 5)[0]).toContain('позже начала');
    expect(trimProblems(6, 0, 5)[0]).toContain('Начало за концом');
    expect(trimProblems(0, 7, 5)[0]).toContain('Конец за концом');
  });

  it('шаблоны: ноды с моделями по умолчанию, связи проходят проверку портов и циклов', () => {
    let n = 0;
    for (const t of FLOW_TEMPLATES) {
      const { nodes, edges } = t.build((p) => `${p}${(n += 1)}`);
      const flow = { id: t.id, name: t.titleRu, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' };
      for (const e of edges) {
        const from = nodes.find((x) => x.id === e.from);
        const to = nodes.find((x) => x.id === e.to);
        expect(from && to, `${t.id}: связь ${e.id}`).toBeTruthy();
        if (from === undefined || to === undefined) continue;
        expect(portAccepts(e.port, outputOf(from)), `${t.id}: ${from.type} → ${e.port}`).toBe(true);
        expect(inputsOf(to, findModel(to.modelId)?.refs.roles ?? []), `${t.id}: у ${to.type} есть вход ${e.port}`).toContain(e.port);
        // Апскейл и «Размер» отдают то, что получили: вид ноды в шаблоне должен совпасть с выходом источника.
        if (e.port === 'media') expect(to.kind, `${t.id}: вид ${to.type}`).toBe(outputOf(from));
        expect(wouldCycle({ ...flow, edges: edges.filter((x) => x.id !== e.id) }, e.from, e.to)).toBe(false);
      }
      for (const node of nodes.filter((x) => x.type === 'generator')) expect(findModel(node.modelId), `${t.id}: модель`).toBeDefined();
    }
  });
});

describe('canvas: своё видео (решение 36)', () => {
  it('нода «Видео» без входов отдаёт видео; кадр и обрезка берут её файл', () => {
    const video = CanvasNodeSchema.parse({ id: 'v', type: 'video', x: 0, y: 0 });
    expect(inputsOf(video, [])).toEqual([]);
    expect(outputOf(video)).toBe('video');
    const frame = CanvasNodeSchema.parse({ id: 'f', type: 'frame', x: 0, y: 0 });
    const f = { id: 'x', name: 'x', nodes: [video, frame], edges: [{ id: 'e', from: 'v', to: 'f', port: 'video' as const }], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' };
    expect(frameInput(f, 'f', () => null).problemRu).toContain('Выбери видео');
    expect(frameInput({ ...f, nodes: [{ ...video, mediaId: 'm-own' }, frame] }, 'f', () => null).mediaId).toBe('m-own');
  });
});

describe('canvas: «Размер» (решение 36)', () => {
  it('вход «Файл» берёт картинку и видео, но не текст; выход — того же вида, что вход', () => {
    expect(portAccepts('media', 'image')).toBe(true);
    expect(portAccepts('media', 'video')).toBe(true);
    expect(portAccepts('media', 'text')).toBe(false);
    const resize = CanvasNodeSchema.parse({ id: 'r', type: 'resize', x: 0, y: 0 });
    expect(inputsOf(resize, [])).toEqual(['media']);
    expect(outputOf(resize)).toBe('image');
    expect(outputOf({ ...resize, kind: 'video' })).toBe('video');
  });

  it('источник: картинка с диска, выбранный вариант генератора, своё видео; нет файла — причина', () => {
    const img = CanvasNodeSchema.parse({ id: 'i', type: 'image', x: 0, y: 0, source: { type: 'upload', uploadId: 'u-abc123def' } });
    const vid = CanvasNodeSchema.parse({ id: 'v', type: 'video', x: 0, y: 0, mediaId: 'm-own' });
    const resize = CanvasNodeSchema.parse({ id: 'r', type: 'resize', x: 0, y: 0 });
    const f = (from: CanvasNode) => flow([from, resize], [{ id: 'e', from: from.id, to: 'r', port: 'media' }]);
    expect(mediaInput(f(img), 'r', () => null)).toEqual({ source: { type: 'upload', uploadId: 'u-abc123def' }, kind: 'image', problemRu: null });
    expect(mediaInput(f(vid), 'r', () => null)).toEqual({ source: { type: 'media', mediaId: 'm-own' }, kind: 'video', problemRu: null });
    const g = gen('g', 'kie/gpt-image-2-5', { jobIds: ['j1'] });
    expect(mediaInput(f(g), 'r', () => null).problemRu).toContain('Сначала запусти');
    expect(mediaInput(f(g), 'r', (id) => (id === 'j1' ? 'm-gen' : null)).source).toEqual({ type: 'media', mediaId: 'm-gen' });
    expect(mediaInput(flow([resize], []), 'r', () => null).problemRu).toContain('Подключи');
  });
});

describe('canvas: Seedance-промптер (решение 37)', () => {
  const sd = node({ id: 'sd', type: 'seedance' });
  const upload = node({ id: 'nUp', type: 'image', source: { type: 'upload', uploadId: 'u-abc123def' }, label: 'Лицо' });
  const shotA = gen('nA', 'kie/gpt-image-2-5', { jobIds: ['jA'] });
  const shotB = gen('nB', 'kie/gpt-image-2-5');
  const clip = gen('nV', 'kie/kling-3', { jobIds: ['jV'] });
  const graph = flow(
    [sd, upload, shotA, shotB, clip],
    [
      { id: 'e1', from: 'nUp', to: 'sd', port: 'ref' },
      { id: 'e2', from: 'nA', to: 'sd', port: 'ref' },
      { id: 'e3', from: 'nB', to: 'sd', port: 'ref' },
      { id: 'e4', from: 'nV', to: 'sd', port: 'ref' },
    ],
  );
  const jobs: Record<string, { mediaId: string | null; prompt: string }> = { jA: { mediaId: 'm-a', prompt: 'A man in a grey hoodie at dawn.' }, jV: { mediaId: 'm-v', prompt: 'clip' } };
  const lookup = (id: string) => jobs[id] ?? null;

  it('вход один — «Рефы», много картинок; выход — видео: в «Кадр», «Обрезку» и «Размер»', () => {
    expect(inputsOf(sd, [])).toEqual(['ref']);
    expect(outputOf(sd)).toBe('video');
    const frame = node({ id: 'fr', type: 'frame' });
    const withRun = flow([{ ...sd, jobIds: ['j1'] }, frame], [{ id: 'e', from: 'sd', to: 'fr', port: 'video' }]);
    expect(frameInput(withRun, 'fr', (id) => (id === 'j1' ? 'm-clip' : null))).toEqual({ mediaId: 'm-clip', problemRu: null });
    const resize = node({ id: 'r', type: 'resize' });
    expect(mediaInput(flow([{ ...sd, jobIds: ['j1'] }, resize], [{ id: 'e', from: 'sd', to: 'r', port: 'media' }]), 'r', () => 'm-clip')).toEqual({ source: { type: 'media', mediaId: 'm-clip' }, kind: 'video', problemRu: null });
    const g = gen('g', 'kie/gpt-image-2-5', { text: 'x' });
    expect(planRun(flow([sd, g], [{ id: 'e', from: 'sd', to: 'g', port: 'ref' }]), 'g', () => null).problems.join(' ')).toContain('видео на вход генератора');
  });

  it('входы по порядку проводков: своя картинка — «Другое», сгенерированная — кадр раскадровки с промптом; без результата и видео — причины', () => {
    const { inputs, problems } = seedanceInputs(graph, 'sd', lookup);
    // Сгенерированный кадр подписан началом своего промпта — так кадры различимы в панели и в выборе у шота.
    expect(inputs.map((i) => [i.key, i.kind, i.label])).toEqual([
      ['cv-nup', 'other', 'Лицо'],
      ['cv-na', 'frame', 'A man in a grey hoodie at dawn.'],
    ]);
    expect(inputs[1]?.source).toEqual({ type: 'media', mediaId: 'm-a' });
    expect(inputs[1]?.note).toBe('A man in a grey hoodie at dawn.');
    expect(problems.join(' ')).toContain('ещё без результата');
    expect(problems.join(' ')).toContain('видео в панель');
  });

  it('одинаковые подписи различаются номером', () => {
    const twin = gen('nA2', 'kie/gpt-image-2-5', { jobIds: ['jA'] });
    const { inputs } = seedanceInputs(flow([sd, shotA, twin], [{ id: 'a', from: 'nA', to: 'sd', port: 'ref' }, { id: 'b', from: 'nA2', to: 'sd', port: 'ref' }]), 'sd', lookup);
    expect(inputs.map((i) => i.label)).toEqual(['A man in a grey hoodie at dawn.', 'A man in a grey hoodie at dawn. · 2']);
    const long = { jA: { mediaId: 'm-a', prompt: 'Wide shot: a grey hoodie lies on the passenger seat of a white car, morning sun.' } };
    const labelled = seedanceInputs(flow([sd, shotA], [{ id: 'a', from: 'nA', to: 'sd', port: 'ref' }]), 'sd', (id) => long[id as 'jA'] ?? null);
    expect(labelled.inputs[0]?.label).toBe('Wide shot: a grey hoodie lies on the…');
  });

  it('перезаливать только новое и изменённое', () => {
    const { inputs } = seedanceInputs(graph, 'sd', lookup);
    const project = newProject('cv-sd', 'Canvas');
    expect(inputsToUpload(inputs, {}, project).map((i) => i.key)).toEqual(['cv-nup', 'cv-na']);
    const synced = Object.fromEntries(inputs.map((i) => [i.key, i.signature]));
    const withFiles = { ...project, refs: inputs.map((i) => ({ key: i.key, label: i.label, kind: i.kind, file: `${i.key}.png`, flags: { hasPeople: false, hasText: false, studioBackdrop: false } })) };
    expect(inputsToUpload(inputs, synced, withFiles)).toEqual([]);
    expect(inputsToUpload(inputs, { ...synced, 'cv-na': '{"type":"media","mediaId":"m-old"}' }, withFiles).map((i) => i.key)).toEqual(['cv-na']);
  });

  it('панель по входам: новое — в конец, тип и порядок владельца не трогаются, снятый проводок уходит из панели', () => {
    const { inputs } = seedanceInputs(graph, 'sd', lookup);
    const project = newProject('cv-sd', 'Canvas');
    const shotId = project.shots[0]?.id ?? '';
    const first = applySeedanceInputs(project, shotId, inputs, { 'cv-nup': 'cv-nup.png?v=1', 'cv-na': 'cv-na.png?v=1' }, []);
    expect(first.shots[0]?.panel).toEqual(['cv-nup', 'cv-na']);
    expect(first.refs.find((r) => r.key === 'cv-na')).toMatchObject({ kind: 'frame', file: 'cv-na.png?v=1', note: 'A man in a grey hoodie at dawn.' });

    // Владелец сделал «Лицо» героем и поставил кадр первым, отметил флаги.
    const owned = { ...first, refs: first.refs.map((r) => (r.key === 'cv-nup' ? { ...r, kind: 'character' as const, flags: { hasPeople: true, hasText: false, studioBackdrop: false } } : r)), shots: first.shots.map((s) => ({ ...s, panel: ['cv-na', 'cv-nup'] })) };
    // Новый вариант генератора — новый файл, флаги сброшены; «Лицо» не перезаливалось — тип и флаги на месте.
    const again = applySeedanceInputs(owned, shotId, inputs, { 'cv-na': 'cv-na.png?v=2' }, ['cv-nup', 'cv-na']);
    expect(again.shots[0]?.panel).toEqual(['cv-na', 'cv-nup']);
    expect(again.refs.find((r) => r.key === 'cv-nup')).toMatchObject({ kind: 'character', flags: { hasPeople: true } });
    expect(again.refs.find((r) => r.key === 'cv-na')?.file).toBe('cv-na.png?v=2');

    // Проводок «Лица» сняли — из панели ушло, запись осталась; кадр, привязанный к отрезку, снимается вместе с картинкой.
    const framed = { ...again, shots: again.shots.map((s) => ({ ...s, segments: s.segments.map((seg) => ({ ...seg, frameRef: 'cv-na' })) })) };
    const unplugged = applySeedanceInputs(framed, shotId, inputs.filter((i) => i.key !== 'cv-nup' && i.key !== 'cv-na'), {}, ['cv-nup', 'cv-na']);
    expect(unplugged.shots[0]?.panel).toEqual([]);
    expect(unplugged.refs.map((r) => r.key)).toEqual(['cv-nup', 'cv-na']);
    expect(unplugged.shots[0]?.segments.every((s) => s.frameRef === null)).toBe(true);
  });

  it('копия ноды получает копию черновика, а не тот же ролик; подпись ноды — коротко', () => {
    expect(cloneSeedance({ ...sd, slug: 'cv-sd', shotId: 'shot-1', refSync: { a: 'b' } })).toEqual({ slug: '', shotId: '', copyFrom: 'cv-sd', refSync: {} });
    expect(cloneSeedance({ ...sd, slug: '', copyFrom: 'cv-orig' }).copyFrom).toBe('cv-orig');
    expect(cloneSeedance(shotA)).toEqual({});
    expect(seedanceSlug('nMfz3K')).toBe('cv-nmfz3k');
    expect(seedanceSummary({ shootingRu: 'Стедикам · гимбал', kitRu: 'ARRI Alexa 35 + Cooke S4/i', durationSec: 15, aspect: '9:16', shots: 3, cuts: true, synopsisRu: '  Герой   идёт к пикапу. ' })).toBe('Стедикам · гимбал · ARRI Alexa 35 + Cooke S4/i · 15 с · 9:16 · 3 шота\nГерой идёт к пикапу.');
  });
});
