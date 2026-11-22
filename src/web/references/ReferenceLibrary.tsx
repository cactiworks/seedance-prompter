import { useEffect, useRef, useState, type FormEvent } from 'react';
import { REFERENCE_FOLDERS, type ReferenceAnalysisJob, type ReferenceCard, type ReferenceFolder } from '../../core/references.ts';
import { ui, useLanguage } from '../language.ts';
import { Button, Dialog, Icon, SegmentedControl, Select, Text, TextField } from '../ui/components/index.ts';
import { editReference, getReferenceCards, referenceAnalysis, uploadReference } from './api.ts';
import { referenceCaption, ReferenceCardContent, ReferenceCardPreview } from './ReferenceCardView.tsx';
import { ReferenceChat } from './ReferenceChat.tsx';
import { ReferenceGraph } from './ReferenceGraph.tsx';
import styles from './References.module.css';

const PAGE_SIZE = 30;
const FILE_TYPES = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm';
const FOLDERS = Object.entries(REFERENCE_FOLDERS) as Array<[ReferenceFolder, string]>;
const JOB_COPY: Record<ReferenceAnalysisJob['status'], string> = {
  running: 'Анализ идёт',
  stopped: 'Анализ остановлен',
  done: 'Анализ завершён',
  error: 'Ошибка анализа',
};

type FolderFilter = 'all' | 'pending' | ReferenceFolder;
type LibraryMode = 'folders' | 'chat' | 'graph';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : ui('Не удалось выполнить запрос.');
}

function matchesQuery(card: ReferenceCard, query: string): boolean {
  const searchable = [card.sourceName, ...card.tags, ...Object.values(card.analysis ?? {})].join(' ').toLocaleLowerCase();
  return query.split(/\s+/).every((part) => searchable.includes(part));
}

function EditReferenceDialog({ card, onClose, onEdited }: { card: ReferenceCard; onClose: () => void; onEdited: (card: ReferenceCard) => void }) {
  const [folder, setFolder] = useState<ReferenceFolder | ''>(card.folder ?? '');
  const [tags, setTags] = useState(card.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const updated = await editReference(card.id, {
        ...(folder ? { folder } : {}),
        tags: Array.from(new Set(tags.split(',').map((tag) => tag.trim()).filter(Boolean))),
      });
      onEdited(updated.card);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={referenceCaption(card)} size="l">
      <ReferenceCardContent card={card} />
      <form className={styles.editForm} onSubmit={(event) => void submit(event)}>
        <Select label={ui('Папка')} value={folder} onChange={(value) => setFolder(value as ReferenceFolder | '')} options={[
          ...(card.folder === null ? [{ value: '', label: ui('Без папки') }] : []),
          ...FOLDERS.map(([value, name]) => ({ value, label: ui(name) })),
        ]} />
        <TextField label={ui('Приёмы через запятую')} value={tags} maxLength={1024} onChange={(event) => setTags(event.target.value)} />
        <Button type="submit" variant="primary" loading={saving} disabled={folder === (card.folder ?? '') && tags === card.tags.join(', ')}>{ui('Сохранить')}</Button>
      </form>
      {error && <Text variant="label" role="alert" className={styles.error}>{error}</Text>}
    </Dialog>
  );
}

export function ReferenceLibrary({ showGraph = false, shared = false }: { showGraph?: boolean; shared?: boolean }) {
  const [language] = useLanguage();
  const [cards, setCards] = useState<ReferenceCard[]>([]);
  const [job, setJob] = useState<ReferenceAnalysisJob | null>(null);
  const [mode, setMode] = useState<LibraryMode>('folders');
  const [folder, setFolder] = useState<FolderFilter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [opened, setOpened] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ index: number; total: number; name: string } | null>(null);
  const [jobAction, setJobAction] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState('');
  const [failedUploads, setFailedUploads] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const files = useRef<HTMLInputElement>(null);
  const importActive = useRef(false);
  const running = job?.status === 'running';

  useEffect(() => {
    const controller = new AbortController();
    async function refresh(): Promise<void> {
      try {
        const [catalog, progress] = await Promise.all([getReferenceCards(controller.signal), referenceAnalysis(undefined, controller.signal)]);
        if (controller.signal.aborted) return;
        setCards(catalog.cards);
        setJob(progress.job);
        setLoaded(true);
      } catch (failure) {
        if (!controller.signal.aborted) setError(messageOf(failure));
      }
    }
    void refresh();
    const onFocus = (): void => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    const poll = running ? window.setInterval(() => void refresh(), 1200) : undefined;
    return () => {
      controller.abort();
      window.removeEventListener('focus', onFocus);
      window.clearInterval(poll);
    };
  }, [running, loadVersion]);

  const format = new Intl.NumberFormat(language === 'en' ? 'en-US' : 'ru-RU');
  const pending = cards.filter((card) => card.analysis === null).length;
  const filters = [
    { id: 'all' as const, label: ui('Все кадры'), count: cards.length },
    { id: 'pending' as const, label: ui('Ожидают разбора'), count: pending },
    ...FOLDERS.map(([id, name]) => ({ id, label: ui(name), count: cards.filter((card) => card.folder === id).length })),
  ];
  const filtered = cards.filter((card) => (folder === 'all' || (folder === 'pending' ? card.analysis === null : card.folder === folder)) && matchesQuery(card, search.trim().toLocaleLowerCase()));
  const openedCard = cards.find((card) => card.id === opened);

  function upsert(additions: ReferenceCard[]): void {
    setCards((current) => {
      const byId = new Map(current.map((card) => [card.id, card]));
      for (const card of additions) {
        if ((byId.get(card.id)?.version ?? 0) <= card.version) byId.set(card.id, card);
      }
      return [...byId.values()];
    });
  }

  async function importFiles(selected: File[]): Promise<void> {
    if (!selected.length || importActive.current) return;
    importActive.current = true;
    setError('');
    setNotice('');
    setFailedUploads([]);
    const failures: string[] = [];
    let imported = 0;
    try {
      for (const [index, file] of selected.entries()) {
        setUpload({ index: index + 1, total: selected.length, name: file.name });
        try {
          const result = await uploadReference(file);
          upsert(result.cards);
          imported += 1;
        } catch (failure) {
          failures.push(`${file.name} · ${messageOf(failure)}`);
        }
      }
      setMode('folders');
      setFolder('all');
      setSearch('');
      setPage(1);
      setFailedUploads(failures);
      if (imported > 0) setNotice(ui('Обработано файлов: {0}', imported));
      setLoadVersion((value) => value + 1);
    } finally {
      importActive.current = false;
      setUpload(null);
    }
  }

  async function controlJob(action: 'start' | 'stop'): Promise<void> {
    setJobAction(action);
    setError('');
    try {
      const result = await referenceAnalysis(action, undefined, pending);
      setJob(result.job);
      setLoadVersion((value) => value + 1);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setJobAction(null);
    }
  }

  return (
    <main className={styles.library} aria-label={ui('Референсы')} data-mode={mode}>
      <div className={styles.libraryInner}>
        <header className={styles.pageHead}>
          <div className={styles.title}>
            <Text as="h1" variant="title-l" medium>{ui('Референсы')}</Text>
            <Text variant="label" tone="secondary">{ui('Кадры: {0} · Разобрано: {1}', format.format(cards.length), format.format(cards.length - pending))}</Text>
            {shared && <Text id="reference-upload-visibility" variant="label" tone="secondary">{ui('Загруженные кадры видят все пользователи студии.')}</Text>}
          </div>
          <div className={styles.pageActions}>
            <input ref={files} hidden type="file" multiple accept={FILE_TYPES} aria-label={ui('Фото и видео')} onChange={(event) => {
              const selected = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              void importFiles(selected);
            }} />
            {running ? <Button variant="border" loading={jobAction === 'stop'} disabled={jobAction === 'start'} onClick={() => void controlJob('stop')}>{ui('Остановить анализ')}</Button>
              : pending > 0 && <Button variant="border" loading={jobAction === 'start'} disabled={upload !== null} onClick={() => void controlJob('start')}>
                {job?.status === 'stopped' || job?.status === 'error' ? ui('Продолжить анализ') : ui('Проанализировать')}
              </Button>}
            <Button variant="primary" size="m" loading={upload !== null} icon={<Icon name="plus" size={1} />} aria-describedby={shared ? 'reference-upload-visibility' : undefined} onClick={() => files.current?.click()}>{ui('Загрузить')}</Button>
          </div>
        </header>

        {((job && (mode === 'folders' || job.status !== 'done')) || upload || notice || error || failedUploads.length > 0) && <div className={styles.status}>
          {job && (mode === 'folders' || job.status !== 'done') && <div className={styles.job} role="status">
            <Text variant="label" medium>{ui(JOB_COPY[job.status])}</Text>
            <Text variant="caption" tone="secondary">{ui('{0} из {1} кадров · токены {2} вход / {3} выход', format.format(job.completed), format.format(job.total), format.format(job.inputTokens), format.format(job.outputTokens))}</Text>
            {running && <progress aria-label={ui('Прогресс анализа')} max={Math.max(1, job.total)} value={job.completed} />}
            {job.error && <Text variant="label" className={styles.error}>{ui(job.error)}</Text>}
          </div>}
          {upload && <Text variant="label" role="status">{ui('Загружаю {0} из {1} · {2}', upload.index, upload.total, upload.name)}</Text>}
          {notice && <Text variant="label" role="status">{notice}</Text>}
          {error && <div className={styles.row}><Text className={styles.error} variant="label" role="alert">{error}</Text>
            <Button variant="ghost" onClick={() => { setError(''); setLoadVersion((value) => value + 1); }}>{ui('Обновить')}</Button>
          </div>}
          {failedUploads.length > 0 && <ul className={styles.uploadErrors} role="alert">{failedUploads.map((entry, index) => <li key={index}>{entry}</li>)}</ul>}
        </div>}

        <div className={styles.libraryToolbar}>
          <SegmentedControl<LibraryMode> aria-label={ui('Вид библиотеки референсов')} size="s" value={mode} onChange={setMode} options={[
            { value: 'folders', label: ui('Папки') },
            ...(showGraph ? [{ value: 'graph' as const, label: ui('Граф') }] : []),
            { value: 'chat', label: ui('Подбор в чате') },
          ]} />
          {mode === 'folders' && <label className={styles.search}>
            <Icon name="search" size={1} />
            <input type="search" aria-label={ui('Поиск по кадрам')} placeholder={ui('Кадр или приём')} value={search}
              onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          </label>}
        </div>

        {mode === 'chat' ? <div className={styles.fullChat}><ReferenceChat threadKey="library" /></div>
          : mode === 'graph' ? <ReferenceGraph cards={cards} onOpen={(card) => setOpened(card.id)} />
            : <div className={styles.galleryLayout}>
              <nav className={styles.folders} aria-label={ui('Папки референсов')}>
                {filters.map((filter) => (
                  <button type="button" className={styles.folder} key={filter.id} aria-current={filter.id === folder ? 'page' : undefined}
                    onClick={() => { setFolder(filter.id); setPage(1); }}>
                    <Icon name="folder" size={1} />
                    <span>{filter.label}</span>
                    <Text as="span" variant="caption" tone="secondary" mono>{format.format(filter.count)}</Text>
                  </button>
                ))}
              </nav>
              <section className={styles.gallery} aria-label={filters.find((filter) => filter.id === folder)?.label}>
                {filtered.length > 0 ? <>
                  <ul className={styles.grid}>
                    {filtered.slice(0, page * PAGE_SIZE).map((card) => <li key={card.id}><ReferenceCardPreview card={card} onOpen={() => setOpened(card.id)} /></li>)}
                  </ul>
                  {filtered.length > page * PAGE_SIZE && <Button variant="border" onClick={() => setPage((value) => value + 1)}>{ui('Показать ещё')}</Button>}
                </> : <div className={styles.empty}>
                  <Icon name="images" size={1.5} />
                  <Text as="h2" variant="title-s" medium>{!loaded ? ui('Открываю библиотеку…') : cards.length === 0 ? ui('Добавь первые кадры') : ui('Здесь пока нет кадров')}</Text>
                  {loaded && cards.length === 0 && <Text tone="secondary">{ui('Загрузи фото или видео. Из ролика останутся стоп-кадры с таймкодами.')}</Text>}
                </div>}
              </section>
            </div>}
      </div>
      {openedCard && <EditReferenceDialog key={openedCard.id} card={openedCard} onClose={() => setOpened(null)} onEdited={(updated) => { upsert([updated]); setOpened(null); }} />}
    </main>
  );
}
