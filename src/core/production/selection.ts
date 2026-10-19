import { z } from 'zod';
import { currentArtifact, type ProductionRun } from './model.ts';
import { ProductionError } from './engine.ts';
import { quotePhotos } from './photos.ts';

export const PhotoSelectionSchema = z.object({ ids: z.array(z.string()) }).strict();
export const ContinuePhotosSchema = PhotoSelectionSchema.extend({
  rev: z.number().int().nonnegative(), requestId: z.uuid(),
  confirmUsd: z.number().nonnegative(), consent: z.literal(true),
});
export type ContinuePhotos = z.infer<typeof ContinuePhotosSchema>;

/** A critic advises the creator; only active work and unsaved files block selection. */
export function photoSelectionProblem(run: ProductionRun): string | null {
  if (run.mode !== 'photos' || !run.planned || !run.photos || !run.shots.length) return 'Сначала создай фотографии по плану.';
  if (run.paused) return 'Сначала сними паузу серии.';
  if (run.photos.status === 'running' || run.retouch?.status === 'running'
    || [run.appearance, run.masterReview, run.review].some(s => s?.status === 'running' || s?.status === 'pending')) return 'Дождись завершения текущей работы.';
  if (run.photos.items.some(i => i.status !== 'saved' || !i.mediaId)
    || run.retouch?.items.some(i => i.attempts.some(a => ['submitting', 'queued', 'running', 'downloading', 'unknown', 'download_failed', 'processing_failed'].includes(a.status)))
    || run.shots.some(s => !s.photoId || !currentArtifact(run, s.photoId)?.mediaId)) return 'Сначала заверши получение всех фотографий. Неизвестные отправки не повторяются автоматически.';
  return null;
}

export function quotePhotoSelection(run: ProductionRun, ids: string[]) {
  const problem = photoSelectionProblem(run);
  if (problem) throw new ProductionError('INVALID', problem);
  const open = run.shots.filter(s => !s.acceptedPhotoId);
  if (new Set(ids).size !== ids.length || ids.some(id => !open.some(s => s.photoId === id))) throw new ProductionError('CONFLICT', 'Выбранные фотографии изменились. Обнови выбор.');
  const regenerate = open.filter(s => !ids.includes(s.photoId!)).map(s => s.id);
  const perImageUsd = quotePhotos(run).perImageUsd;
  return { rev: run.rev, ids, regenerate, accepted: run.shots.length - open.length, total: run.shots.length,
    count: regenerate.length, perImageUsd, usd: Number((regenerate.length * perImageUsd).toFixed(6)) };
}
export type PhotoSelectionQuote = ReturnType<typeof quotePhotoSelection>;
