import { useEffect, useState } from 'react';
import { estimate, findModel, formatCost, modelsOf, type GenParams, type MediaKind } from '../../core/gen/models.ts';
import { agentParams, hasStyles } from '../../core/llm/buildPrompter.ts';
import { useGen } from '../gen/genStore.ts';
import { Button, Icon, SegmentedControl, Select, Tag, Text, TextField } from '../ui/components/index.ts';
import styles from './Prompter.module.css';
import { usePrompter, type PrompterEntry } from './prompterStore.ts';

const KIND_OPTIONS: { value: MediaKind; label: string }[] = [
  { value: 'image', label: 'Картинка' },
  { value: 'video', label: 'Видео' },
];

/** Только выбор агента: seed, Soul ID и улучшение промпта в форме студии остаются как были. */
function agentChoice(entry: PrompterEntry): GenParams {
  const model = findModel(entry.result.modelId);
  if (model === undefined) return {};
  const keys = [...agentParams(model).map((d) => d.key), ...(hasStyles(model) ? ['styleId'] : [])];
  return Object.fromEntries(keys.filter((key) => entry.result.params[key] !== undefined).map((key) => [key, entry.result.params[key] as GenParams[string]]));
}

function Result({ entry }: { entry: PrompterEntry }) {
  const { running, write } = usePrompter();
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
  const cost = formatCost(estimate(model, entry.result.params));
  const copy = (): void => {
    void navigator.clipboard.writeText(entry.result.prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const toStudio = (): void => {
    applyPrompt(model.kind, model.id, agentChoice(entry), entry.result.prompt);
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
          Промпт и параметры встанут в форму {model.kind === 'image' ? '«Картинок»' : '«Видео»'}; генерация — там, по кнопке с ценой.
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
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && comment.trim() !== '' && !running) void write(comment);
          }}
        />
        <Button variant="border" icon={<Icon name="arrow-redo" size={1} />} disabled={comment.trim() === '' || running} loading={running} onClick={() => void write(comment)}>
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

/** Промптер (решение 28): идея по-русски → промпт под модель с объяснением выбора и слабыми местами. */
export function Prompter() {
  const { ideaRu, kind, choice, history, currentId, running, error, setIdea, setKind, setChoice, write, cancel } = usePrompter();
  const current = history.find((e) => e.id === currentId);
  const options = [{ value: 'auto', label: 'Авто — агент выберет' }, ...modelsOf(kind).map((m) => ({ value: m.id, label: `${m.titleRu} · ${m.noteRu}` }))];
  const canWrite = ideaRu.trim() !== '' && !running;

  return (
    <div className={styles.prompter}>
      <section className={styles.form}>
        <div className={styles.stack}>
          <Text variant="title-m" medium>
            Промптер
          </Text>
          <Text variant="label" tone="secondary">
            Идея по-русски → промпт под конкретную модель
          </Text>
        </div>
        <SegmentedControl aria-label="Что делаем" value={kind} onChange={setKind} options={KIND_OPTIONS} />
        <TextField
          label="Идея"
          multiline
          rows={9}
          value={ideaRu}
          placeholder={kind === 'image' ? 'Например: я на крыше ночью, снимок на старый телефон со вспышкой, вертикально для рилса' : 'Например: камера идёт за мной по мокрой улице, я оборачиваюсь и говорю «ну и где ты был?»'}
          onChange={(event) => setIdea(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canWrite) void write();
          }}
        />
        <Select label="Модель" value={choice} onChange={setChoice} options={options} />
        <div className={styles.formActions}>
          <Button variant="primary" size="m" icon={<Icon name="sparkles" size={1} />} disabled={!canWrite} loading={running} onClick={() => void write()}>
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
          <Result entry={current} />
        )}
      </section>
    </div>
  );
}

