import { z } from 'zod';
import type { PreparationState, PromptPlan, ScenePlan } from './plan.ts';

export const STEP_ORDER = ['photos', 'photoQc', 'photoReview', 'videos', 'videoQc', 'videoReview', 'upscale', 'finalQc', 'ready'] as const;
export type ShotStep = (typeof STEP_ORDER)[number];
export const CreateRunSchema = z.object({
  mode: z.literal('mock').default('mock'),
  planningMode: z.enum(['mock', 'codex']).optional(),
  title: z.string().trim().min(1).max(100),
  script: z.string().trim().min(1).max(12_000),
  direction: z.string().trim().min(1).max(3000),
  style: z.enum(['phone', 'cinema']).default('phone'),
  scenario: z.enum(['normal', 'repair']).default('repair'),
}).strict();
export type RunInput = z.infer<typeof CreateRunSchema>;
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pause'), rev: z.number().int().nonnegative() }),
  z.object({ type: z.literal('resume'), rev: z.number().int().nonnegative() }),
  z.object({ type: z.literal('retryPreparation'), rev: z.number().int().nonnegative() }),
  z.object({ type: z.literal('approvePhotos'), rev: z.number().int().nonnegative(), ids: z.array(z.string()).min(1).max(8) }),
  z.object({ type: z.literal('approveVideos'), rev: z.number().int().nonnegative(), ids: z.array(z.string()).min(1).max(8) }),
  z.object({ type: z.literal('edit'), rev: z.number().int().nonnegative(), shotId: z.string(), sourceId: z.string(), note: z.string().trim().min(1).max(1500) }),
  z.object({ type: z.literal('retry'), rev: z.number().int().nonnegative(), shotId: z.string() }),
  z.object({ type: z.literal('simulateFailure'), rev: z.number().int().nonnegative(), shotId: z.string() }),
]);
export type RunAction = z.infer<typeof ActionSchema>;
export interface Artifact {
  id: string; shotId: string; kind: 'photo' | 'video' | 'final'; version: number; sourceId: string | null;
  url: string; poster: string; prompt: string; model: string; taskId: string; createdAt: string;
  qc: 'pending' | 'pass' | 'repair'; qcNote: string; note: string; cost: 0;
}
export interface ProductionShot {
  id: string; title: string; framing: string; action: string; step: ShotStep;
  photoId: string | null; videoId: string | null; finalId: string | null;
  acceptedPhotoId: string | null; acceptedVideoId: string | null;
  dueAt: number; error: string | null; editNote: string; editSourceId: string | null;
}
export interface ProductionRun extends RunInput {
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
