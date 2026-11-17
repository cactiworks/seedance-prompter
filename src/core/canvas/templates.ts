import { findModel, paramsFor } from '../gen/models.ts';
import { CanvasNodeSchema, type CanvasEdge, type CanvasNode, type CanvasNodeType, type InputPort } from '../model/canvas.ts';

/**
 * Шаблоны flow (решение 35, «Quick Start» как у Higgsfield): готовая цепочка нод одним кликом. Промпты пустые —
 * их пишет владелец (или переносит из «Промптера»); запуск — по-прежнему по одной ноде, с ценой на кнопке.
 */
export interface FlowTemplate {
  id: string;
  titleRu: string;
  descriptionRu: string;
  build: (newId: (prefix: string) => string) => { nodes: CanvasNode[]; edges: CanvasEdge[] };
}

/** kind — для нод без модели, чей выход зависит от входа (апскейл, «Размер»): должен совпасть с тем, что придёт. */
type Spec = { key: string; type: CanvasNodeType; x: number; y: number; modelId?: string; text?: string; which?: 'first' | 'last'; label?: string; kind?: 'image' | 'video'; targetKey?: string };

/** Ноды по описанию + рёбра по ключам: `[из, в, порт]`. */
function assemble(newId: (prefix: string) => string, specs: Spec[], links: [string, string, InputPort][]): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const ids = new Map(specs.map((s) => [s.key, newId('n')]));
  const nodes = specs.map((s) => {
    const model = s.modelId === undefined ? undefined : findModel(s.modelId);
    return CanvasNodeSchema.parse({
      id: ids.get(s.key),
      type: s.type,
      x: s.x,
      y: s.y,
      text: s.text ?? '',
      label: s.label ?? '',
      kind: s.kind ?? model?.kind ?? 'image',
      modelId: model?.id ?? '',
      params: model === undefined ? {} : paramsFor(model, {}),
      which: s.which ?? 'last',
      targetGeneratorId: s.targetKey === undefined ? null : ids.get(s.targetKey) ?? null,
    });
  });
  const edges = links.map(([from, to, port]) => ({ id: newId('e'), from: ids.get(from) ?? '', to: ids.get(to) ?? '', port }));
  return { nodes, edges };
}

const COL = 360;
const ROW = 420;

/** Empty editable branches. Creating a template never calls AI or media providers. */
function brollBranches(newId: (prefix: string) => string, count: number): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const specs: Spec[] = [{ key: 'common', type: 'comment', x: -COL - 60, y: 0, label: 'Общая концепция и ограничения' }];
  const links: [string, string, InputPort][] = [];
  for (let i = 1; i <= count; i += 1) {
    const y = (i - 1) * 1100;
    const key = (part: string): string => `${part}-${i}`;
    specs.push(
      { key: key('photo-comment'), type: 'comment', x: 0, y, label: `B-roll ${i} · пожелания к фото` },
      { key: key('photo-ai'), type: 'ai', x: COL, y, label: `B-roll ${i} · идея фото`, targetKey: key('photo') },
      { key: key('photo'), type: 'generator', x: COL * 3, y, modelId: 'higgsfield/soul-2', label: `B-roll ${i} · фото` },
      { key: key('video-comment'), type: 'comment', x: COL * 3, y: y + 650, label: `B-roll ${i} · движение и события` },
      { key: key('video-ai'), type: 'ai', x: COL * 4, y, kind: 'video', label: `B-roll ${i} · идея видео`, targetKey: key('video') },
      { key: key('video'), type: 'generator', x: COL * 6, y, modelId: 'higgsfield/seedance-2-5', label: `B-roll ${i} · видео` },
    );
    links.push(
      ['common', key('photo-ai'), 'context'],
      [key('photo-comment'), key('photo-ai'), 'context'],
      ['common', key('video-ai'), 'context'],
      [key('video-comment'), key('video-ai'), 'context'],
      [key('photo'), key('video-ai'), 'ref'],
      [key('photo'), key('video'), 'start'],
    );
  }
  return assemble(newId, specs, links);
}

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [
  {
    id: 'managed-broll',
    titleRu: 'B-roll с AI: фото → видео',
    descriptionRu: 'Comments → идея → prompt → Soul 2 → принятое фото → идея движения → prompt → Seedance. Каждый шаг вручную.',
    build: (newId) => brollBranches(newId, 1),
  },
  {
    id: 'managed-five-broll',
    titleRu: 'Пять B-roll с AI',
    descriptionRu: 'Общая концепция и пять независимых веток Soul 2 → Seedance. Prompts появятся после одобрения идей.',
    build: (newId) => brollBranches(newId, 5),
  },
  {
    id: 'storyboard-seedance',
    titleRu: 'Снять видео по раскадровке',
    descriptionRu: 'Три изображения → Seedance-промптер → видео и апскейл.',
    build: (newId) =>
      assemble(
        newId,
        [
          { key: 'p1', type: 'prompt', x: 0, y: 0 },
          { key: 'i1', type: 'generator', x: COL, y: 0, modelId: 'kie/gpt-image-2-5' },
          { key: 'p2', type: 'prompt', x: 0, y: ROW },
          { key: 'i2', type: 'generator', x: COL, y: ROW, modelId: 'kie/gpt-image-2-5' },
          { key: 'p3', type: 'prompt', x: 0, y: ROW * 2 },
          { key: 'i3', type: 'generator', x: COL, y: ROW * 2, modelId: 'kie/gpt-image-2-5' },
          { key: 'sd', type: 'seedance', x: COL * 2 + 60, y: ROW },
          { key: 'up', type: 'upscale', x: COL * 3 + 120, y: ROW, kind: 'video' },
        ],
        [
          ['p1', 'i1', 'prompt'],
          ['p2', 'i2', 'prompt'],
          ['p3', 'i3', 'prompt'],
          ['i1', 'sd', 'ref'],
          ['i2', 'sd', 'ref'],
          ['i3', 'sd', 'ref'],
          ['sd', 'up', 'media'],
        ],
      ),
  },
  {
    id: 'image-to-video',
    titleRu: 'Создать и оживить изображение',
    descriptionRu: 'Сгенерируй изображение и используй его как первый кадр видео.',
    build: (newId) =>
      assemble(
        newId,
        [
          { key: 'p1', type: 'prompt', x: 0, y: 0 },
          { key: 'img', type: 'generator', x: COL, y: 0, modelId: 'kie/gpt-image-2-5' },
          { key: 'p2', type: 'prompt', x: COL, y: ROW + 120 },
          { key: 'vid', type: 'generator', x: COL * 2 + 40, y: 0, modelId: 'kie/kling-3' },
        ],
        [
          ['p1', 'img', 'prompt'],
          ['img', 'vid', 'start'],
          ['p2', 'vid', 'prompt'],
        ],
      ),
  },
  {
    id: 'clip-chain',
    titleRu: 'Продолжить сцену в клипах',
    descriptionRu: 'Последний кадр клипа станет началом следующего. Клипы сохраняются отдельно.',
    build: (newId) =>
      assemble(
        newId,
        [
          { key: 'p1', type: 'prompt', x: 0, y: 0 },
          { key: 'v1', type: 'generator', x: COL, y: 0, modelId: 'higgsfield/seedance-2-5' },
          { key: 'f1', type: 'frame', x: COL * 2, y: 0, which: 'last' },
          { key: 'p2', type: 'prompt', x: COL * 2, y: ROW },
          { key: 'v2', type: 'generator', x: COL * 3, y: 0, modelId: 'higgsfield/seedance-2-5' },
          { key: 'f2', type: 'frame', x: COL * 4, y: 0, which: 'last' },
          { key: 'p3', type: 'prompt', x: COL * 4, y: ROW },
          { key: 'v3', type: 'generator', x: COL * 5, y: 0, modelId: 'higgsfield/seedance-2-5' },
        ],
        [
          ['p1', 'v1', 'prompt'],
          ['v1', 'f1', 'video'],
          ['f1', 'v2', 'start'],
          ['p2', 'v2', 'prompt'],
          ['v2', 'f2', 'video'],
          ['f2', 'v3', 'start'],
          ['p3', 'v3', 'prompt'],
        ],
      ),
  },
  {
    id: 'character-scenes',
    titleRu: 'Перенести персонажа в сцены',
    descriptionRu: 'Фото → лист персонажа → две сцены с общим референсом внешности.',
    build: (newId) =>
      assemble(
        newId,
        [
          { key: 'photo', type: 'image', x: 0, y: 0, label: 'Фото персонажа' },
          {
            key: 'sheetPrompt',
            type: 'prompt',
            x: 0,
            y: ROW,
            // Раскладка — из шаблона «Лист персонажа» промптера (packs/prompter/templates.json).
            text: 'Character reference sheet of the person in image 1 on a plain light-grey background with even, soft studio light: full-body front, three-quarter, side profile and back views in one row, plus head-and-shoulders close-ups from the front and in profile. The same face, hairstyle, body proportions and outfit in every view; neutral relaxed standing pose; no text or labels.',
          },
          { key: 'sheet', type: 'generator', x: COL, y: 0, modelId: 'kie/seedream-5-pro' },
          { key: 's1Prompt', type: 'prompt', x: COL * 2, y: ROW + 120 },
          { key: 's1', type: 'generator', x: COL * 2 + 40, y: 0, modelId: 'kie/gpt-image-2-5' },
          { key: 's2Prompt', type: 'prompt', x: COL * 3 + 40, y: ROW + 120 },
          { key: 's2', type: 'generator', x: COL * 3 + 80, y: 0, modelId: 'kie/gpt-image-2-5' },
        ],
        [
          ['photo', 'sheet', 'ref'],
          ['sheetPrompt', 'sheet', 'prompt'],
          ['sheet', 's1', 'ref'],
          ['s1Prompt', 's1', 'prompt'],
          ['sheet', 's2', 'ref'],
          ['s2Prompt', 's2', 'prompt'],
        ],
      ),
  },
];
