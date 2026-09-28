import { useEffect, useMemo, useState } from 'react';
import { findModel } from '../../core/gen/models.ts';
import type { MediaItem } from '../../core/model/media.ts';
import { mediaUrl, useGen } from '../gen/genStore.ts';
import { MediaPreview } from '../studio/MediaPreview.tsx';
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
  const { library, favorites, folders, jobs, loadLibrary, loadJobs, addRef, toggleFavorite, reveal, createFolder, renameFolder, deleteFolder, fileTo } = useGen();
  const [view, setView] = useState<View>({ type: 'all' });
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<'new' | 'old'>('new');
  const [open, setOpen] = useState<MediaItem | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const [size, setSize] = useState(readSize);
  const [folderPick, setFolderPick] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    void loadLibrary();
    if (jobs.length === 0) void loadJobs();
  }, [loadLibrary, loadJobs, jobs.length]);

  const folder = view.type === 'folder' ? folders.find((f) => f.id === view.id) : undefined;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = library.filter(
      (item) =>
        (view.type === 'all' ||
          (view.type === 'favorites' && favorites.includes(item.id)) ||
          (view.type === 'kind' && item.kind === view.kind) ||
          (view.type === 'folder' && (folder?.mediaIds.includes(item.id) ?? false))) &&
        (q === '' || item.prompt.toLowerCase().includes(q) || (findModel(item.modelId)?.titleRu.toLowerCase().includes(q) ?? false)),
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
    addRef(target, { label: `Из библиотеки · ${findModel(item.modelId)?.titleRu ?? ''}`, source: { type: 'media', mediaId: item.id } });
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
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по промпту" />
        </label>
        {nav({ type: 'all' }, 'Все', 'apps', library.length)}
        {nav({ type: 'favorites' }, 'Избранное', 'star', favorites.filter((f) => library.some((m) => m.id === f)).length)}
        {nav({ type: 'kind', kind: 'image' }, 'Картинки', 'image', library.filter((m) => m.kind === 'image').length)}
        {nav({ type: 'kind', kind: 'video' }, 'Видео', 'video', library.filter((m) => m.kind === 'video').length)}
        <div className={styles.railHead}>
          <Text variant="caption" tone="tertiary">
            Папки
          </Text>
          <button
            type="button"
            className={styles.iconButton}
            title="Новая папка"
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
            <div key={f.id} className={styles.folderRow} onDoubleClick={() => setEditing({ id: f.id, name: f.name })} title="Двойной клик — переименовать">
              {nav({ type: 'folder', id: f.id }, f.name, 'folder', f.mediaIds.filter((id) => library.some((m) => m.id === id)).length)}
            </div>
          ),
        )}
        {folders.length === 0 && (
          <Text variant="caption" tone="tertiary" className={styles.railHint}>
            Папки — как проекты: одна работа может лежать в нескольких.
          </Text>
        )}
      </aside>

      <section className={styles.main}>
        <header className={styles.head}>
          <div>
            <Text as="h1" variant="title-l" medium>
              {title}
            </Text>
            <Text variant="label" tone="secondary">
              показано {shown.length} из {library.length} · файлы на диске, KIE их больше не держит
            </Text>
          </div>
          <div className={styles.tools}>
            {folder !== undefined && (
              <Button variant="ghost" size="xs" icon={<Icon name="bin" size={0.875} />} title="Удалить папку — файлы останутся" onClick={() => void deleteFolder(folder.id).then(() => setView({ type: 'all' }))}>
                Удалить папку
              </Button>
            )}
            <label className={styles.size} title="Размер карточек">
              <Icon name="image" size={0.75} />
              <input type="range" min={8} max={22} value={size} onChange={(event) => setCardSize(Number(event.target.value))} aria-label="Размер карточек" />
              <Icon name="image" size={1.125} />
            </label>
            <div className={styles.order}>
              <Select label="Дата" value={order} onChange={(v) => setOrder(v === 'old' ? 'old' : 'new')} options={[{ value: 'new', label: 'Сначала новые' }, { value: 'old', label: 'Сначала старые' }]} />
            </div>
          </div>
        </header>

        {selected.length > 0 && (
          <div className={styles.selectionBar}>
            <Text variant="label" medium>
              Выбрано: {selected.length}
            </Text>
            <div className={styles.pickWrap}>
              <Button variant="border" size="xs" icon={<Icon name="files" size={0.875} />} onClick={() => setFolderPick((v) => !v)}>
                В папку
              </Button>
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
                    Новая папка
                  </button>
                </div>
              )}
            </div>
            {folder !== undefined && (
              <Button variant="ghost" size="xs" onClick={() => void fileTo(folder.id, selected, false).then(() => setSelected([]))}>
                Убрать из папки
              </Button>
            )}
            <Button variant="ghost" size="xs" onClick={() => setSelected([])}>
              Снять выделение
            </Button>
          </div>
        )}

        {shown.length === 0 ? (
          <div className={`${styles.empty} lab-hatch`}>
            <Text variant="label" tone="tertiary">
              {library.length === 0 ? 'Здесь появится всё, что ты сгенерируешь, — файлы сразу сохраняются на диск.' : view.type === 'folder' ? 'Папка пуста. Выбери работы и нажми «В папку».' : 'Ничего не нашлось.'}
            </Text>
          </div>
        ) : (
          days.map(([day, items]) => {
            const all = items.every((i) => selected.includes(i.id));
            return (
              <section key={day} className={styles.day}>
                <label className={styles.dayHead}>
                  <input type="checkbox" checked={all} onChange={(event) => toggle(items.map((i) => i.id), event.target.checked)} aria-label={`Выбрать всё за ${day}`} />
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
                        <button type="button" className={styles.media} onClick={() => (selected.length > 0 ? toggle([item.id], !isSel) : setOpen(item))} aria-label="Открыть">
                          {item.kind === 'image' ? <img src={mediaUrl(item.id)} alt={item.prompt.slice(0, 80)} loading="lazy" /> : <video src={mediaUrl(item.id)} muted preload="metadata" />}
                        </button>
                        <input type="checkbox" className={styles.check} checked={isSel} onChange={(event) => toggle([item.id], event.target.checked)} aria-label="Выбрать" />
                        <button type="button" className={`${styles.cardButton} ${styles.heart} ${fav ? styles.heartOn : ''}`} onClick={() => void toggleFavorite(item.id)} aria-label={fav ? 'Убрать из избранного' : 'В избранное'}>
                          <Icon name="star" size={0.875} />
                        </button>
                        {item.kind === 'video' && (
                          <span className={styles.kind}>
                            <Icon name="video" size={0.75} />
                          </span>
                        )}
                        <button type="button" className={`${styles.cardButton} ${styles.more}`} onClick={() => setMenu((m) => (m === item.id ? null : item.id))} aria-label="Действия">
                          <Icon name="ellipsis-horizontal" size={0.875} />
                        </button>
                        {menu === item.id && (
                          <div className={`${styles.menu} ${styles.cardMenu}`} role="menu" onMouseLeave={() => setMenu(null)}>
                            <button type="button" role="menuitem" onClick={() => (setOpen(item), setMenu(null))}>
                              <Icon name="eye" size={0.875} />
                              Открыть
                            </button>
                            {item.kind === 'image' && (
                              <>
                                <button type="button" role="menuitem" onClick={() => useAsRef(item, 'image')}>
                                  <Icon name="image" size={0.875} />
                                  Реф для картинки
                                </button>
                                <button type="button" role="menuitem" onClick={() => useAsRef(item, 'video')}>
                                  <Icon name="video" size={0.875} />
                                  Кадр / реф для видео
                                </button>
                              </>
                            )}
                            {folders.map((f) => {
                              const inside = f.mediaIds.includes(item.id);
                              return (
                                <button key={f.id} type="button" role="menuitemcheckbox" aria-checked={inside} onClick={() => void fileTo(f.id, [item.id], !inside)}>
                                  <Icon name={inside ? 'checkmark' : 'folder'} size={0.875} />
                                  {inside ? `В папке «${f.name}»` : `В папку «${f.name}»`}
                                </button>
                              );
                            })}
                            <button type="button" role="menuitem" onClick={() => (void reveal(item.id), setMenu(null))}>
                              <Icon name="folder" size={0.875} />
                              Показать в Finder
                            </button>
                          </div>
                        )}
                        <span className={styles.caption}>
                          <Text variant="caption" tone="secondary">
                            {findModel(item.modelId)?.titleRu ?? item.modelId}
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
