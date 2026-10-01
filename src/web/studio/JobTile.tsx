import { useEffect, useState } from 'react';
import { estimate, findModel, formatCost, paramsFor } from '../../core/gen/models.ts';
import type { GenJob } from '../../core/model/media.ts';
import { isActive, mediaUrl, useGen } from '../gen/genStore.ts';
import { Button, Icon, Text } from '../ui/components/index.ts';
import styles from './Studio.module.css';

export const STATUS_RU: Record<GenJob['status'], string> = {
  submitting: 'Отправляю…',
  queued: 'В очереди',
  running: 'Генерирую',
  downloading: 'Сохраняю на диск',
  saved: 'Готово',
  failed: 'Не получилось',
  download_failed: 'Не скачано',
};

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
  const { remix, regenerate, retry, reveal, toggleFavorite, favorites, deleteJob } = useGen();
  const active = isActive(job);
  const elapsed = useElapsed(job.createdAt, active);
  const model = findModel(job.modelId);
  const again = model === undefined ? null : estimate(model, paramsFor(model, job.params), 1, job.refs.length);
  const mediaId = job.mediaIds.find((id): id is string => id !== null);

  return (
    <article className={styles.tile}>
      <div className={styles.tileMedia} style={{ aspectRatio: aspectOf(job.params.aspectRatio) }}>
        {job.status === 'saved' && mediaId !== undefined ? (
          <button type="button" className={styles.tileOpen} onClick={() => onOpen(mediaId)} aria-label="Открыть">
            {job.kind === 'image' ? (
              <img src={mediaUrl(mediaId)} alt={job.prompt.slice(0, 80)} loading="lazy" />
            ) : (
              <video src={mediaUrl(mediaId)} muted loop playsInline preload="metadata" onMouseEnter={(e) => void e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} />
            )}
          </button>
        ) : (
          <div className={`${styles.tilePlaceholder} lab-hatch`}>
            <Text variant="label" medium className={job.status === 'failed' || job.status === 'download_failed' ? styles.tileFailed : undefined}>
              {STATUS_RU[job.status]}
            </Text>
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
              <Button variant="border" size="xs" onClick={() => void retry(job.id)}>
                {job.status === 'download_failed' ? 'Скачать снова' : 'Проверить снова'}
              </Button>
            )}
            {job.status === 'failed' && (
              <Button variant="ghost" size="xs" icon={<Icon name="close" size={0.75} />} title="Убрать неудачную задачу из ленты" onClick={() => void deleteJob(job.id)}>
                Убрать
              </Button>
            )}
          </div>
        )}
        {job.status === 'saved' && mediaId !== undefined && (
          <div className={styles.tileActions}>
            <button type="button" title="Remix — вернуть промпт и настройки в форму" onClick={() => remix(job)}>
              <Icon name="arrow-undo" size={1} />
            </button>
            <button type="button" title={again === null ? 'Ещё раз' : `Ещё раз · ${formatCost(again)}`} onClick={() => void regenerate(job)}>
              <Icon name="arrow-redo" size={1} />
            </button>
            <button type="button" title={favorites.includes(mediaId) ? 'Убрать из избранного' : 'В избранное'} onClick={() => void toggleFavorite(mediaId)}>
              <Icon name="star" size={1} />
            </button>
            <button type="button" title="Показать файл в Finder" onClick={() => void reveal(mediaId)}>
              <Icon name="folder" size={1} />
            </button>
          </div>
        )}
      </div>
      <footer className={styles.tileFoot}>
        <Text variant="caption" tone="secondary">
          {model?.titleRu ?? job.modelId}
        </Text>
        <Text variant="caption" tone="tertiary">
          {job.creditsConsumed !== null ? `${job.creditsConsumed} кр` : `≈ ${job.estimateCredits} кр`}
        </Text>
      </footer>
    </article>
  );
}
