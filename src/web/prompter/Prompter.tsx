import { useEffect, useRef, useState, type ReactNode } from 'react';
import { estimate, findModel, formatCost, modelsOf, type GenParams, type MediaKind } from '../../core/gen/models.ts';
import { agentParams, hasStyles, PROMPTER_MAX_REFS, PROMPTER_REF_ROLE_RU, PROMPTER_REF_ROLES, type PrompterRefRole } from '../../core/llm/buildPrompter.ts';
import { mediaUrl, thumbOf, useGen } from '../gen/genStore.ts';
import { useStore } from '../store.ts';
import { Button, Dialog, Icon, SegmentedControl, Select, Tag, Text, TextField } from '../ui/components/index.ts';
import styles from './Prompter.module.css';
import { hasImagesConsent, rememberImagesConsent, usePrompter, type PrompterEntry, type PrompterFormRef } from './prompterStore.ts';

const KIND_OPTIONS: { value: MediaKind; label: string }[] = [
  { value: 'image', label: 'Картинка' },
  { value: 'video', label: 'Видео' },
];

const ASPECTS = ['9:16', '3:4', '2:3', '1:1', '4:3', '3:2', '16:9', '21:9'];

const COMMENT_HINT: Record<PrompterRefRole, string> = {
  character: 'Кто это и что сохранить: «это я — лицо и причёска как на фото»',
  style: 'Что взять: цвет, свет, зерно — не сюжет',
  location: 'Что за место и что в нём оставить',
  object: 'Что за предмет и каким он должен быть в кадре',
  other: 'Зачем эта картинка',
  start: 'Что происходит дальше с этого кадра',
  end: 'Чем должен закончиться ролик',
};

/** Только выбор агента: seed, Soul ID и улучшение промпта в форме студии остаются как были. */
function agentChoice(entry: PrompterEntry): GenParams {
  const model = findModel(entry.result.modelId);
  if (model === undefined) return {};
  const keys = [...agentParams(model).map((d) => d.key), ...(hasStyles(model) ? ['styleId'] : [])];
  return Object.fromEntries(keys.filter((key) => entry.result.params[key] !== undefined).map((key) => [key, entry.result.params[key] as GenParams[string]]));
}

const refTitle = (ref: PrompterFormRef): string => `${PROMPTER_REF_ROLE_RU[ref.role]}${ref.commentRu.trim() !== '' ? ` · ${ref.commentRu.trim()}` : ''}`;

/** Как каждая картинка дошла до модели: номером в промпте, кадром или только словами агента. */
function RefsUsed({ entry }: { entry: PrompterEntry }) {
  const model = findModel(entry.result.modelId);
  if (model === undefined || entry.refs.length === 0) return null;
  const how = new Map<number, string>();
  let n = 0;
  for (const r of entry.result.refs) {
    if (r.role !== 'ref') how.set(r.index, r.role === 'start' ? 'первый кадр' : 'последний кадр');
    else how.set(r.index, model.promptRefs === 'at-image' ? `@Image${(n += 1)}` : `image ${(n += 1)}`);
  }
  return (
    <section className={styles.block}>
      <Text variant="caption" tone="secondary">
        Картинки в модель
      </Text>
      <div className={styles.used}>
        {entry.refs.map((ref, index) => (
          <div key={ref.key} className={styles.usedItem} title={refTitle(ref)}>
            <img className={styles.usedThumb} src={thumbOf(ref.source)} alt="" />
            <Text variant="caption" medium>
              {how.get(index) ?? 'словами'}
            </Text>
            <Text variant="caption" tone="tertiary">
              {PROMPTER_REF_ROLE_RU[ref.role]}
            </Text>
          </div>
        ))}
      </div>
      {entry.refs.length > entry.result.refs.length && (
        <Text variant="caption" tone="tertiary">
          «Словами» — {model.titleRu} эту картинку не получит, агент описал из неё главное текстом.
        </Text>
      )}
    </section>
  );
}

function Result({ entry, onWrite }: { entry: PrompterEntry; onWrite: (commentRu?: string) => void }) {
  const running = usePrompter((s) => s.running);
  const styleList = useGen((s) => s.styles.higgsfield);
  const { loadStyles, applyPrompt } = useGen();
  const [comment, setComment] = useState('');
  const [copied, setCopied] = useState(false);
  const model = findModel(entry.result.modelId);
  const style = styleList?.find((s) => s.name === entry.result.styleName);

  useEffect(() => {
    if (entry.result.styleName !== '' && styleList === undefined) void loadStyles('higgsfield');
  }, [entry.result.styleName, styleList, loadStyles]);
  useEffect(() => setComment(''), [entry.id]);

  if (model === undefined) return null;
  const cost = formatCost(estimate(model, entry.result.params, 1, entry.result.refs.length));
  const copy = (): void => {
    void navigator.clipboard.writeText(entry.result.prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const toStudio = (): void => {
    const refs = entry.result.refs.flatMap((r) => {
      const ref = entry.refs[r.index];
      return ref === undefined ? [] : [{ label: refTitle(ref), source: ref.source, role: r.role }];
    });
    applyPrompt(model.kind, model.id, agentChoice(entry), entry.result.prompt, refs);
    window.location.hash = model.kind === 'image' ? '/images' : '/video';
  };

  return (
    <article className={styles.result}>
      <header className={styles.resultHead}>
        <div className={styles.stack}>
          <Text variant="caption" tone="secondary">
            Модель
          </Text>
          <span className={styles.modelLine}>
            <Text variant="title-m" medium>
              {model.titleRu}
            </Text>
            <Tag tone={entry.choice === 'auto' ? 'accent' : 'neutral'}>{entry.choice === 'auto' ? 'выбрал агент' : 'твой выбор'}</Tag>
          </span>
        </div>
        <div className={`${styles.stack} ${styles.costBox}`}>
          <Text variant="caption" tone="secondary">
            {model.kind === 'image' ? 'Цена картинки' : 'Цена ролика'}
          </Text>
          <Text variant="label" medium>
            {cost}
          </Text>
        </div>
      </header>
      {entry.result.reasonRu !== '' && <Text tone="secondary">{entry.result.reasonRu}</Text>}

      <section className={styles.block}>
        <div className={styles.blockHead}>
          <Text variant="caption" tone="secondary">
            Промпт · {entry.result.prompt.length} знаков
          </Text>
          <Button variant="ghost" size="xs" icon={<Icon name={copied ? 'checkmark' : 'copy'} size={0.875} />} onClick={copy}>
            {copied ? 'Скопировано' : 'Копировать'}
          </Button>
        </div>
        <pre className={styles.prompt}>{entry.result.prompt}</pre>
      </section>

      <RefsUsed entry={entry} />

      <section className={styles.block}>
        <Text variant="caption" tone="secondary">
          Параметры
        </Text>
        <div className={styles.tags}>
          {agentParams(model).map((def) => {
            const value = entry.result.params[def.key];
            const shown = def.type === 'bool' ? (value === true ? 'да' : 'нет') : def.type === 'int' && def.key === 'durationSec' ? `${String(value)} с` : (def.optionLabelsRu?.[String(value)] ?? String(value));
            return (
              <Tag key={def.key} tone="outline">
                {def.labelRu}: {shown}
              </Tag>
            );
          })}
        </div>
        {hasStyles(model) && (
          <div className={styles.mood}>
            {style?.previewUrl != null ? <img className={styles.moodPreview} src={style.previewUrl} alt="" /> : <span className={`${styles.moodPreview} lab-hatch`} />}
            <div className={styles.stack}>
              <Text variant="caption" tone="secondary">
                Мудборд
              </Text>
              <Text variant="label" medium>
                {entry.result.styleName === '' ? 'Без мудборда' : entry.result.styleName}
              </Text>
            </div>
          </div>
        )}
      </section>

      {entry.result.weakSpotsRu.length > 0 && (
        <section className={styles.block}>
          <Text variant="caption" tone="secondary">
            Где может сломаться
          </Text>
          <ul className={styles.spots}>
            {entry.result.weakSpotsRu.map((spot) => (
              <li key={spot} className={styles.spot}>
                <span className={styles.spotIcon}>
                  <Icon name="warning" size={1} />
                </span>
                <Text variant="label">{spot}</Text>
              </li>
            ))}
          </ul>
        </section>
      )}

      {entry.result.alternativesRu !== '' && (
        <section className={styles.block}>
          <Text variant="caption" tone="secondary">
            Если не подойдёт
          </Text>
          <Text variant="label">{entry.result.alternativesRu}</Text>
        </section>
      )}

      {entry.problems.length > 0 && (
        <section className={styles.block}>
          <Text variant="caption" tone="secondary">
            Проверка не прошла и после ремонтного круга — поправь вручную в студии
          </Text>
          {entry.problems.map((problem) => (
            <Text key={problem} variant="caption" tone="tertiary" mono>
              {problem}
            </Text>
          ))}
        </section>
      )}

      <div className={styles.actions}>
        <Button variant="primary" size="m" icon={<Icon name="arrow-forward" size={1} />} onClick={toStudio}>
          В студию
        </Button>
        <Text variant="caption" tone="tertiary">
          Промпт, параметры{entry.result.refs.length > 0 ? ' и картинки' : ''} встанут в форму {model.kind === 'image' ? '«Картинок»' : '«Видео»'}; генерация — там, по кнопке с ценой.
        </Text>
      </div>

      <section className={styles.rewrite}>
        <TextField
          label="Что поправить"
          multiline
          rows={2}
          value={comment}
          placeholder="Например: кадр шире, без текста, вечерний свет"
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && comment.trim() !== '' && !running) onWrite(comment);
          }}
        />
        <Button variant="border" icon={<Icon name="arrow-redo" size={1} />} disabled={comment.trim() === '' || running} loading={running} onClick={() => onWrite(comment)}>
          Переписать
        </Button>
      </section>

      <Text variant="caption" tone="tertiary">
        {entry.commentRu !== '' ? `Правка: «${entry.commentRu}» · ` : ''}
        {entry.llmModel ?? 'агент'} · {Math.round(entry.durationMs / 1000)} с · {new Date(entry.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
      </Text>
    </article>
  );
}

function Section({ n, title, note, children }: { n: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <Text variant="caption" tone="tertiary" mono>
          {n}
        </Text>
        <div className={styles.stack}>
          <Text as="h2" variant="label" medium>
            {title}
          </Text>
          {note !== undefined && (
            <Text variant="caption" tone="secondary">
              {note}
            </Text>
          )}
        </div>
      </header>
      {children}
    </section>
  );
}

function RefRow({ item, index, count }: { item: PrompterFormRef; index: number; count: number }) {
  const { kind, patchRef, moveRef, removeRef } = usePrompter();
  const roles = PROMPTER_REF_ROLES.filter((role) => kind === 'video' || (role !== 'start' && role !== 'end'));
  return (
    <div className={styles.refRow}>
      <div className={styles.refThumbWrap}>
        <img className={styles.refThumb} src={thumbOf(item.source)} alt={item.label} />
        <span className={styles.refNumber}>{index + 1}</span>
      </div>
      <div className={styles.refFields}>
        <div className={styles.refTop}>
          <Select label="Что это" value={item.role} onChange={(role) => patchRef(item.key, { role: role as PrompterRefRole })} options={roles.map((role) => ({ value: role, label: PROMPTER_REF_ROLE_RU[role] }))} />
          <span className={styles.refActions}>
            <Button variant="ghost" size="xs" iconOnly aria-label="Выше" icon={<Icon name="chevron-up" size={1} />} disabled={index === 0} onClick={() => moveRef(item.key, -1)} />
            <Button variant="ghost" size="xs" iconOnly aria-label="Ниже" icon={<Icon name="chevron-down" size={1} />} disabled={index === count - 1} onClick={() => moveRef(item.key, 1)} />
            <Button variant="ghost" size="xs" iconOnly aria-label="Убрать" icon={<Icon name="close" size={1} />} onClick={() => removeRef(item.key)} />
          </span>
        </div>
        <TextField label="Комментарий" value={item.commentRu} placeholder={COMMENT_HINT[item.role]} onChange={(event) => patchRef(item.key, { commentRu: event.target.value })} />
      </div>
    </div>
  );
}

/** Промптер (решение 28): идея и секции «как в Кадрах» по-русски → промпт под модель с объяснением и слабыми местами. */
export function Prompter() {
  const { ideaRu, kind, choice, template, templates, moodboards, shot, refs, history, currentId, running, error, loadMeta, setIdea, setKind, setChoice, setTemplate, addMoodboard, saveMoodboard, deleteMoodboard, setShot, addFiles, addSource, reset, write, cancel } = usePrompter();
  const pack = useStore((s) => s.pack);
  const kits = pack?.kits ?? {};
  const { library, loadLibrary } = useGen();
  const [picker, setPicker] = useState(false);
  const [consent, setConsent] = useState<{ commentRu?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [board, setBoard] = useState('');
  const [boardName, setBoardName] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const current = history.find((e) => e.id === currentId);
  const chosenTemplate = templates.find((t) => t.id === template);
  const styleRefs = refs.filter((r) => r.role === 'style').length;

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  const models = modelsOf(kind);
  const modelOptions = [{ value: 'auto', label: 'Авто — агент выберет' }, ...models.map((m) => ({ value: m.id, label: `${m.titleRu} · ${m.noteRu}` }))];
  const aspects = ASPECTS.filter((a) => models.some((m) => m.params.find((d) => d.key === 'aspectRatio')?.options?.includes(a)));
  const cameraOptions = [{ value: '', label: 'Авто — по идее' }, ...Object.values(kits).map((k) => ({ value: k.id, label: k.titleRu })), { value: 'custom', label: 'Своя — опишу словами' }];
  const canWrite = ideaRu.trim() !== '' && !running;

  /** Картинки уходят агенту (Claude) — один раз за вкладку спрашиваем. */
  const run = (commentRu?: string): void => {
    if (refs.length > 0 && !hasImagesConsent()) setConsent({ commentRu });
    else void write(commentRu);
  };

  return (
    <div className={styles.prompter}>
      <section
        className={`${styles.form} ${dragging ? styles.dragging : ''}`}
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
          void addFiles([...event.dataTransfer.files]);
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files].filter((f) => f.type.startsWith('image/'));
          if (files.length > 0) {
            event.preventDefault();
            void addFiles(files);
          }
        }}
      >
        <div className={styles.formHead}>
          <div className={styles.stack}>
            <Text variant="title-m" medium>
              Промптер
            </Text>
            <Text variant="label" tone="secondary">
              Тезисы по-русски → промпт под конкретную модель
            </Text>
          </div>
          <Button variant="ghost" size="s" icon={<Icon name="plus" size={1} />} onClick={reset} disabled={running}>
            Новый
          </Button>
        </div>
        <SegmentedControl aria-label="Что делаем" value={kind} onChange={setKind} options={KIND_OPTIONS} />
        <Select label="Модель" value={choice} onChange={setChoice} options={modelOptions} />
        {kind === 'image' && templates.length > 0 && (
          <div className={styles.stack}>
            <Select label="Шаблон" value={template} onChange={setTemplate} options={[{ value: '', label: 'Свободно' }, ...templates.filter((t) => t.kind === kind).map((t) => ({ value: t.id, label: t.titleRu }))]} />
            {chosenTemplate !== undefined && (
              <Text variant="caption" tone="secondary">
                {chosenTemplate.noteRu}
              </Text>
            )}
          </div>
        )}

        <Section n="01" title="Что в кадре" note="Своими словами, как думаешь. Остальные секции — по желанию: пустое агент решит сам.">
          <TextField
            label="Идея"
            multiline
            rows={5}
            value={ideaRu}
            placeholder={kind === 'image' ? 'Я на крыше ночью, снимок на старый телефон со вспышкой, вертикально для рилса' : 'Камера идёт за мной по мокрой улице, я оборачиваюсь к ней'}
            onChange={(event) => setIdea(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canWrite) run();
            }}
          />
        </Section>

        <Section n="02" title="Референсы" note="Порядок — это нумерация в промпте. Скажи, что на картинке и что с неё взять.">
          {refs.map((item, index) => (
            <RefRow key={item.key} item={item} index={index} count={refs.length} />
          ))}
          <div className={styles.refAdd}>
            <Button variant="border" size="s" icon={<Icon name="upload" size={1} />} disabled={refs.length >= PROMPTER_MAX_REFS} onClick={() => fileInput.current?.click()}>
              С диска
            </Button>
            <Button
              variant="border"
              size="s"
              icon={<Icon name="images" size={1} />}
              disabled={refs.length >= PROMPTER_MAX_REFS}
              onClick={() => {
                void loadLibrary();
                setPicker(true);
              }}
            >
              Из библиотеки
            </Button>
            <Text variant="caption" tone="tertiary">
              или перетащи / вставь ⌘V · до {PROMPTER_MAX_REFS}
            </Text>
          </div>
          <div className={styles.boards}>
            <Select label="Мой мудборд" value={board} onChange={setBoard} options={[{ value: '', label: moodboards.length === 0 ? 'пока нет — сохрани стили ниже' : 'выбери' }, ...moodboards.map((m) => ({ value: m.id, label: `${m.name} · ${m.images.length}` }))]} />
            <Button variant="border" size="s" disabled={board === '' || refs.length >= PROMPTER_MAX_REFS} onClick={() => addMoodboard(board)}>
              Добавить
            </Button>
            {board !== '' && (
              <Button
                variant="ghost"
                size="s"
                iconOnly
                aria-label="Удалить мудборд (картинки останутся)"
                icon={<Icon name="bin" size={1} />}
                onClick={() => {
                  void deleteMoodboard(board);
                  setBoard('');
                }}
              />
            )}
          </div>
          {styleRefs > 0 &&
            (boardName === null ? (
              <Button variant="ghost" size="s" icon={<Icon name="bookmark" size={1} />} onClick={() => setBoardName('')}>
                Сохранить стили ({styleRefs}) как мудборд
              </Button>
            ) : (
              <div className={styles.boards}>
                <TextField label="Имя мудборда" value={boardName} placeholder="Night T" autoFocus onChange={(event) => setBoardName(event.target.value)} />
                <Button
                  variant="primary"
                  size="s"
                  disabled={boardName.trim() === ''}
                  onClick={() => {
                    void saveMoodboard(boardName.trim());
                    setBoardName(null);
                  }}
                >
                  Сохранить
                </Button>
                <Button variant="ghost" size="s" onClick={() => setBoardName(null)}>
                  Отмена
                </Button>
              </div>
            ))}
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(event) => {
              void addFiles([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
        </Section>

        <Section n="03" title="Как снято" note="Камера задаёт характер картинки: телефон, handycam, плёнка. Комплекты — те же, что в «Кадрах».">
          <div className={styles.pair}>
            <Select label="Формат" value={shot.aspectRatio} onChange={(aspectRatio) => setShot({ aspectRatio })} options={[{ value: '', label: 'Авто' }, ...aspects.map((a) => ({ value: a, label: a }))]} />
            <Select label="Камера" value={shot.cameraKitId} onChange={(cameraKitId) => setShot({ cameraKitId })} options={cameraOptions} />
          </div>
          {shot.cameraKitId === 'custom' && <TextField label="Камера и картинка — своими словами" multiline rows={2} value={shot.cameraRu} placeholder="Старая мыльница со вспышкой, пересвеченные лица, красные глаза" onChange={(event) => setShot({ cameraRu: event.target.value })} />}
        </Section>

        <Section n="04" title="Место и свет">
          <TextField label="Место" value={shot.placeRu} placeholder="Крыша панельки, внизу ночной город" onChange={(event) => setShot({ placeRu: event.target.value })} />
          <TextField label="Погода и свет" multiline rows={2} value={shot.lightRu} placeholder="Ночь после дождя, влажный воздух, огни снизу" onChange={(event) => setShot({ lightRu: event.target.value })} />
        </Section>

        <Section n="05" title={kind === 'image' ? 'Текст в кадре' : 'Реплика'} note={kind === 'image' ? 'Попадёт в промпт буква в букву. Soul 2 текст не рисует — агент предложит дописать его правкой.' : 'Модель скажет её буква в букву. Вычитай.'}>
          <TextField label={kind === 'image' ? 'Надпись' : 'Что говорит'} value={shot.textRu} placeholder={kind === 'image' ? 'Стоматология без воды' : 'Ну и где ты был?'} lang="ru" spellCheck onChange={(event) => setShot({ textRu: event.target.value })} />
        </Section>

        <div className={styles.formFoot}>
          <div className={styles.formActions}>
            <Button variant="primary" size="m" icon={<Icon name="sparkles" size={1} />} disabled={!canWrite} loading={running} onClick={() => run()}>
              {running ? 'Пишу промпт…' : 'Написать промпт'}
            </Button>
            {running && (
              <Button variant="ghost" size="m" onClick={cancel}>
                Отменить
              </Button>
            )}
          </div>
          {error !== null && (
            <Text variant="label" className={styles.error}>
              {error}
            </Text>
          )}
          <Text variant="caption" tone="tertiary">
            Агент — Claude по подписке, 20–60 с (⌘Enter). Генерацию он не запускает: промпт уходит в студию по кнопке.
          </Text>
        </div>
      </section>

      <section className={styles.output}>
        {current === undefined ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>
              <Icon name="sparkles" size={1.5} />
            </span>
            <Text variant="title-m" medium>
              Здесь появится промпт
            </Text>
            <Text variant="label" tone="secondary">
              Модель с объяснением выбора, параметры, мудборд и где модель может ошибиться
            </Text>
          </div>
        ) : (
          <Result entry={current} onWrite={run} />
        )}
      </section>

      <Dialog open={picker} onOpenChange={setPicker} size="l" title="Картинка из библиотеки" description="Файл с диска — в Claude уйдёт уменьшенная копия.">
        <div className={styles.pickerGrid}>
          {library
            .filter((m) => m.kind === 'image')
            .map((m) => (
              <button
                key={m.id}
                type="button"
                className={styles.pickerItem}
                onClick={() => {
                  addSource({ type: 'media', mediaId: m.id }, `Из библиотеки · ${findModel(m.modelId)?.titleRu ?? ''}`);
                  setPicker(false);
                }}
              >
                <img src={mediaUrl(m.id)} alt={m.prompt.slice(0, 60)} loading="lazy" />
              </button>
            ))}
          {library.every((m) => m.kind !== 'image') && (
            <Text variant="label" tone="tertiary">
              В библиотеке пока нет картинок.
            </Text>
          )}
        </div>
      </Dialog>

      <Dialog
        open={consent !== null}
        onOpenChange={(open) => !open && setConsent(null)}
        title="Показать картинки агенту?"
        description="Уменьшенные копии (до 1568 px) уйдут в Claude (Anthropic) вместе с идеей — агент смотрит, что на них, чтобы правильно назвать их в промпте. В KIE они уйдут только при генерации, со своим согласием. Согласие — до закрытия вкладки."
        footer={
          <>
            <Button variant="ghost" size="s" onClick={() => setConsent(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              size="s"
              onClick={() => {
                const pending = consent;
                setConsent(null);
                rememberImagesConsent();
                void write(pending?.commentRu);
              }}
            >
              Показать и написать
            </Button>
          </>
        }
      >
        <div className={styles.consentThumbs}>
          {refs.map((r) => (
            <img key={r.key} className={styles.usedThumb} src={thumbOf(r.source)} alt="" />
          ))}
        </div>
      </Dialog>
    </div>
  );
}
