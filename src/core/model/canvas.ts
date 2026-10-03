import { z } from 'zod';
import { GenParamsSchema, RefSourceSchema } from './media.ts';

/**
 * Canvas — нодовый граф в духе connxn. Ноды: промпт, картинка (загрузка / библиотека), генератор
 * картинки или видео. Рёбра идут из выхода ноды во вход генератора: prompt, ref, start, end.
 * Запуск — только выбранного генератора; ниже по графу ничего само не запускается (это деньги).
 */
/**
 * video — своё видео из библиотеки (съёмка или прошлая генерация) как вход цепочки.
 * seedance — Seedance-промптер: полный конструктор «Кадров» во весь экран. У ноды свой черновик-ролик
 * (data/projects/cv-<id>), картинки входа «Рефы» становятся панелью кадра, выход — сгенерированное видео.
 * upscale — апскейл Topaz (решение 39): картинка или видео на входе «Файл», выход того же вида; запуск платный, с гейтом.
 */
export const CANVAS_NODE_TYPES = ['prompt', 'image', 'generator', 'frame', 'trim', 'video', 'resize', 'seedance', 'upscale'] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

/** video — вход ноды «Кадр из видео»: принимает результат генератора видео. media — вход «Размера»: картинка или видео. */
export const INPUT_PORTS = ['prompt', 'ref', 'start', 'end', 'video', 'media'] as const;
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
  /** frame, trim, video: файл библиотеки (кадр, обрезанное видео, своё видео). */
  mediaId: z.string().nullable().default(null),
  /** trim: отрезок в секундах от начала; end 0 — до конца. */
  start: z.number().min(0).default(0),
  end: z.number().min(0).default(0),
  /** resize: целевой размер и как вписать; kind — что пришло на вход (картинка или видео), от него зависит выход. */
  width: z.number().int().min(16).max(8192).default(1080),
  height: z.number().int().min(16).max(8192).default(1920),
  fit: z.enum(['cover', 'contain']).default('cover'),
  /** seedance: черновик-ролик ноды и кадр в нём. Пусто — черновика ещё нет, он создаётся при первом открытии. */
  slug: z.string().default(''),
  shotId: z.string().default(''),
  /** seedance: копия ноды (⌘D, ⌘C/⌘V) при первом открытии получает копию черновика этого ролика. */
  copyFrom: z.string().default(''),
  /** seedance: какая картинка входа лежит в панели — чтобы не перезаливать неизменённые (ключ референса → источник). */
  refSync: z.record(z.string(), z.string()).default({}),
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
  if (node.type === 'frame' || node.type === 'trim') return ['video'];
  if (node.type === 'resize' || node.type === 'upscale') return ['media'];
  // Seedance-промптер берёт сколько угодно картинок (модель — до 30): каждая становится картинкой панели.
  if (node.type === 'seedance') return ['ref'];
  if (node.type !== 'generator') return [];
  return ['prompt', ...INPUT_PORTS.filter((p) => p !== 'prompt' && p !== 'video' && roles.includes(p))];
}

/** Что отдаёт нода: текст, картинку или видео. Обрезка отдаёт видео — его можно резать дальше и брать из него кадр. */
export const outputOf = (node: CanvasNode): 'text' | 'image' | 'video' =>
  node.type === 'prompt' ? 'text' : node.type === 'trim' || node.type === 'video' || node.type === 'seedance' || ((node.type === 'generator' || node.type === 'resize' || node.type === 'upscale') && node.kind === 'video') ? 'video' : 'image';

/** Ноды, выход которых — выбранный вариант запусков (`jobIds[selected]`): генератор, Seedance-промптер, апскейл. */
export const isJobNode = (node: CanvasNode): boolean => node.type === 'generator' || node.type === 'seedance' || node.type === 'upscale';

/** Черновик-ролик Seedance-промптера: слаг проекта по id ноды (латиница, цифры — подходит под слаг). */
export const seedanceSlug = (nodeId: string): string => `cv-${nodeId.toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 64);
/** Ключ референса панели для картинки, пришедшей проводком: по id ноды-источника. */
export const canvasRefKey = (sourceNodeId: string): string => `cv-${sourceNodeId.toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 60);
export const isCanvasRefKey = (key: string): boolean => key.startsWith('cv-');
/** Черновики нод живут в canvas — в списке роликов «Кадров» их нет. */
export const isCanvasDraft = (slug: string): boolean => slug.startsWith('cv-');

/** Промпт — только во вход prompt, видео — во вход video, «Размер» берёт и то и другое, картинки — в ref / start / end. */
export const portAccepts = (port: InputPort, output: 'text' | 'image' | 'video'): boolean =>
  port === 'prompt' ? output === 'text' : port === 'video' ? output === 'video' : port === 'media' ? output !== 'text' : output === 'image';

/**
 * Связи из ноды, которые её выход больше не принимают. Выход «Размера» и апскейла меняет вид вслед за входом
 * (картинка ↔ видео) — без этой чистки видео ушло бы во вход картинки без предупреждения (находка ревью PR #1).
 */
export function dropStaleEdges(flow: Flow, nodeId: string): Flow {
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return flow;
  const edges = flow.edges.filter((e) => e.from !== nodeId || portAccepts(e.port, outputOf(node)));
  return edges.length === flow.edges.length ? flow : { ...flow, edges };
}

/** Файл удалён из библиотеки: ноды, которые на него смотрели, остаются без файла и просят выбрать заново. */
export function forgetMedia(flow: Flow, mediaIds: readonly string[]): Flow {
  const gone = new Set(mediaIds);
  let changed = false;
  const nodes = flow.nodes.map((n) => {
    if (n.mediaId !== null && gone.has(n.mediaId)) {
      changed = true;
      return { ...n, mediaId: null };
    }
    if (n.source?.type === 'media' && gone.has(n.source.mediaId)) {
      changed = true;
      return { ...n, source: null };
    }
    return n;
  });
  return changed ? { ...flow, nodes } : flow;
}

/** Размеры площадок — пресеты ноды «Размер». */
export const RESIZE_PRESETS: readonly { labelRu: string; width: number; height: number }[] = [
  { labelRu: '9:16 · рилс, сторис', width: 1080, height: 1920 },
  { labelRu: '4:5 · лента Instagram', width: 1080, height: 1350 },
  { labelRu: '1:1', width: 1080, height: 1080 },
  { labelRu: '16:9 · YouTube', width: 1920, height: 1080 },
];
