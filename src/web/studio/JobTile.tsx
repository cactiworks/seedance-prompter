import { formatCost } from '../formatCost.ts';
import { ui } from '../language.ts';
import { remoteStudio } from '../download.ts';
import { useEffect, useState } from 'react';
import { estimate, findModel, paramsFor, mediaCostLabel } from '../../core/gen/models.ts';
import type { GenJob } from '../../core/model/media.ts';
import { STATUS_RU, awaitingFiles, needsAttention } from '../../core/gen/jobStatus.ts';
import { isActive, mediaUrl, useGen } from '../gen/genStore.ts';
import { Button, Icon, Text } from '../ui/components/index.ts';
import styles from './Studio.module.css';

export { STATUS_RU } from '../../core/gen/jobStatus.ts';

/** '9:16' → '9 / 16' для CSS aspect-ratio; заглушка сразу в нужной форме. */
export const aspectOf = (value: unknown): string => {
  const m = /^(\d+):(\d+)$/.exec(String(value));
  return m === null ? '1 / 1' : `${m[1]} / ${m[2]}`;
};

function useElapsed(fromIso: string, running: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const sec = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export const retryable = (job: GenJob): boolean => job.status === 'download_failed' || (job.status === 'failed' && job.error?.code === 'POLL_TIMEOUT');

/** Плитка задачи: заглушка с таймером → файл с диска; ошибка на месте; действия по наведению. */
export function JobTile({ job, onOpen }: { job: GenJob; onOpen: (mediaId: string) => void }) {
  const { remix, regenerate, retry, reveal, toggleFavorite, favorites, deleteJob, library } = useGen();
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const act = async (action: () => Promise<void>): Promise<void> => {
    setActing(true); setActionError(null);
    try { await action(); } catch (error) { setActionError(error instanceof Error ? error.message : 'Действие не выполнено.'); }
    finally { setActing(false); }
  };
  const active = isActive(job);
  const elapsed = useElapsed(job.createdAt, active);
  const model = findModel(job.modelId);
  const again = model === undefined ? null : estimate(model, paramsFor(model, job.params), 1, job.refs.length);
  const mediaId = job.mediaIds.find((id): id is string => id !== null);
  const waitingFiles = awaitingFiles(job, library);
  const cost = job.creditsConsumed ?? job.estimateCredits;
  const costLabel = mediaCostLabel(job,cost);

  return (
    <article className={styles.tile} data-job-id={job.id} aria-label={`${ui(model?.titleRu) ?? job.modelId} · ${ui(STATUS_RU[job.status])}`}>
      <div className={styles.tileMedia} style={{ aspectRatio: aspectOf(job.params.aspectRatio) }}>
        {job.status === 'saved' && mediaId !== undefined && !waitingFiles ? (
          <button type="button" className={styles.tileOpen} onClick={() => onOpen(mediaId)} aria-label={ui("Открыть")}>
            {job.kind === 'image' ? (
              <img src={mediaUrl(mediaId)} alt={job.prompt.slice(0, 80)} loading="lazy" />
            ) : (
              <video src={mediaUrl(mediaId)} muted loop playsInline preload="metadata" onMouseEnter={(e) => void e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} />
            )}
          </button>
        ) : (
          <div className={`${styles.tilePlaceholder} lab-hatch`}>
            <Text variant="label" medium className={needsAttention(job) ? styles.tileFailed : undefined}>
              {ui(STATUS_RU[job.status])}
            </Text>
            {waitingFiles && <Text variant="caption" tone="secondary">{ui("Обновляется список файлов…")}</Text>}
            {active && (
              <Text variant="caption" tone="secondary" mono>
                {elapsed}
              </Text>
            )}
            {job.error !== null && (
              <Text variant="caption" tone="secondary" className={styles.tileError}>
                {job.error.messageRu}
              </Text>
            )}
            {retryable(job) && (
              <Button variant="border" size="xs" loading={acting} onClick={() => void act(() => retry(job.id))}>
                {job.status === 'download_failed' ? ui("Скачать снова") : ui("Проверить снова")}
              </Button>
            )}
            {job.status === 'failed' && (
              <Button variant="ghost" size="xs" disabled={acting} icon={<Icon name="close" size={0.75} />} title={ui("Убрать неудачную задачу из ленты")} onClick={() => void act(() => deleteJob(job.id))}>
                {ui("Убрать")}</Button>
            )}
          </div>
        )}
        {job.status === 'saved' && mediaId !== undefined && !waitingFiles && (
          <div className={styles.tileActions}>
            <button type="button" title={ui("Remix — вернуть промпт и настройки в форму")} onClick={() => remix(job)}>
              <Icon name="arrow-undo" size={1} />
            </button>
            <button type="button" title={again === null ? ui("Ещё раз") : ui("Ещё раз · {0}", formatCost(again))} onClick={() => void regenerate(job)}>
              <Icon name="arrow-redo" size={1} />
            </button>
            <button type="button" title={favorites.includes(mediaId) ? ui("Убрать из избранного") : ui("В избранное")} onClick={() => void toggleFavorite(mediaId)}>
              <Icon name="star" size={1} />
            </button>
            <button type="button" title={remoteStudio ? ui("Скачать файл") : ui("Показать файл в Finder")} onClick={() => void reveal(mediaId)}>
              <Icon name="folder" size={1} />
            </button>
          </div>
        )}
      </div>
      <footer className={styles.tileFoot}>
        <Text variant="caption" tone="secondary">
          {ui(model?.titleRu) ?? job.modelId}
        </Text>
        <Text variant="caption" tone="tertiary">
          {job.creditsConsumed === null ? `≈ ${costLabel}` : costLabel}
        </Text>
      </footer>
      {actionError !== null && <Text variant="caption" role="alert">{actionError}</Text>}
    </article>
  );
}
