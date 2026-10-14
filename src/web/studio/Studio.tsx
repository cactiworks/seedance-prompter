import { useEffect, useState } from 'react';
import { findModel, type MediaKind } from '../../core/gen/models.ts';
import type { MediaItem } from '../../core/model/media.ts';
import { useGen } from '../gen/genStore.ts';
import { Button, Dialog, Icon, Text } from '../ui/components/index.ts';
import { Composer } from './Composer.tsx';
import { Controls } from './Controls.tsx';
import { JobTile } from './JobTile.tsx';
import { MediaPreview } from './MediaPreview.tsx';
import styles from './Studio.module.css';

/** Картинки / Видео — каркас connxn: лента сессии по центру, composer внизу, параметры справа. */
export function Studio({ kind }: { kind: MediaKind }) {
  const { jobs, library, activeSession, loadJobs, loadLibrary, addFiles, addRef } = useGen();
  const [open, setOpen] = useState<MediaItem | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void loadJobs();
    void loadLibrary();
  }, [loadJobs, loadLibrary]);

  const sessionId = activeSession[kind];
  const feed = jobs.filter((job) => job.kind === kind && sessionId !== null && job.sessionId === sessionId);
  // Для листания стрелками в просмотре — готовые файлы ленты в порядке показа.
  const feedMedia = feed.flatMap((job) => job.mediaIds.map((id) => library.find((m) => m.id === id)).filter((m): m is MediaItem => m !== undefined));

  return (
    <div className={styles.studio}>
      <section
        className={`${styles.center} ${dragging ? styles.dragging : ''}`}
        onDragOver={(event) => {
          if ([...event.dataTransfer.types].includes('Files')) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void addFiles(kind, [...event.dataTransfer.files]);
        }}
      >
        <div className={styles.settingsButton}><Button variant="border" size="s" onClick={() => setSettingsOpen(true)}>Модель и параметры</Button></div>
        {feed.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>
              <Icon name={kind === 'image' ? 'image' : 'video'} size={1.5} />
            </span>
            <Text variant="title-m" medium>
              {kind === 'image' ? 'Создай изображение' : 'Создай видео'}
            </Text>
            <Text variant="label" tone="secondary">
              {kind === 'image' ? 'Опиши идею внизу или добавь референс. Модель и формат — в параметрах.' : 'Опиши сцену внизу. Чтобы оживить изображение, добавь его как референс.'}
            </Text>
          </div>
        ) : (
          <div className={styles.feed}>
            {feed.map((job) => (
              <JobTile key={job.id} job={job} onOpen={(mediaId) => setOpen(library.find((m) => m.id === mediaId) ?? null)} />
            ))}
          </div>
        )}
        <div data-guide="studio-composer"><Composer kind={kind} /></div>
        {dragging && (
          <div className={styles.dropHint}>
            <Text variant="title-s" medium>
              Отпусти — картинка станет референсом
            </Text>
          </div>
        )}
      </section>
      <div className={styles.desktopSettings}><Controls kind={kind} /></div>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen} title="Модель и параметры"><div className={styles.settingsDialog}><Controls kind={kind} /></div></Dialog>
      <MediaPreview
        item={open}
        list={feedMedia}
        onClose={() => setOpen(null)}
        onUseAsRef={(item, target) => {
          addRef(target, { label: `Из библиотеки · ${findModel(item.modelId)?.titleRu ?? ''}`, source: { type: 'media', mediaId: item.id } });
          setOpen(null);
          if (target !== kind) window.location.hash = target === 'image' ? '/images' : '/video';
        }}
      />
    </div>
  );
}
