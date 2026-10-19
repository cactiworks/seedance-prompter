import { z } from 'zod';
import type { RetouchState } from './retouch.ts';
import type { PreparationState, PromptPlan, ScenePlan } from './plan.ts';
import { CHARACTER_ID, type CharacterSelection } from './character.ts';
import type { PhotoState } from './photos.ts';
import { masterApproved, type ReviewState } from './review.ts';
import type { AppearanceState } from './appearance.ts';
import { PhotoAspectSchema, PhotoResolutionSchema } from './output.ts';

export const STEP_ORDER = ['photos', 'photoQc', 'photoReview', 'videos', 'videoQc', 'videoReview', 'upscale', 'finalQc', 'ready'] as const;
export type ShotStep = (typeof STEP_ORDER)[number];
export const RunBriefSchema = z.object({
  mode: z.enum(['mock', 'photos']).default('mock'),
  contentMode: z.enum(['story', 'broll']).optional(),
  brollCount: z.number().int().min(1).max(8).optional(),
  requestId: z.string().min(8).max(100).optional(),
  planningMode: z.enum(['mock', 'codex']).optional(),
  characterId: z.string().regex(CHARACTER_ID).nullable().optional(),
  title: z.string().trim().min(1).max(100),
  script: z.string().trim().max(12_000).default(''),
  direction: z.string().trim().min(1).max(3000),
  style: z.enum(['phone', 'cinema']).default('phone'),
  resolution: PhotoResolutionSchema.optional(),
  aspectRatio: PhotoAspectSchema.optional(),
  scenario: z.enum(['normal', 'repair']).default('repair'),
}).strict();
export const CreateRunSchema = RunBriefSchema.superRefine((input, ctx) => {
  if (input.contentMode !== 'broll' && !input.script) ctx.addIssue({ code: 'custom', path: ['script'], message: 'Для серии по сценарию нужен текст.' });
  if (input.contentMode === 'broll' && (input.mode !== 'photos' || input.planningMode !== 'codex')) ctx.addIssue({ code: 'custom', path: ['contentMode'], message: 'Креативные B-roll используют подготовку Codex и режим фотографий.' });
});
export type RunInput = z.infer<typeof CreateRunSchema>;
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pause'), rev: z.number().int().nonnegative() }),
  z.object({ type: z.literal('resume'), rev: z.number().int().nonnegative() }),
  z.object({ type: z.literal('retryPreparation'), rev: z.number().int().nonnegative() }),
  z.object({ type: z.literal('approvePhotos'), rev: z.number().int().nonnegative(), ids: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('approveVideos'), rev: z.number().int().nonnegative(), ids: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('edit'), rev: z.number().int().nonnegative(), shotId: z.string(), sourceId: z.string(), note: z.string().trim().min(1).max(1500) }),
  z.object({ type: z.literal('retry'), rev: z.number().int().nonnegative(), shotId: z.string() }),
  z.object({ type: z.literal('simulateFailure'), rev: z.number().int().nonnegative(), shotId: z.string() }),
]);
export type RunAction = z.infer<typeof ActionSchema>;
export interface Artifact {
  id: string; shotId: string; kind: 'photo' | 'video' | 'final'; version: number; sourceId: string | null;
  url: string; poster: string; prompt: string; model: string; taskId: string; createdAt: string;
  qc: 'pending' | 'pass' | 'repair' | 'review'; qcNote: string; note: string; cost: number;
  mediaId?: string; generationJobId?: string; providerModel?: string;
}
export interface ProductionShot {
  id: string; title: string; framing: string; action: string; step: ShotStep;
  photoId: string | null; videoId: string | null; finalId: string | null;
  acceptedPhotoId: string | null; acceptedVideoId: string | null;
  dueAt: number; error: string | null; editNote: string; editSourceId: string | null;
}
export interface ProductionRun extends RunInput {
  retouch?: RetouchState;
  photos?: PhotoState;
  review?: ReviewState;
  masterReview?: ReviewState;
  appearance?: AppearanceState;
  planSourceId?: string;
  character?: CharacterSelection | null;
  id: string; rev: number; createdAt: string; updatedAt: string; paused: boolean;
  planned: boolean; dueAt: number; shots: ProductionShot[]; artifacts: Artifact[];
  approvals: { kind: 'photo' | 'video'; artifactId: string; at: string }[];
  events: { at: string; message: string }[];
  preparation?: PreparationState;
  scenePlan?: ScenePlan;
  promptPlan?: PromptPlan;
}
export const DEMO_INPUT: RunInput = {
  mode: 'mock', title: 'Обычное утро, необычный взгляд',
  script: 'Сначала я просто смотрю в окно.\nПотом записываю мысль в блокнот.\nСамое интересное начинается с маленькой детали.',
  direction: 'Одна комната, пасмурное утро. Спокойно, живо, как снято на телефон. Разные крупности, без постановочного пафоса.',
  style: 'phone', scenario: 'repair',
};
export const STAGES = [
  ['plan', 'Сцена и план кадров', 'Режиссёр · Codex'],
  ['photos', 'Создание фотографий', 'Soul 2 / Soul Cinema · Higgsfield'],
  ['photoQc', 'Проверка фотографий', 'QC · mock'],
  ['photoReview', 'Принять фотографии', 'Milestone 1 · твоё решение'],
  ['videos', 'Создание видео', 'Seedance 2.5 · 480p · Higgsfield'],
  ['videoQc', 'Проверка движения', 'QC · mock'],
  ['videoReview', 'Выбрать видео до Topaz', 'Milestone 2 · твоё решение'],
  ['upscale', 'Улучшение качества', 'Topaz · KIE'],
  ['finalQc', 'Финальная проверка', 'QC · mock'],
  ['ready', 'Готовые материалы', 'Выдача для твоего монтажа'],
] as const;
export type StageId = (typeof STAGES)[number][0];
export function currentArtifact(run: ProductionRun, id: string | null): Artifact | undefined {
  return run.artifacts.find((a) => a.id === id);
}
export function isAutomatic(step: ShotStep): boolean { return !['photoReview', 'videoReview', 'ready'].includes(step); }
export function runLabel(run: ProductionRun): string {
  if (run.paused) return 'На паузе';
  if (run.preparation?.status === 'failed' || run.preparation?.status === 'interrupted') return 'Подготовка остановлена';
  if (run.mode === 'photos' && run.planned) {
    if (run.retouch?.status === 'running') return 'Исправляем детали';
    if (run.photos?.status === 'complete') return 'Готово';
    if (run.appearance?.status === 'running') return 'Фиксируется внешность';
    if (run.appearance?.status === 'failed' || run.appearance?.status === 'interrupted') return 'Внешность не закреплена';
    if (run.masterReview?.status === 'complete' && !masterApproved(run)) return 'Master не принят';
    if (run.masterReview?.status === 'failed' || run.masterReview?.status === 'interrupted') return 'Проверка master остановлена';
    if (run.masterReview?.status === 'running') return 'Критик проверяет master';
    if (run.photos?.status === 'running' && run.masterReview?.status === 'pending' && run.photos.masterArtifactId) return 'Кадры ждут проверки master';
    if (run.review?.status === 'running') return 'Критик проверяет фото';
    if (run.review?.status === 'pending' && run.photos?.status === 'review') return 'Ожидает критика';
    if (run.review?.status === 'failed' || run.review?.status === 'interrupted') return 'Проверка остановлена';
    if (!run.photos) return 'Готов к генерации фото';
    if (run.photos.status === 'stopped') return 'Генерация остановлена';
    if (run.photos.status === 'review') return run.review?.status === 'complete' ? 'Принять фотографии' : 'Проверить фотографии';
  }
  if (run.planned && run.shots.every((s) => s.step === 'ready')) return 'Готово';
  if (run.shots.some((s) => s.error !== null)) return 'Нужна проверка';
  if (!run.planned || run.shots.some((s) => isAutomatic(s.step))) return 'В работе';
  return 'Ждёт твоего решения';
}
export function stageProgress(run: ProductionRun, stage: StageId): { done: number; active: number; errors: number; total: number } {
  if (stage === 'plan') return { done: Number(run.planned), active: Number(!run.planned), errors: Number(run.preparation?.status === 'failed' || run.preparation?.status === 'interrupted'), total: 1 };
  const index = STEP_ORDER.indexOf(stage);
  return {
    done: run.shots.filter((s) => STEP_ORDER.indexOf(s.step) > index || (stage === 'ready' && s.step === 'ready')).length,
    active: run.shots.filter((s) => s.step === stage && stage !== 'ready').length,
    errors: run.shots.filter((s) => s.step === stage && s.error !== null).length,
    total: run.shots.length || run.scenePlan?.shots.length || (run.planningMode === 'codex' ? 0 : 3),
  };
}
