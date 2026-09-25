import { z } from 'zod';

export const SCHEMA_VERSION = 1;

/** Форматы, которые принимает Seedance 2.5 (fal API, 20.09.2026). «auto» не берём: формула гайда называет формат словами. */
export const ASPECT_RATIOS = ['9:16', '3:4', '1:1', '4:3', '16:9', '21:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

const key = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'ключ: латиница, цифры, дефис');

/** Единица «текст с происхождением»: ru вводит владелец тезисно, en пишет агент. */
export const TextUnitSchema = z.object({
  ru: z.string().default(''),
  en: z.string().default(''),
  source: z.enum(['empty', 'llm', 'manual']).default('empty'),
  /** Устарело: ручной английский больше не вводится. Поле оставлено, чтобы читались старые проекты. */
  locked: z.boolean().default(false),
  /** Русский текст, из которого агент сделал en. Отличается от ru — английский устарел. */
  enFor: z.string().optional(),
});
export type TextUnit = z.infer<typeof TextUnitSchema>;
export const emptyUnit = (): TextUnit => ({ ru: '', en: '', source: 'empty', locked: false });

/**
 * Нужен ли агент: русский ввод разошёлся с тем, из чего сделан английский. Без отметки `enFor`
 * (проекты до 25.09 и ручной английский) английский считается сделанным из текущего русского —
 * если русское поле было и тогда (`legacyInSync`). У полей, где русский ввод появился только 25.09
 * (имя героя, своя камера, реквизит), старый английский ни из чего не сделан: вписал русский — нужен агент.
 */
export function needsAgent(ru: string, en: string, enFor: string | undefined, legacyInSync = true): boolean {
  const base = enFor ?? (legacyInSync && en.trim() !== '' ? ru : '');
  return ru.trim() !== base.trim();
}

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
  /** Как владелец называет героя или предмет: «Саша», «пикап». */
  nameRu: z.string().optional(),
  /** Имя в прозе промпта — пишет агент полей: «Sasha», «the main pickup». */
  name: z.string().default(''),
  /** nameRu, из которого сделан name. */
  nameFor: z.string().optional(),
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
  /** Что осталось после кадра, тезисно по-русски: сторона, степень, чего нет. */
  titleRu: z.string().default(''),
  /** Каноническое предложение агента полей: сторона, степень, ограничитель. */
  en: z.string(),
  enFor: z.string().optional(),
  /** Кадр, в котором это случилось. Состояние обязательно во всех следующих кадрах, пока не снято. */
  originShotId: z.string().nullable().default(null),
  /** Кадр, начиная с которого состояние больше не действует (синяк прошёл, машину починили). */
  resolvedInShotId: z.string().nullable().default(null),
});
export type ContinuityState = z.infer<typeof StateSchema>;

/** Состояния, действующие в кадре: возникли раньше по порядку кадров и ещё не сняты. */
export function activeStates(project: { shots: { id: string }[]; states: ContinuityState[] }, shotId: string): ContinuityState[] {
  const order = new Map(project.shots.map((shot, index) => [shot.id, index]));
  const here = order.get(shotId) ?? 0;
  return project.states.filter((state) => {
    const from = state.originShotId === null ? -1 : (order.get(state.originShotId) ?? -1);
    const until = state.resolvedInShotId === null ? Infinity : (order.get(state.resolvedInShotId) ?? Infinity);
    return from < here && here < until;
  });
}

export const SegmentSchema = z.object({
  id: z.string(),
  titleRu: z.string().default(''),
  /** Биты отрезка по-русски — вход писателя. */
  beatsRu: z.string().default(''),
  /** Абзац писателя; text.enFor — биты, из которых он написан. */
  text: TextUnitSchema,
});
export type Segment = z.infer<typeof SegmentSchema>;

/** Биты отрезка изменились после того, как писатель написал абзац (или абзаца ещё нет). */
export const segmentNeedsWriter = (segment: Segment): boolean => needsAgent(segment.beatsRu, segment.text.en, segment.text.enFor);

/** Снимок того, что ушло в генерацию, и разбор результата. Основа сравнимости попыток. */
export const AttemptSchema = z.object({
  n: z.number().int().positive(),
  createdAt: z.string(),
  /** Промпт ровно в том виде, в каком он был скопирован. */
  prompt: z.string(),
  panel: z.array(z.object({ index: z.number().int(), key: z.string(), label: z.string() })),
  /** Сценарные абзацы в плейсхолдерной форме — для diff со следующей попыткой. */
  segments: z.array(z.object({ id: z.string(), en: z.string() })),
  kitId: z.string(),
  verdict: z.enum(['pending', 'in-edit', 'partial', 'rejected']).default('pending'),
  workedRu: z.string().default(''),
  failedRu: z.string().default(''),
  symptomIds: z.array(z.string()).default([]),
  /** Пересказ критика «что увидит зритель» на момент копирования — чтобы после генерации сравнить ожидание с результатом. */
  readbackRu: z.string().default(''),
});
export type Attempt = z.infer<typeof AttemptSchema>;

/** Итоговая проверка агентом-критиком. Хранится вместе с текстом, для которого сделана: изменился промпт — проверка устарела. */
export const CritiqueSchema = z.object({
  prompt: z.string(),
  createdAt: z.string(),
  model: z.string().nullable().default(null),
  verdict: z.enum(['ready', 'risky', 'not-ready']),
  summaryRu: z.string(),
  readback: z.array(z.object({ paragraph: z.number().int(), seesRu: z.string(), unsureRu: z.string().optional() })),
  findings: z.array(z.object({ severity: z.enum(['critical', 'warning', 'note']), category: z.string(), quote: z.string(), paragraph: z.number().int(), problemRu: z.string(), fixRu: z.string(), symptomId: z.string().optional() })),
  /** Находки без опоры в тексте, выброшенные проверкой ответа. */
  droppedRu: z.array(z.string()).default([]),
});
export type Critique = z.infer<typeof CritiqueSchema>;

export const ShotSchema = z.object({
  id: z.string(),
  title: z.string().default('Кадр'),
  /** Длительность дубля, с: каждый кадр — отдельная генерация. null — как у ролика. Seedance 2.5 принимает целое 4–30. */
  durationSec: z.number().int().min(4).max(30).nullable().default(null),
  /** id комплекта из pack или 'custom' — тогда техника берётся из customKit. */
  kitId: z.string(),
  /**
   * Своя камера: владелец описывает технику и картинку по-русски (ru), агент полей пишет якорь
   * «shot on <camera> with <lens>» и характер картинки рядом с ним (приём 01).
   */
  customKit: z.object({ ru: z.string().optional(), enFor: z.string().optional(), camera: z.string().default(''), lens: z.string().default(''), look: z.string().default(''), lensNote: z.string().default('') }).default({ camera: '', lens: '', look: '', lensNote: '' }),
  /** null — набор дефектов комплекта. */
  defects: z.array(z.string()).nullable().default(null),
  behavior: z.array(z.string()).default(['real-human', 'no-staged', 'micro-expressions', 'subtle-movement']),
  operatorRule: z.enum(['long', 'short', 'off']).default('long'),
  locationRule: z.enum(['long', 'short']).default('short'),
  /** Ключи референсов в порядке панели Higgsfield. Порядок = нумерация в тексте. */
  panel: z.array(key).default([]),
  locationRefs: z.array(key).max(2).default([]),
  /**
   * Приём 06. Кто держит технику — ключи героев (имя берётся из сущности); строки cameraHolder /
   * lensHolder — из проектов до 25.09. Реквизит владелец описывает по-русски, propsEn пишет агент.
   */
  roleSplit: z
    .object({ cameraRef: key, lensRef: key, cameraHolderKey: z.string().optional(), lensHolderKey: z.string().optional(), cameraHolder: z.string().default(''), lensHolder: z.string().default(''), propsRu: z.string().optional(), propsFor: z.string().optional(), propsEn: z.string().default('') })
    .nullable()
    .default(null),
  /** Кадр свободным русским текстом — вход планировщика. Реплики в «ёлочках» вынимаются как L-id. */
  synopsisRu: z.string().default(''),
  segments: z.array(SegmentSchema).default([]),
  /** Отпечатки подавленных находок линтера с причиной. */
  suppressed: z.array(z.object({ fingerprint: z.string(), reasonRu: z.string().min(1) })).default([]),
  attempts: z.array(AttemptSchema).default([]),
  critique: CritiqueSchema.nullable().default(null),
});
export type Shot = z.infer<typeof ShotSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  rev: z.number().int().nonnegative().default(0),
  slug: key,
  title: z.string().min(1),
  packId: z.string().default('cinema-doc'),
  durationSec: z.number().int().min(4).max(30).default(30),
  /** Формат кадра — общий для ролика; это же значение ставится в Higgsfield. */
  aspectRatio: z.enum(ASPECT_RATIOS).default('9:16'),
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

/** Длительность кадра: своя или общая для ролика. */
export function durationOf(project: { durationSec: number }, shot: { durationSec: number | null }): number {
  return shot.durationSec ?? project.durationSec;
}

/** Бюджет внимания гайда — 4–6 крупных событий на 30 секунд — в пересчёте на длительность кадра. */
export function eventBudget(durationSec: number): { min: number; max: number } {
  const min = Math.max(1, Math.round((4 * durationSec) / 30));
  return { min, max: Math.max(min, Math.round((6 * durationSec) / 30)) };
}

export function newProject(slug: string, title: string): Project {
  return ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    slug,
    title,
    world: { place: emptyUnit(), weather: emptyUnit() },
    shots: [{ id: 'shot-1', title: 'Кадр 1', kitId: 'arri-alexa35-cooke-s4i', segments: [{ id: 'seg-1', titleRu: 'Начало', text: emptyUnit() }] }],
  });
}
