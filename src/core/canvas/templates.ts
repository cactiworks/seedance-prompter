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

type Spec = { key: string; type: CanvasNodeType; x: number; y: number; modelId?: string; text?: string; which?: 'first' | 'last'; label?: string };

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
      kind: model?.kind ?? 'image',
      modelId: model?.id ?? '',
      params: model === undefined ? {} : paramsFor(model, {}),
      which: s.which ?? 'last',
    });
  });
  const edges = links.map(([from, to, port]) => ({ id: newId('e'), from: ids.get(from) ?? '', to: ids.get(to) ?? '', port }));
  return { nodes, edges };
}

const COL = 360;
const ROW = 420;

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [
  {
    id: 'image-to-video',
    titleRu: 'Картинка → видео',
    descriptionRu: 'Кадр в GPT Image 2.5, затем он же — стартовый кадр ролика Kling 3.0.',
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
    titleRu: 'Сцена из клипов',
    descriptionRu: 'Три клипа Seedance 2.5 подряд: последний кадр каждого — старт следующего, сцена склеивается.',
    build: (newId) =>
      assemble(
        newId,
        [
          { key: 'p1', type: 'prompt', x: 0, y: 0 },
          { key: 'v1', type: 'generator', x: COL, y: 0, modelId: 'kie/seedance-2-5' },
          { key: 'f1', type: 'frame', x: COL * 2, y: 0, which: 'last' },
          { key: 'p2', type: 'prompt', x: COL * 2, y: ROW },
          { key: 'v2', type: 'generator', x: COL * 3, y: 0, modelId: 'kie/seedance-2-5' },
          { key: 'f2', type: 'frame', x: COL * 4, y: 0, which: 'last' },
          { key: 'p3', type: 'prompt', x: COL * 4, y: ROW },
          { key: 'v3', type: 'generator', x: COL * 5, y: 0, modelId: 'kie/seedance-2-5' },
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
    titleRu: 'Персонаж → сцены',
    descriptionRu: 'Фото человека → лист персонажа в Seedream 5 Pro → две сцены с ним в GPT Image 2.5 по листу.',
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
