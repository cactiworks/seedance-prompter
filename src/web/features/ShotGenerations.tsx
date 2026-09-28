import { useEffect } from 'react';
import { isActive, mediaUrl, useGen } from '../gen/genStore.ts';
import { retryable, STATUS_RU } from '../studio/JobTile.tsx';
import { Button, Text } from '../ui/components/index.ts';
import styles from './ShotGenerations.module.css';

/** Генерации попытки кадра: запущены из карточки кадра, файлы уже на диске. */
export function ShotGenerations({ slug, shotId, attemptN }: { slug: string; shotId: string; attemptN: number }) {
  const { jobs, loadJobs, retry, reveal } = useGen();
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const mine = jobs.filter((j) => j.origin?.projectSlug === slug && j.origin.shotId === shotId && j.origin.attemptN === attemptN);
  if (mine.length === 0) return null;

  return (
    <div className={styles.list}>
      <Text variant="caption" tone="secondary">
        Генерации попытки · {mine.length}
      </Text>
      <div className={styles.row}>
        {mine.map((job) => {
          const mediaId = job.mediaIds.find((id): id is string => id !== null);
          return (
            <figure key={job.id} className={styles.item}>
              {job.status === 'saved' && mediaId !== undefined ? (
                <video className={styles.media} src={mediaUrl(mediaId)} controls playsInline preload="metadata" />
              ) : (
                <div className={`${styles.media} ${styles.placeholder} lab-hatch`}>
                  <Text variant="label" medium className={job.status === 'failed' || job.status === 'download_failed' ? styles.failed : undefined}>
                    {STATUS_RU[job.status]}
                    {isActive(job) ? '…' : ''}
                  </Text>
                  {job.error !== null && (
                    <Text variant="caption" tone="secondary">
                      {job.error.messageRu}
                    </Text>
                  )}
                  {retryable(job) && (
                    <Button variant="border" size="xs" onClick={() => void retry(job.id)}>
                      {job.status === 'download_failed' ? 'Скачать снова' : 'Проверить снова'}
                    </Button>
                  )}
                </div>
              )}
              <figcaption className={styles.caption}>
                <Text variant="caption" tone="tertiary">
                  {job.creditsConsumed !== null ? `${job.creditsConsumed} кр` : `≈ ${job.estimateCredits} кр`} · {Object.values(job.params).map(String).join(' / ')}
                </Text>
                {mediaId !== undefined && (
                  <Button variant="ghost" size="xs" onClick={() => void reveal(mediaId)}>
                    В Finder
                  </Button>
                )}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
