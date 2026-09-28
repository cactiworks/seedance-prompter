import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { estimate, findModel, formatCost, modelsOf, paramsFor, type GenModel } from '../../core/gen/models.ts';
import type { GenJob, MediaItem } from '../../core/model/media.ts';
import { hasRefsConsent, isActive, mediaUrl, useGen } from '../gen/genStore.ts';
import { Button, Icon, SegmentedControl, Text } from '../ui/components/index.ts';
import styles from './MediaPreview.module.css';

const formatDate = (iso: string): string => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const PARAM_RU: Record<string, string> = { resolution: 'Разрешение', aspectRatio: 'Формат', durationSec: 'Длительность', audio: 'Звук', variant: 'Вариант', background: 'Фон', mode: 'Режим', soulId: 'Soul ID', enhancePrompt: 'Улучшение промпта' };
const showValue = (v: unknown): string => (v === true ? 'да' : v === false ? 'нет' : v === '' ? '—' : String(v));

/** Модели, которыми можно править картинку: принимают референсы. */
const editModels = (): GenModel[] => modelsOf('image').filter((m) => m.refs.roles.includes('ref'));

const parentOf = (item: MediaItem): string | null => {
  const ref = item.refs.find((r) => r.source.type === 'media');
  return ref !== undefined && ref.source.type === 'media' ? ref.source.mediaId : null;
};

interface PreviewProps {
  item: MediaItem | null;
  onClose: () => void;
  onUseAsRef?: (item: MediaItem, target: 'image' | 'video') => void;
  /** Лента, по которой листать стрелками (в порядке показа). */
  list?: MediaItem[];
}

/**
 * Просмотр работы по образцу карточки Higgsfield: на весь экран, фон — сама работа размытая, слева версии,
 * справа «Инфо» (промпт, параметры, действия) и «Правка» (описать изменение — модель правит по этой картинке).
 */
export function MediaPreview({ item: opened, onClose, onUseAsRef, list }: PreviewProps) {
  const { jobs, library, folders, remix, regenerate, reveal, toggleFavorite, favorites, run, fileTo, loadLibrary } = useGen();
  const [current, setCurrent] = useState<MediaItem | null>(opened);
  const [tab, setTab] = useState<'info' | 'edit'>('info');
  const [copied, setCopied] = useState(false);
  const [editModel, setEditModel] = useState(editModels()[0]?.id ?? '');
  const [editRes, setEditRes] = useState('');
  const [editText, setEditText] = useState('');
  const [consent, setConsent] = useState(false);
  const [editState, setEditState] = useState<{ busy: boolean; messageRu: string | null }>({ busy: false, messageRu: null });
  const [folderMenu, setFolderMenu] = useState(false);

  useEffect(() => {
    setCurrent(opened);
    setTab('info');
    setEditState({ busy: false, messageRu: null });
  }, [opened]);

  const item = current;
  const siblings = list ?? [];
  const index = item === null ? -1 : siblings.findIndex((m) => m.id === item.id);

  useEffect(() => {
    if (item === null) return;
    const onKey = (event: KeyboardEvent): void => {
      const tag = (event.target as HTMLElement | null)?.tagName ?? '';
      if (event.key === 'Escape') onClose();
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      if (event.key === 'ArrowLeft' && index > 0) setCurrent(siblings[index - 1] ?? item);
      if (event.key === 'ArrowRight' && index >= 0 && index < siblings.length - 1) setCurrent(siblings[index + 1] ?? item);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, index, siblings, onClose]);

  // Версии: исходник (если эта работа — правка), сама работа, её правки; незаконченные правки — заглушками.
  const versions = useMemo(() => {
    if (item === null) return { done: [] as MediaItem[], pending: [] as GenJob[] };
    const rootId = parentOf(item) ?? item.id;
    const root = library.find((m) => m.id === rootId);
    const derived = library.filter((m) => parentOf(m) === rootId).sort((a, b) => a.savedAt.localeCompare(b.savedAt));
    const pending = jobs.filter((j) => isActive(j) && j.refs.some((r) => r.source.type === 'media' && r.source.mediaId === rootId));
    return { done: [...(root === undefined ? [] : [root]), ...derived], pending };
  }, [item, library, jobs]);

  if (item === null) return null;
  const job = jobs.find((j) => j.id === item.jobId);
  const model = findModel(item.modelId);
  const again = model === undefined ? null : estimate(model, paramsFor(model, item.params), 1, item.refs.length);
  const favorite = favorites.includes(item.id);

  const edit = findModel(editModel);
  const editParams = edit === undefined ? {} : paramsFor(edit, { ...item.params, ...(editRes !== '' ? { resolution: editRes } : {}) });
  const editCost = edit === undefined ? null : estimate(edit, editParams, 1, 1);
  const needConsent = !hasRefsConsent() && !consent;

  const startEdit = async (): Promise<void> => {
    if (edit === undefined || editCost === null || editText.trim() === '') return;
    setEditState({ busy: true, messageRu: null });
    try {
      const created = await run({
        modelId: edit.id,
        prompt: editText.trim(),
        params: editParams,
        refs: [{ label: 'Правка работы', source: { type: 'media', mediaId: item.id }, role: 'ref' }],
        count: 1,
        confirmCredits: editCost.credits,
        refsConsent: true,
        sessionId: item.sessionId ?? undefined,
      });
      const failed = created.find((j) => j.status === 'failed');
      setEditState({ busy: false, messageRu: failed?.error?.messageRu ?? 'Правка запущена — новая версия появится в ленте слева, файл сразу на диске.' });
      if (failed === undefined) setEditText('');
      void loadLibrary();
    } catch (error) {
      setEditState({ busy: false, messageRu: error instanceof Error ? error.message : 'Правка не запустилась.' });
    }
  };

  const facts: [string, string][] = [
    ['Модель', model?.titleRu ?? item.modelId],
    ...Object.entries(item.params).map(([k, v]): [string, string] => [PARAM_RU[k] ?? k, k === 'durationSec' ? `${String(v)} с` : showValue(v)]),
    ['Списано', item.creditsConsumed === null ? '—' : `${item.creditsConsumed} ${item.provider === 'higgsfield' ? '$' : 'кр'}`],
    ['Референсы', item.refs.length === 0 ? 'нет' : String(item.refs.length)],
    ['Создано', formatDate(item.savedAt)],
    ['Файл', `${item.file} · ${(item.bytes / 1024 / 1024).toFixed(1)} МБ`],
  ];

  return createPortal(
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Просмотр: ${model?.titleRu ?? ''}`}>
      <div className={styles.backdrop} style={{ backgroundImage: item.kind === 'image' ? `url(${mediaUrl(item.id)})` : undefined }} />

      {(versions.done.length > 1 || versions.pending.length > 0) && (
        <nav className={styles.versions} aria-label="Версии">
          {versions.done.map((v) => (
            <button key={v.id} type="button" className={`${styles.version} ${v.id === item.id ? styles.versionOn : ''}`} onClick={() => setCurrent(v)} title={parentOf(v) === null ? 'Исходник' : 'Правка'}>
              <img src={mediaUrl(v.id)} alt="" />
            </button>
          ))}
          {versions.pending.map((j) => (
            <span key={j.id} className={`${styles.version} ${styles.versionPending} lab-hatch`} title="Правка генерируется" />
          ))}
        </nav>
      )}

      <div className={styles.stage} onClick={(event) => event.target === event.currentTarget && onClose()}>
        {index > 0 && (
          <button type="button" className={`${styles.nav} ${styles.navPrev}`} onClick={() => setCurrent(siblings[index - 1] ?? item)} aria-label="Предыдущая">
            <Icon name="chevron-back" size={1.25} />
          </button>
        )}
        {item.kind === 'image' ? <img className={styles.media} src={mediaUrl(item.id)} alt={item.prompt.slice(0, 80)} /> : <video className={styles.media} src={mediaUrl(item.id)} controls autoPlay loop playsInline />}
        {index >= 0 && index < siblings.length - 1 && (
          <button type="button" className={`${styles.nav} ${styles.navNext}`} onClick={() => setCurrent(siblings[index + 1] ?? item)} aria-label="Следующая">
            <Icon name="chevron-forward" size={1.25} />
          </button>
        )}
      </div>

      <aside className={styles.panel}>
        <header className={styles.panelHead}>
          <div>
            <Text variant="label" medium>
              {model?.titleRu ?? item.modelId}
            </Text>
            <Text variant="caption" tone="secondary">
              {formatDate(item.savedAt)}
            </Text>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть (Esc)">
            <Icon name="close" size={1} />
          </button>
        </header>

        {item.kind === 'image' && (
          <SegmentedControl<'info' | 'edit'>
            aria-label="Вкладка"
            size="s"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'info', label: 'Инфо' },
              { value: 'edit', label: 'Правка' },
            ]}
          />
        )}

        {tab === 'info' && (
          <div className={styles.panelBody}>
            <section className={styles.block}>
              <div className={styles.blockHead}>
                <Text variant="caption" tone="tertiary" medium>
                  ПРОМПТ
                </Text>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => {
                    void navigator.clipboard.writeText(item.prompt);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  <Icon name={copied ? 'checkmark' : 'copy'} size={0.875} />
                  {copied ? 'Скопировано' : 'Копировать'}
                </button>
              </div>
              <Text variant="label" className={styles.prompt}>
                {item.prompt}
              </Text>
            </section>

            <section className={styles.block}>
              <dl className={styles.facts}>
                {facts.map(([k, v]) => (
                  <div key={k} className={styles.fact}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className={styles.actions}>
              {job !== undefined && (
                <>
                  <Button
                    variant="border"
                    size="s"
                    icon={<Icon name="options" size={1} />}
                    onClick={() => {
                      remix(job);
                      onClose();
                      window.location.hash = job.kind === 'image' ? '/images' : '/video';
                    }}
                  >
                    Использовать настройки
                  </Button>
                  <Button variant="dark" size="s" icon={<Icon name="arrow-redo" size={1} />} onClick={() => void regenerate(job)}>
                    Ещё раз{again === null ? '' : ` · ${formatCost(again)}`}
                  </Button>
                </>
              )}
              {item.kind === 'image' && onUseAsRef !== undefined && (
                <>
                  <Button variant="border" size="s" onClick={() => onUseAsRef(item, 'image')}>
                    Реф для картинки
                  </Button>
                  <Button variant="border" size="s" onClick={() => onUseAsRef(item, 'video')}>
                    Кадр / реф для видео
                  </Button>
                </>
              )}
              <Button variant="ghost" size="s" icon={<Icon name="star" size={1} />} onClick={() => void toggleFavorite(item.id)}>
                {favorite ? 'В избранном' : 'В избранное'}
              </Button>
              <Button variant="ghost" size="s" icon={<Icon name="folder" size={1} />} onClick={() => void reveal(item.id)}>
                В Finder
              </Button>
              <div className={styles.folderWrap}>
                <Button variant="ghost" size="s" icon={<Icon name="files" size={1} />} onClick={() => setFolderMenu((v) => !v)}>
                  В папку
                </Button>
                {folderMenu && (
                  <div className={styles.folderMenu} role="menu">
                    {folders.length === 0 && (
                      <Text variant="caption" tone="tertiary">
                        Папок пока нет — создай в библиотеке.
                      </Text>
                    )}
                    {folders.map((f) => {
                      const inside = f.mediaIds.includes(item.id);
                      return (
                        <button key={f.id} type="button" role="menuitemcheckbox" aria-checked={inside} onClick={() => void fileTo(f.id, [item.id], !inside)}>
                          <Icon name={inside ? 'checkmark' : 'plus'} size={0.875} />
                          {f.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {tab === 'edit' && item.kind === 'image' && (
          <div className={styles.panelBody}>
            <section className={styles.block}>
              <Text variant="caption" tone="tertiary" medium>
                ПРАВКА ПО ОПИСАНИЮ
              </Text>
              <Text variant="caption" tone="secondary">
                Эта картинка уйдёт референсом, модель сделает новую версию по твоему описанию. Исходник не меняется.
              </Text>
              <select className={styles.select} value={editModel} onChange={(event) => setEditModel(event.target.value)} aria-label="Модель правки">
                {editModels().map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.titleRu}
                  </option>
                ))}
              </select>
              {edit !== undefined && (
                <SegmentedControl<string>
                  aria-label="Разрешение"
                  size="s"
                  value={String(editParams.resolution)}
                  onChange={setEditRes}
                  options={(edit.params.find((p) => p.key === 'resolution')?.options ?? []).map((o) => ({ value: o, label: o }))}
                />
              )}
              <textarea className={styles.editText} rows={4} value={editText} onChange={(event) => setEditText(event.target.value)} placeholder="Опиши, как изменить: «сделай фон ночным, добавь неоновые отражения на асфальте»" />
              {needConsent && (
                <label className={styles.consent}>
                  <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                  <Text variant="caption">Картинка уйдёт в KIE, а оттуда исполнителю модели. Если на ней лицо — оно тоже уйдёт.</Text>
                </label>
              )}
              <Button variant="dark" size="m" icon={<Icon name="sparkle" size={1} />} loading={editState.busy} disabled={editText.trim() === '' || needConsent || editCost === null} onClick={() => void startEdit()}>
                Изменить{editCost === null ? '' : ` · ${formatCost(editCost)}`}
              </Button>
              {editState.messageRu !== null && (
                <Text variant="caption" tone="secondary">
                  {editState.messageRu}
                </Text>
              )}
            </section>
            <Text variant="caption" tone="tertiary">
              Upscale, удаление фона, relight и другие инструменты Higgsfield — отдельными моделями, когда решишь их подключить.
            </Text>
          </div>
        )}
      </aside>
    </div>,
    document.body,
  );
}
