import { useEffect, useRef, useState, type FormEvent } from 'react';
import { REFERENCE_FOLDERS, type ReferenceAnalysisJob, type ReferenceCard, type ReferenceFolder } from '../../core/references.ts';
import { ui, useLanguage } from '../language.ts';
import { Button, Dialog, Icon, SegmentedControl, Select, Text, TextField } from '../ui/components/index.ts';
import { editReference, getReferenceCards, getReferenceQualityAudit, referenceAnalysis, uploadReference, type ReferenceQualityAudit, type ReferenceQualityDecision } from './api.ts';
import { referenceCaption, ReferenceCardContent, ReferenceCardPreview, ReferenceImage } from './ReferenceCardView.tsx';
import { ReferenceChat } from './ReferenceChat.tsx';
import { ReferenceGraph } from './ReferenceGraph.tsx';
import styles from './References.module.css';

const PAGE_SIZE = 30;
const FILE_TYPES = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm';
const FOLDERS = Object.entries(REFERENCE_FOLDERS) as Array<[ReferenceFolder, string]>;
const JOB_COPY: Record<ReferenceAnalysisJob['status'], string> = {
  running: 'Анализ идёт',
  stopped: 'Анализ остановлен',
  done: 'Последний проход завершён',
  error: 'Ошибка анализа',
};

const QUALITY_COPY: Record<ReferenceQualityDecision['status'], string> = {
  pending: 'Ожидает проверки качества',
  keep: 'Проверка качества пройдена',
  reject: 'Отклонён проверкой качества',
  uncertain: 'Качество не определено',
};

type FolderFilter = 'all' | 'pending' | 'analysis' | 'rejected' | 'uncertain' | ReferenceFolder;
type LibraryMode = 'folders' | 'chat' | 'graph';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : ui('Не удалось выполнить запрос.');
}

function matchesQuery(card: ReferenceCard, query: string): boolean {
  const searchable = [card.sourceName, ...card.tags, ...Object.values(card.analysis ?? {})].join(' ').toLocaleLowerCase();
  return query.split(/\s+/).every((part) => searchable.includes(part));
}

function QualityReferencePreview({ card, decision, onOpen }: { card: ReferenceCard; decision?: ReferenceQualityDecision; onOpen: () => void }) {
  const status = decision?.status ?? 'pending';
  return <button type="button" className={styles.cardLink} onClick={onOpen} aria-label={ui('Открыть проверку кадра {0}', referenceCaption(card))}>
    {status === 'pending' || status === 'keep' ? <ReferenceImage card={card} management /> : <span className={styles.empty}>
      <Icon name="images" size={1.5} />
      <Text as="span" variant="label" tone="secondary">{ui('Кадр не допущен в библиотеку')}</Text>
    </span>}
    <span className={styles.cardCaption}>
      <Text as="span" variant="label" medium className={styles.cardTitle}>{referenceCaption(card)}</Text>
      <Text as="span" variant="caption" tone="secondary">{ui(QUALITY_COPY[status])}</Text>
    </span>
  </button>;
}

function QualityReferenceDialog({ card, decision, onClose }: { card: ReferenceCard; decision?: ReferenceQualityDecision; onClose: () => void }) {
  const status = decision?.status ?? 'pending';
  const metadata = decision ? [
    ['Модель проверки', decision.model], ['Версия критериев', decision.criteriaVersion],
    ['Время проверки', decision.at], ['SHA-256 кадра', decision.imageSha256], ['SHA-256 инструкции', decision.promptHash],
  ] as const : [];
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={referenceCaption(card)} size="l">
    <div className={styles.details}>
      {status === 'pending' || status === 'keep' ? <ReferenceImage card={card} className={styles.detailImage} management /> : <div className={styles.empty}>
        <Icon name="images" size={1.5} />
        <Text tone="secondary">{ui('Кадр не допущен в библиотеку')}</Text>
      </div>}
      <div className={styles.detailsText}>
        <div><Text as="h3" variant="label" medium>{ui(QUALITY_COPY[status])}</Text>
          <Text>{decision?.reason || ui('Проверка качества ещё не выполнена.')}</Text></div>
        <Text variant="label" tone="secondary">{ui('В поиск, граф и Canvas попадают только прошедшие проверку и разобранные кадры.')}</Text>
        {metadata.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) => <div key={label}>
          <Text as="h3" variant="caption" tone="secondary">{ui(label)}</Text>
          <Text variant="label" mono>{String(value)}</Text>
        </div>)}
      </div>
    </div>
  </Dialog>;
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
  const [managedCards, setManagedCards] = useState<ReferenceCard[]>([]);
  const [audit, setAudit] = useState<ReferenceQualityAudit | null>(null);
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
  const analyzedCompleted = Math.max(0, (job?.completed ?? 0) - (job?.rejected ?? 0) - (job?.uncertain ?? 0));

  useEffect(() => {
    const controller = new AbortController();
    async function refresh(): Promise<void> {
      try {
        const [catalog, management, quality, progress] = await Promise.all([
          getReferenceCards(controller.signal), getReferenceCards(controller.signal, true),
          getReferenceQualityAudit(controller.signal), referenceAnalysis(undefined, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setCards(catalog.cards);
        setManagedCards(management.cards);
        setAudit(quality);
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
  const pending = audit?.pendingWork ?? 0;
  const decisions = new Map(audit?.decisions.map((decision) => [decision.id, decision]));
  const eligibleIds = new Set(cards.map((card) => card.id));
  const statusOf = (card: ReferenceCard): ReferenceQualityDecision['status'] => decisions.get(card.id)?.status ?? 'pending';
  const waitingAnalysis = managedCards.filter((card) => statusOf(card) === 'keep' && !eligibleIds.has(card.id)).length;
  const filters = [
    { id: 'all' as const, label: ui('Все кадры'), count: cards.length },
    { id: 'pending' as const, label: ui('Ожидают проверки'), count: audit?.pending ?? 0 },
    { id: 'analysis' as const, label: ui('Ожидают разбора'), count: waitingAnalysis },
    { id: 'rejected' as const, label: ui('Отклонены'), count: audit?.rejected ?? 0 },
    { id: 'uncertain' as const, label: ui('Не определено'), count: audit?.uncertain ?? 0 },
    ...FOLDERS.map(([id, name]) => ({ id, label: ui(name), count: cards.filter((card) => card.folder === id).length })),
  ];
  const managementFilter = folder === 'pending' || folder === 'analysis' || folder === 'rejected' || folder === 'uncertain';
  const filtered = (managementFilter ? managedCards : cards).filter((card) => {
    const selected = folder === 'all' || (folder === 'pending' ? statusOf(card) === 'pending'
      : folder === 'analysis' ? statusOf(card) === 'keep' && !eligibleIds.has(card.id)
        : folder === 'rejected' ? statusOf(card) === 'reject' : folder === 'uncertain' ? statusOf(card) === 'uncertain' : card.folder === folder);
    return selected && matchesQuery(card, search.trim().toLocaleLowerCase());
  });
  const openedCard = cards.find((card) => card.id === opened) ?? managedCards.find((card) => card.id === opened);

  function upsert(additions: ReferenceCard[]): void {
    setManagedCards((current) => {
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
      setFolder('pending');
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

  async function controlJob(action: 'start' | 'stop', retryUncertain = false): Promise<void> {
    setJobAction(action);
    setError('');
    try {
      const result = await referenceAnalysis(action, undefined, pending + (retryUncertain ? audit?.uncertain ?? 0 : 0), audit?.scopeDigest, retryUncertain);
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
            <Text variant="label" tone="secondary">{ui('В библиотеке: {0}', format.format(cards.length))}</Text>
            {audit && <div className={styles.chips} aria-label={ui('Результаты проверки качества')}>
              <Text as="span" variant="caption" tone="secondary">{ui('Кандидаты: {0}', format.format(audit.total))}</Text>
              <Text as="span" variant="caption" tone="secondary">{ui('Прошли проверку: {0}', format.format(audit.kept))}</Text>
              <Text as="span" variant="caption" tone="secondary">{ui('Отклонены: {0}', format.format(audit.rejected))}</Text>
              <Text as="span" variant="caption" tone="secondary">{ui('Не определено: {0}', format.format(audit.uncertain))}</Text>
            </div>}
            {shared && <Text id="reference-upload-visibility" variant="label" tone="secondary">{ui('Загруженные кадры видят все пользователи студии.')}</Text>}
          </div>
          <div className={styles.pageActions}>
            <input ref={files} hidden type="file" multiple accept={FILE_TYPES} aria-label={ui('Фото и видео')} onChange={(event) => {
              const selected = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              void importFiles(selected);
            }} />
            {running ? <Button variant="border" loading={jobAction === 'stop'} disabled={jobAction === 'start'} onClick={() => void controlJob('stop')}>{ui('Остановить анализ')}</Button>
              : pending > 0 && <Button variant="border" loading={jobAction === 'start'} disabled={upload !== null || !audit} onClick={() => void controlJob('start')}>
                {ui('Проверить и разобрать')}
              </Button>}
            {!running && (audit?.uncertain ?? 0) > 0 && <Button variant="border" loading={jobAction === 'start'} disabled={upload !== null} onClick={() => void controlJob('start', true)}>{ui('Повторить проверку неопределённых')}</Button>}
            <Button variant="primary" size="m" loading={upload !== null} icon={<Icon name="plus" size={1} />} aria-describedby={shared ? 'reference-upload-visibility' : undefined} onClick={() => files.current?.click()}>{ui('Загрузить')}</Button>
          </div>
        </header>

        {audit && (audit.pending > 0 || waitingAnalysis > 0 || audit.uncertain > 0) && <div className={styles.status}>
          {audit.pending > 0 && <Text variant="label">{ui('Проверка качества ещё не выполнена для {0} кадров.', format.format(audit.pending))}</Text>}
          <Text variant="label" tone="secondary">{ui('Сначала проверяем качество и полезность, затем разбираем прошедшие кадры. Неопределённые результаты остаются вне библиотеки.')}</Text>
          {!running && <Text variant="caption" tone="secondary">{ui('По кнопке кадры отправятся в AI для проверки и разбора. Продолжение после остановки запускается вручную.')}</Text>}
        </div>}

        {((job && (mode === 'folders' || job.status !== 'done')) || upload || notice || error || failedUploads.length > 0) && <div className={styles.status}>
          {job && (mode === 'folders' || job.status !== 'done') && <div className={styles.job} role="status">
            <Text variant="label" medium>{running ? ui(job.phase === 'quality' ? 'Проверка качества' : 'Разбор прошедших кадров') : ui(JOB_COPY[job.status])}</Text>
            <Text variant="caption" tone="secondary">{job.phase === 'quality'
              ? ui('Проверено: {0} · Прошли: {1} · Отклонены: {2} · Не определено: {3}', format.format(job.reviewed ?? 0), format.format(job.kept ?? 0), format.format(job.rejected ?? 0), format.format(job.uncertain ?? 0))
              : ui('{0} из {1} кадров · токены {2} вход / {3} выход', format.format(analyzedCompleted), format.format(job.kept ?? job.total), format.format(job.inputTokens), format.format(job.outputTokens))}</Text>
            {running && <progress aria-label={ui('Прогресс анализа')} max={Math.max(1, job.phase === 'quality' ? job.total : job.kept ?? job.total)} value={job.phase === 'quality' ? job.reviewed ?? 0 : analyzedCompleted} />}
            {job.error && <Text variant="label" className={styles.error}>{ui(job.error)}</Text>}
          </div>}
          {upload && <Text variant="label" role="status">{ui('Загружаю {0} из {1} · {2}', upload.index, upload.total, upload.name)}</Text>}
          {notice && <Text variant="label" role="status">{notice}</Text>}
          {error && <div className={styles.row}><Text className={styles.error} variant="label" role="alert">{error}</Text>
            <Button variant="ghost" onClick={() => { setError(''); setLoadVersion((value) => value + 1); }}>{ui('Обновить')}</Button>
          </div>}
          {failedUploads.length > 0 && <ul className={styles.uploadErrors} role="alert">{failedUploads.map((entry, index) => <li key={index}>{entry}</li>)}</ul>}
        </div>}

        {audit && audit.total > 0 && <details className={styles.status}>
          <summary>{ui('Журнал проверки кадров')}</summary>
          <Text variant="label" tone="secondary">{ui('В поиск, граф и Canvas попадают только прошедшие проверку и разобранные кадры.')}</Text>
          {audit.reasons.map(({ reason, count }) => <Text key={reason} variant="caption">{reason} · {format.format(count)}</Text>)}
          {audit.retainedReferenced > 0 && <Text variant="caption" tone="secondary">{ui('Сохранены для закреплённых ссылок: {0}. Их допуск проверяется отдельно.', format.format(audit.retainedReferenced))}</Text>}
          <Text variant="caption" tone="secondary">{ui('Причина, модель и версия проверки доступны в карточках очереди и отклонённых кадров.')}</Text>
        </details>}

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
                    {filtered.slice(0, page * PAGE_SIZE).map((card) => <li key={card.id}>{managementFilter
                      ? <QualityReferencePreview card={card} decision={decisions.get(card.id)} onOpen={() => setOpened(card.id)} />
                      : <ReferenceCardPreview card={card} onOpen={() => setOpened(card.id)} />}</li>)}
                  </ul>
                  {filtered.length > page * PAGE_SIZE && <Button variant="border" onClick={() => setPage((value) => value + 1)}>{ui('Показать ещё')}</Button>}
                </> : <div className={styles.empty}>
                  <Icon name="images" size={1.5} />
                  <Text as="h2" variant="title-s" medium>{!loaded ? ui('Открываю библиотеку…') : (audit?.total ?? 0) === 0 ? ui('Добавь первые кадры') : !managementFilter && cards.length === 0 ? ui('Проверенные кадры появятся здесь') : ui('Здесь пока нет кадров')}</Text>
                  {loaded && (audit?.total ?? 0) === 0 && <Text tone="secondary">{ui('Загрузи фото или видео. Из ролика останутся стоп-кадры с таймкодами.')}</Text>}
                  {loaded && !managementFilter && cards.length === 0 && (audit?.total ?? 0) > 0 && <Text tone="secondary">{ui('Открой очередь «Ожидают проверки» и запусти проверку и разбор.')}</Text>}
                </div>}
              </section>
            </div>}
      </div>
      {openedCard && (eligibleIds.has(openedCard.id) ? <EditReferenceDialog key={openedCard.id} card={openedCard} onClose={() => setOpened(null)} onEdited={(updated) => {
        upsert([updated]); setCards((current) => current.map((card) => card.id === updated.id ? updated : card)); setOpened(null);
      }} /> : <QualityReferenceDialog card={openedCard} decision={decisions.get(openedCard.id)} onClose={() => setOpened(null)} />)}
    </main>
  );
}
