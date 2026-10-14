import type { GenJob, JobStatus, MediaItem } from '../model/media.ts';

export const STATUS_RU: Record<JobStatus, string> = {
  submitting: 'Отправляется', unknown: 'Исход отправки неизвестен', queued: 'В очереди',
  running: 'Генерируется', downloading: 'Сохраняется на диск', saved: 'Готово',
  failed: 'Ошибка генерации', download_failed: 'Не удалось скачать',
};
export const isActive = (job: GenJob): boolean => ['submitting', 'queued', 'running', 'downloading'].includes(job.status);
export const needsAttention = (job: GenJob): boolean => ['failed', 'download_failed', 'unknown'].includes(job.status);
export const awaitingFiles = (job: GenJob, library: readonly MediaItem[]): boolean => job.status === 'saved' && job.mediaIds.some((id) => id !== null && !library.some((m) => m.id === id));
export const submissionIssue = (jobs: readonly GenJob[]): string | null => {
  const problem = jobs.find(needsAttention);
  return problem === undefined ? null : problem.error?.messageRu ?? STATUS_RU[problem.status];
};

/** A late list response must not move a job back from saved to running. */
export function mergeJobs(current: readonly GenJob[], incoming: readonly GenJob[]): GenJob[] {
  const merged = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) {
    const previous = merged.get(job.id);
    if (previous === undefined || job.updatedAt >= previous.updatedAt) merged.set(job.id, job);
  }
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
