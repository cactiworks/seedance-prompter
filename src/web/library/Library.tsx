import { ui } from '../language.ts';
import { remoteStudio } from '../download.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sourceTitleRu } from '../../core/gen/models.ts';
import { awaitingFiles } from '../../core/gen/jobStatus.ts';
import type { MediaItem } from '../../core/model/media.ts';
import { importMedia, mediaUrl, useGen } from '../gen/genStore.ts';
import { MediaPreview } from '../studio/MediaPreview.tsx';
import { JobTile } from '../studio/JobTile.tsx';
import { Button, Icon, Select, Text } from '../ui/components/index.ts';
import styles from './Library.module.css';

type View = { type: 'all' } | { type: 'favorites' } | { type: 'kind'; kind: 'image' | 'video' } | { type: 'folder'; id: string };

const SIZE_KEY = 'sp-library-size';
const readSize = (): number => {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    return v >= 8 && v <= 22 ? v : 12;
  } catch {
    return 12;
  }
};

const dayOf = (iso: string): string => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Архив всего сгенерированного — файлы на диске. Раскладка по образцу Assets у Higgsfield: слева разделы и
 * папки, работы по дням с «выбрать весь день», на карточке — выбор, избранное и меню, размер карточек ползунком.
 */
export function Library() {
  const { library, favorites, folders, jobs, loadLibrary, loadJobs, addRef, toggleFavorite, reveal, createFolder, renameFolder, deleteFolder, fileTo, deleteMedia, exportMedia } = useGen();
  const [view, setView] = useState<View>({ type: 'all' });
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<'new' | 'old'>('new');
  const [open, setOpen] = useState<MediaItem | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const [size, setSize] = useState(readSize);
  const [folderPick, setFolderPick] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importer = useRef<HTMLInputElement>(null);

  /** Свои файлы — в библиотеку по одному; ошибка одного не останавливает остальные. */
  const importFiles = async (files: File[]): Promise<void> => {
    setImporting(true);
    setImportError(null);
    const failed: string[] = [];
    for (const f of files) {
      try {
        await importMedia(f);
      } catch (e) {
        failed.push(`${f.name}: ${e instanceof Error ? e.message : 'не загрузилось'}`);
      }
    }
    await loadLibrary();
    setImporting(false);
    if (failed.length > 0) setImportError(failed.join(' · '));
  };

  useEffect(() => {
    void loadLibrary();
    void loadJobs();
  }, [loadLibrary, loadJobs]);

  const unfinished = jobs.filter((job) => (job.status !== 'saved' || awaitingFiles(job, library)) &&
    (view.type === 'all' || (view.type === 'kind' && job.kind === view.kind)) &&
    (query.trim() === '' || `${job.prompt} ${sourceTitleRu(job.modelId)}`.toLowerCase().includes(query.trim().toLowerCase())));

  const folder = view.type === 'folder' ? folders.find((f) => f.id === view.id) : undefined;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = library.filter(
      (item) =>
        (view.type === 'all' ||
          (view.type === 'favorites' && favorites.includes(item.id)) ||
          (view.type === 'kind' && item.kind === view.kind) ||
          (view.type === 'folder' && (folder?.mediaIds.includes(item.id) ?? false))) &&
        (q === '' || item.prompt.toLowerCase().includes(q) || sourceTitleRu(item.modelId).toLowerCase().includes(q)),
    );
    return order === 'new' ? list : [...list].reverse();
  }, [library, favorites, view, folder, query, order]);

  const days = useMemo(() => {
    const groups = new Map<string, MediaItem[]>();
    for (const item of shown) groups.set(dayOf(item.savedAt), [...(groups.get(dayOf(item.savedAt)) ?? []), item]);
    return [...groups.entries()];
  }, [shown]);

  const toggle = (ids: string[], on: boolean): void => setSelected((s) => (on ? [...new Set([...s, ...ids])] : s.filter((id) => !ids.includes(id))));
  const setCardSize = (v: number): void => {
    setSize(v);
    try {
      localStorage.setItem(SIZE_KEY, String(v));
    } catch {
      /* не запомним */
    }
  };
  const useAsRef = (item: MediaItem, target: 'image' | 'video'): void => {
    addRef(target, { label: ui("Из библиотеки · {0}", sourceTitleRu(item.modelId)), source: { type: 'media', mediaId: item.id } });
    setOpen(null);
    window.location.hash = target === 'image' ? '/images' : '/video';
  };

  const title = view.type === 'all' ? 'Все работы' : view.type === 'favorites' ? 'Избранное' : view.type === 'kind' ? (view.kind === 'image' ? 'Картинки' : 'Видео') : (folder?.name ?? 'Папка');
  const nav = (v: View, label: string, icon: Parameters<typeof Icon>[0]['name'], count: number) => {
    const active = JSON.stringify(v) === JSON.stringify(view);
    return (
      <button type="button" className={`${styles.navItem} ${active ? styles.navActive : ''}`} onClick={() => setView(v)}>
        <Icon name={icon} size={1} />
        <span>{label}</span>
        <em>{count}</em>
      </button>
    );
  };

  return (
    <div className={styles.page}>
      <aside className={styles.rail}>
        <label className={styles.search}>
          <Icon name="search" size={1} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={ui("Поиск по промпту")} />
        </label>
        {nav({ type: 'all' }, ui("Все"), 'apps', library.length)}
        {nav({ type: 'favorites' }, ui("Избранное"), 'star', favorites.filter((f) => library.some((m) => m.id === f)).length)}
        {nav({ type: 'kind', kind: 'image' }, ui("Картинки"), 'image', library.filter((m) => m.kind === 'image').length)}
        {nav({ type: 'kind', kind: 'video' }, ui("Видео"), 'video', library.filter((m) => m.kind === 'video').length)}
        <div className={styles.railHead}>
          <Text variant="caption" tone="tertiary">
            {ui("Папки")}</Text>
          <button
            type="button"
            className={styles.iconButton}
            title={ui("Новая папка")}
            onClick={() =>
              void createFolder('Новая папка').then((f) => {
                setView({ type: 'folder', id: f.id });
                setEditing({ id: f.id, name: f.name });
              })
            }
          >
            <Icon name="plus" size={0.875} />
          </button>
        </div>
        {folders.map((f) =>
          editing?.id === f.id ? (
            <input
              key={f.id}
              className={styles.rename}
              autoFocus
              value={editing.name}
              onChange={(event) => setEditing({ id: f.id, name: event.target.value })}
              onBlur={() => {
                if (editing.name.trim() !== '' && editing.name !== f.name) void renameFolder(f.id, editing.name);
                setEditing(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') setEditing(null);
              }}
            />
          ) : (
            <div key={f.id} className={styles.folderRow} onDoubleClick={() => setEditing({ id: f.id, name: f.name })} title={ui("Двойной клик — переименовать")}>
              {nav({ type: 'folder', id: f.id }, f.name, 'folder', f.mediaIds.filter((id) => library.some((m) => m.id === id)).length)}
            </div>
          ),
        )}
        {folders.length === 0 && (
          <Text variant="caption" tone="tertiary" className={styles.railHint}>
            {ui("Папки — как проекты: одна работа может лежать в нескольких.")}</Text>
        )}
      </aside>

      <section className={styles.main} data-guide="library-items">
        <header className={styles.head}>
          <div>
            <Text as="h1" variant="title-l" medium>
              {title}
            </Text>
            <Text variant="label" tone="secondary">
              {ui("показано ")}{shown.length} {ui(" из ")}{library.length} · {remoteStudio ? ui("файлы сохранены на общем сервере") : ui("файлы сохранены на этом компьютере")}
            </Text>
            {importError !== null && (
              <Text variant="caption" tone="accent">
                {importError}
              </Text>
            )}
          </div>
          <div className={styles.tools}>
            <input
              ref={importer}
              type="file"
              accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm"
              multiple
              hidden
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = '';
                void importFiles(files);
              }}
            />
            <Button variant="border" size="xs" icon={<Icon name="upload" size={0.875} />} loading={importing} title={ui("Свои картинки и видео — съёмки, референсы; дальше их можно резать и отдавать в canvas")} onClick={() => importer.current?.click()}>
              {ui("Добавить файлы")}</Button>
            {folder !== undefined && (
              <Button variant="ghost" size="xs" icon={<Icon name="bin" size={0.875} />} title={ui("Удалить папку — файлы останутся")} onClick={() => void deleteFolder(folder.id).then(() => setView({ type: 'all' }))}>
                {ui("Удалить папку")}</Button>
            )}
            <label className={styles.size} title={ui("Размер карточек")}>
              <Icon name="image" size={0.75} />
              <input type="range" min={8} max={22} value={size} onChange={(event) => setCardSize(Number(event.target.value))} aria-label={ui("Размер карточек")} />
              <Icon name="image" size={1.125} />
            </label>
            <div className={styles.order}>
              <Select label={ui("Дата")} value={order} onChange={(v) => setOrder(v === 'old' ? 'old' : 'new')} options={[{ value: 'new', label: ui("Сначала новые") }, { value: 'old', label: ui("Сначала старые") }]} />
            </div>
          </div>
        </header>

        {unfinished.length > 0 && <section className={styles.day} aria-label={ui("Задачи генерации")}>
          <Text as="h2" variant="title-s">{ui("В работе и требуют внимания · ")}{unfinished.length}</Text>
          <Text variant="caption" tone="secondary">{ui("Генерации со всех холстов и правки. Готовый файл появится ниже автоматически; ошибка останется здесь.")}</Text>
          <div className={styles.grid} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}rem, 1fr))` }}>
            {(order === 'new' ? unfinished : [...unfinished].reverse()).map((job) => <JobTile key={job.id} job={job} onOpen={(id) => setOpen(library.find((m) => m.id === id) ?? null)} />)}
          </div>
        </section>}

        {selected.length > 0 && (
          <div className={styles.selectionBar}>
            <Text variant="label" medium>
              {ui("Выбрано: ")}{selected.length}
            </Text>
            <div className={styles.pickWrap}>
              <Button variant="border" size="xs" icon={<Icon name="files" size={0.875} />} onClick={() => setFolderPick((v) => !v)}>
                {ui("В папку")}</Button>
              {folderPick && (
                <div className={styles.menu} role="menu">
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        void fileTo(f.id, selected, true);
                        setFolderPick(false);
                      }}
                    >
                      <Icon name="folder" size={0.875} />
                      {f.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      void createFolder('Новая папка').then((f) => fileTo(f.id, selected, true));
                      setFolderPick(false);
                    }}
                  >
                    <Icon name="plus" size={0.875} />
                    {ui("Новая папка")}</button>
                </div>
              )}
            </div>
            {folder !== undefined && (
              <Button variant="ghost" size="xs" onClick={() => void fileTo(folder.id, selected, false).then(() => setSelected([]))}>
                {ui("Убрать из папки")}</Button>
            )}
            <Button
              variant="border"
              size="xs"
              icon={<Icon name="download" size={0.875} />}
              title={remoteStudio ? ui("Скачать ZIP с понятными именами для монтажа") : ui("Копии с понятными именами — в папку для монтажа, откроется в Finder")}
              onClick={() =>
                void exportMedia(selected)
                  .then((r) => setImportError(r.downloadUrl ? `Архив готов: ${r.files.length} файлов` : `Выгружено файлов: ${r.files.length} → ${r.dir}`))
                  .catch((e: unknown) => setImportError(e instanceof Error ? e.message : 'Не выгрузилось.'))
              }
            >
              {ui("Выгрузить для монтажа")}</Button>
            {confirmDelete ? (
              <>
                <Button
                  variant="dangerFill"
                  size="xs"
                  icon={<Icon name="bin" size={0.875} />}
                  onClick={() =>
                    void deleteMedia(selected).then(() => {
                      setSelected([]);
                      setConfirmDelete(false);
                    })
                  }
                >
                  {ui("Удалить ")}{selected.length} {ui(" с диска навсегда")}</Button>
                <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(false)}>
                  {ui("Отмена")}</Button>
              </>
            ) : (
              <Button variant="ghost" size="xs" icon={<Icon name="bin" size={0.875} />} onClick={() => setConfirmDelete(true)}>
                {ui("Удалить")}</Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setSelected([]);
                setConfirmDelete(false);
              }}
            >
              {ui("Снять выделение")}</Button>
          </div>
        )}

        {shown.length === 0 ? (
          <div className={`${styles.empty} lab-hatch`}>
            <Text variant="label" tone="tertiary">
              {unfinished.length > 0 ? ui("Готовых файлов по этому фильтру пока нет. Статусы задач показаны выше.") : library.length === 0 ? ui("Здесь будут готовые изображения и видео. Свои референсы можно загрузить кнопкой «Добавить файлы».") : view.type === 'folder' ? ui("Папка пуста. Выбери работы и нажми «В папку».") : ui("Ничего не нашлось.")}
            </Text>
          </div>
        ) : (
          days.map(([day, items]) => {
            const all = items.every((i) => selected.includes(i.id));
            return (
              <section key={day} className={styles.day}>
                <label className={styles.dayHead}>
                  <input type="checkbox" checked={all} onChange={(event) => toggle(items.map((i) => i.id), event.target.checked)} aria-label={ui("Выбрать всё за {0}", day)} />
                  <Text variant="title-s" medium>
                    {day}
                  </Text>
                </label>
                <div className={styles.grid} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}rem, 1fr))` }}>
                  {items.map((item) => {
                    const isSel = selected.includes(item.id);
                    const fav = favorites.includes(item.id);
                    return (
                      <div key={item.id} className={`${styles.card} ${isSel ? styles.cardSelected : ''}`}>
                        <button type="button" className={styles.media} onClick={() => (selected.length > 0 ? toggle([item.id], !isSel) : setOpen(item))} aria-label={ui("Открыть")}>
                          {item.kind === 'image' ? <img src={mediaUrl(item.id)} alt={item.prompt.slice(0, 80)} loading="lazy" /> : <video src={mediaUrl(item.id)} muted preload="metadata" />}
                        </button>
                        <input type="checkbox" className={styles.check} checked={isSel} onChange={(event) => toggle([item.id], event.target.checked)} aria-label={ui("Выбрать")} />
                        <button type="button" className={`${styles.cardButton} ${styles.heart} ${fav ? styles.heartOn : ''}`} onClick={() => void toggleFavorite(item.id)} aria-label={fav ? ui("Убрать из избранного") : ui("В избранное")}>
                          <Icon name="star" size={0.875} />
                        </button>
                        {item.kind === 'video' && (
                          <span className={styles.kind}>
                            <Icon name="video" size={0.75} />
                          </span>
                        )}
                        <button type="button" className={`${styles.cardButton} ${styles.more}`} onClick={() => setMenu((m) => (m === item.id ? null : item.id))} aria-label={ui("Действия")}>
                          <Icon name="ellipsis-horizontal" size={0.875} />
                        </button>
                        {menu === item.id && (
                          <div className={`${styles.menu} ${styles.cardMenu}`} role="menu" onMouseLeave={() => setMenu(null)}>
                            <button type="button" role="menuitem" onClick={() => (setOpen(item), setMenu(null))}>
                              <Icon name="eye" size={0.875} />
                              {ui("Открыть")}</button>
                            {item.kind === 'image' && (
                              <>
                                <button type="button" role="menuitem" onClick={() => useAsRef(item, 'image')}>
                                  <Icon name="image" size={0.875} />
                                  {ui("Реф для картинки")}</button>
                                <button type="button" role="menuitem" onClick={() => useAsRef(item, 'video')}>
                                  <Icon name="video" size={0.875} />
                                  {ui("Кадр / реф для видео")}</button>
                              </>
                            )}
                            {folders.map((f) => {
                              const inside = f.mediaIds.includes(item.id);
                              return (
                                <button key={f.id} type="button" role="menuitemcheckbox" aria-checked={inside} onClick={() => void fileTo(f.id, [item.id], !inside)}>
                                  <Icon name={inside ? 'checkmark' : 'folder'} size={0.875} />
                                  {inside ? ui("В папке «{0}»", f.name) : ui("В папку «{0}»", f.name)}
                                </button>
                              );
                            })}
                            <button type="button" role="menuitem" onClick={() => (void reveal(item.id), setMenu(null))}>
                              <Icon name="folder" size={0.875} />
                              {remoteStudio ? ui("Скачать файл") : ui("Показать в Finder")}
                            </button>
                          </div>
                        )}
                        <span className={styles.caption}>
                          <Text variant="caption" tone="secondary">
                            {sourceTitleRu(item.modelId)}
                          </Text>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
      </section>

      <MediaPreview item={open} list={shown} onClose={() => setOpen(null)} onUseAsRef={useAsRef} />
    </div>
  );
}
