import { z } from 'zod';

/**
 * Откуда берётся картинка задачи: реф проекта, файл из библиотеки (например, кадр Soul 2) или загрузка
 * с диска в студии (data/uploads).
 */
export const RefSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('projectRef'), slug: z.string(), file: z.string() }),
  z.object({ type: z.literal('media'), mediaId: z.string() }),
  z.object({ type: z.literal('upload'), uploadId: z.string() }),
]);
export type RefSource = z.infer<typeof RefSourceSchema>;

/** Параметры модели — ключи из каталога (src/core/gen/models.ts). */
export const GenParamsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/** Картинка задачи и её роль: референс или первый / последний кадр видео. */
export const JobRefSchema = z.object({ label: z.string(), source: RefSourceSchema, role: z.enum(['ref', 'start', 'end']).default('ref') });
export type JobRef = z.infer<typeof JobRefSchema>;

/** Кадр и попытка, из которых запущена генерация (null — запуск вне проекта). */
export const OriginSchema = z.object({ projectSlug: z.string(), shotId: z.string(), attemptN: z.number().int().nullable() }).nullable();
export type Origin = z.infer<typeof OriginSchema>;

/**
 * submitting → queued / running → downloading → saved.
 * failed — провайдер отказал, не приняли задачу или не дождались результата;
 * download_failed — результат есть у провайдера, но скачать его не вышло (ссылка живёт около суток).
 */
export const JOB_STATUSES = ['submitting', 'unknown', 'queued', 'running', 'downloading', 'saved', 'failed', 'download_failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const GenJobSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  modelId: z.string(),
  provider: z.enum(['kie', 'higgsfield']),
  providerModel: z.string(),
  kind: z.enum(['image', 'video']),
  /** Промпт ровно в том виде, в каком ушёл провайдеру. */
  prompt: z.string(),
  params: GenParamsSchema,
  refs: z.array(JobRefSchema),
  origin: OriginSchema,
  /** Сессия студии (Картинки / Видео), из которой запущено; null — запуск из кадра или canvas. */
  sessionId: z.string().nullable().default(null),
  /** Метка запуска: `cal:<запуск>:<набор>:<случай>:<модель>` у калибровки; null — обычная генерация. */
  tag: z.string().nullable().default(null),
  estimateCredits: z.number(),
  estimateUsd: z.number(),
  status: z.enum(JOB_STATUSES),
  taskId: z.string().nullable(),
  /** Сырое состояние у провайдера (waiting, generating…) — для отладки. */
  providerState: z.string().nullable(),
  creditsConsumed: z.number().nullable(),
  resultUrls: z.array(z.string()),
  /** По одному на resultUrls; null — этот файл ещё не скачан. */
  mediaIds: z.array(z.string().nullable()),
  error: z.object({ code: z.string(), messageRu: z.string() }).nullable(),
  polls: z.number().int(),
  /** С какого момента ждём результат — от него считается таймаут опроса. */
  pollingSince: z.number().nullable(),
  nextCheckAt: z.number(),
  downloadAttempts: z.number().int(),
  finishedAt: z.string().nullable(),
});
export type GenJob = z.infer<typeof GenJobSchema>;

/** Файл в библиотеке: data/library/<yyyy-mm>/<id>.<ext> и рядом <id>.json с этим описанием. */
export const MediaItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['image', 'video']),
  /** Путь относительно data/library. */
  file: z.string(),
  mime: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
  jobId: z.string(),
  taskId: z.string().nullable(),
  provider: z.string(),
  modelId: z.string(),
  providerModel: z.string(),
  prompt: z.string(),
  params: GenParamsSchema,
  refs: z.array(JobRefSchema),
  origin: OriginSchema,
  sessionId: z.string().nullable().default(null),
  /** Номер файла в ответе провайдера (0 — первый). */
  index: z.number().int(),
  sourceUrl: z.string(),
  creditsConsumed: z.number().nullable(),
  createdAt: z.string(),
  savedAt: z.string(),
});
export type MediaItem = z.infer<typeof MediaItemSchema>;

/** Папка библиотеки — как проекты в Assets у Higgsfield: файл может лежать в нескольких папках, удаление папки файлы не трогает. */
export const FolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaIds: z.array(z.string()),
  createdAt: z.string(),
});
export type Folder = z.infer<typeof FolderSchema>;

/**
 * Свой мудборд (этап 3): именованный набор картинок стиля — с диска или из библиотеки. В промптере добавляется
 * референсами «Стиль» одним кликом. Мудборд Higgsfield через API не создаётся — это его замена внутри системы.
 */
export const MoodboardSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  images: z.array(z.object({ label: z.string(), source: RefSourceSchema })).max(8),
  createdAt: z.string(),
});
export type Moodboard = z.infer<typeof MoodboardSchema>;

/** Оценка владельца по готовому файлу (решение 33): журнал, из которого растут правила промптера. */
export const VerdictSchema = z.object({
  mediaId: z.string(),
  verdict: z.enum(['good', 'almost', 'bad']),
  symptoms: z.array(z.string()).max(12),
  noteRu: z.string().max(500),
  at: z.string(),
});

/** Правило владельца для модели — дописывается в её карточку промптера. */
export const LearningSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  textRu: z.string().min(1).max(400),
  evidence: z.array(z.string()),
  at: z.string(),
});

/** Сессия студии — лента генераций одного типа, как чат в connxn. Удаление сессии не трогает файлы библиотеки. */
export const StudioSessionSchema = z.object({
  id: z.string(),
  kind: z.enum(['image', 'video']),
  title: z.string(),
  pinned: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StudioSession = z.infer<typeof StudioSessionSchema>;
