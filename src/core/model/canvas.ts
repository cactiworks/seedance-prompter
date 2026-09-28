import { z } from 'zod';
import { GenParamsSchema, RefSourceSchema } from './media.ts';

/**
 * Canvas — нодовый граф в духе connxn. Ноды: промпт, картинка (загрузка / библиотека), генератор
 * картинки или видео. Рёбра идут из выхода ноды во вход генератора: prompt, ref, start, end.
 * Запуск — только выбранного генератора; ниже по графу ничего само не запускается (это деньги).
 */
export const CANVAS_NODE_TYPES = ['prompt', 'image', 'generator', 'frame'] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

/** video — вход ноды «Кадр из видео»: принимает результат генератора видео. */
export const INPUT_PORTS = ['prompt', 'ref', 'start', 'end', 'video'] as const;
export type InputPort = (typeof INPUT_PORTS)[number];

export const CanvasNodeSchema = z.object({
  id: z.string(),
  type: z.enum(CANVAS_NODE_TYPES),
  x: z.number(),
  y: z.number(),
  /** prompt */
  text: z.string().default(''),
  /** image */
  source: RefSourceSchema.nullable().default(null),
  label: z.string().default(''),
  /** generator */
  kind: z.enum(['image', 'video']).default('image'),
  modelId: z.string().default(''),
  params: GenParamsSchema.default({}),
  /** Запуски ноды по порядку; выбранный вариант уходит дальше по графу. */
  jobIds: z.array(z.string()).default([]),
  selected: z.number().int().default(0),
  /** frame: какой кадр взять из видео и извлечённый файл библиотеки. Локально через ffmpeg, бесплатно. */
  which: z.enum(['first', 'last']).default('last'),
  mediaId: z.string().nullable().default(null),
});
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;

export const CanvasEdgeSchema = z.object({ id: z.string(), from: z.string(), to: z.string(), port: z.enum(INPUT_PORTS) });
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;

export const FlowSchema = z.object({
  id: z.string(),
  name: z.string(),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).default({ x: 0, y: 0, zoom: 1 }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Flow = z.infer<typeof FlowSchema>;

/** Какие входы принимает нода. Промпт и картинка входов не имеют. */
export function inputsOf(node: CanvasNode, roles: readonly string[]): InputPort[] {
  if (node.type === 'frame') return ['video'];
  if (node.type !== 'generator') return [];
  return ['prompt', ...INPUT_PORTS.filter((p) => p !== 'prompt' && p !== 'video' && roles.includes(p))];
}

/** Что отдаёт нода: текст, картинку или видео. */
export const outputOf = (node: CanvasNode): 'text' | 'image' | 'video' => (node.type === 'prompt' ? 'text' : node.type === 'generator' && node.kind === 'video' ? 'video' : 'image');

/** Промпт — только во вход prompt, видео — только во вход video, картинки — в ref / start / end. */
export const portAccepts = (port: InputPort, output: 'text' | 'image' | 'video'): boolean => (port === 'prompt' ? output === 'text' : port === 'video' ? output === 'video' : output === 'image');
