import { z } from 'zod';

export const SCHEMA_VERSION = 1;

const key = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'ключ: латиница, цифры, дефис');

/** Единица «текст с происхождением»: ru вводит владелец, en пишет LLM или он сам. */
export const TextUnitSchema = z.object({
  ru: z.string().default(''),
  en: z.string().default(''),
  source: z.enum(['empty', 'llm', 'manual']).default('empty'),
  locked: z.boolean().default(false),
});
export type TextUnit = z.infer<typeof TextUnitSchema>;
export const emptyUnit = (): TextUnit => ({ ru: '', en: '', source: 'empty', locked: false });

export const RefSchema = z.object({
  key,
  label: z.string(),
  kind: z.enum(['location', 'character', 'object', 'gear', 'other']),
  /** Имя файла в каталоге проекта; пусто — референс пока без картинки. */
  file: z.string().nullable().default(null),
  flags: z.object({ hasPeople: z.boolean().default(false), hasText: z.boolean().default(false), studioBackdrop: z.boolean().default(false) }).default({ hasPeople: false, hasText: false, studioBackdrop: false }),
});
export type Ref = z.infer<typeof RefSchema>;

export const EntitySchema = z.object({
  key,
  /** Имя в прозе латиницей: «Alexander», «the main pickup». */
  name: z.string().min(1),
  kind: z.enum(['character', 'object']),
  refKey: key.nullable().default(null),
});
export type Entity = z.infer<typeof EntitySchema>;

export const LineSchema = z.object({
  /** L1, L2… — не переиспользуется. */
  id: z.string().regex(/^L\d+$/),
  speakerKey: key.nullable().default(null),
  ru: z.string(),
  /** Галочка «вычитана» сбрасывается при любой правке текста. */
  proofread: z.boolean().default(false),
});
export type Line = z.infer<typeof LineSchema>;

export const StateSchema = z.object({
  id: z.string().regex(/^S\d+$/),
  titleRu: z.string().default(''),
  /** Каноническое предложение: сторона, степень, ограничитель. */
  en: z.string(),
  originShotId: z.string().nullable().default(null),
});

export const SegmentSchema = z.object({
  id: z.string(),
  titleRu: z.string().default(''),
  /** Биты отрезка по-русски — вход писателя. */
  beatsRu: z.string().default(''),
  text: TextUnitSchema,
});
export type Segment = z.infer<typeof SegmentSchema>;

export const ShotSchema = z.object({
  id: z.string(),
  title: z.string().default('Кадр'),
  kitId: z.string(),
  /** null — набор дефектов комплекта. */
  defects: z.array(z.string()).nullable().default(null),
  behavior: z.array(z.string()).default(['real-human', 'no-staged', 'micro-expressions', 'subtle-movement']),
  operatorRule: z.enum(['long', 'short', 'off']).default('long'),
  locationRule: z.enum(['long', 'short']).default('short'),
  /** Ключи референсов в порядке панели Higgsfield. Порядок = нумерация в тексте. */
  panel: z.array(key).default([]),
  locationRefs: z.array(key).max(2).default([]),
  roleSplit: z.object({ cameraRef: key, lensRef: key, cameraHolder: z.string(), lensHolder: z.string(), propsEn: z.string() }).nullable().default(null),
  segments: z.array(SegmentSchema).default([]),
  /** Отпечатки подавленных находок линтера с причиной. */
  suppressed: z.array(z.object({ fingerprint: z.string(), reasonRu: z.string().min(1) })).default([]),
});
export type Shot = z.infer<typeof ShotSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  rev: z.number().int().nonnegative().default(0),
  slug: key,
  title: z.string().min(1),
  packId: z.string().default('cinema-doc'),
  durationSec: z.number().int().min(4).max(30).default(30),
  language: z.string().default('ru'),
  dialect: z.object({ refSyntax: z.enum(['higgsfield-chip', 'at-image']).default('higgsfield-chip'), dialogueWrap: z.enum(['guillemets', 'braces']).default('guillemets') }).default({ refSyntax: 'higgsfield-chip', dialogueWrap: 'guillemets' }),
  world: z.object({
    place: TextUnitSchema,
    /** Что брать с референса локации: «the space, architecture, ground, water, sky, and weather». */
    useOnlyEn: z.string().default('the space, architecture, ground, water, sky, and weather'),
    weather: TextUnitSchema,
  }),
  refs: z.array(RefSchema).default([]),
  entities: z.array(EntitySchema).default([]),
  lines: z.array(LineSchema).default([]),
  states: z.array(StateSchema).default([]),
  shots: z.array(ShotSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

export function newProject(slug: string, title: string): Project {
  return ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    slug,
    title,
    world: { place: emptyUnit(), weather: emptyUnit() },
    shots: [{ id: 'shot-1', title: 'Кадр 1', kitId: 'arri-alexa35-cooke-s4i', segments: [{ id: 'seg-1', titleRu: 'Начало', text: emptyUnit() }] }],
  });
}
