import { useState } from 'react';
import { estimate, findModel, formatCost, modelsOf, paramsFor, type GenModel, type MediaKind, type ParamDef, type ParamValue, type ProviderId } from '../../core/gen/models.ts';
import { useGen } from '../gen/genStore.ts';
import { Icon, SegmentedControl, Select, Switch, Tag, Text, TextField } from '../ui/components/index.ts';
import { StylePicker } from './StylePicker.tsx';
import styles from './Studio.module.css';

const OUTPUT_KEYS = new Set(['resolution', 'aspectRatio', 'durationSec']);

/** Что умеет модель — теги под карточкой модели, как в connxn. */
function capabilities(model: GenModel): string[] {
  const out = ['Текст'];
  if (model.refs.roles.includes('ref')) out.push(model.kind === 'image' ? 'Правка по картинкам' : 'Референсы');
  if (model.refs.roles.includes('start')) out.push('Кадры');
  if (model.params.some((p) => p.key === 'audio')) out.push('Звук');
  if (model.params.some((p) => p.key === 'soulId')) out.push('Soul ID');
  out.push(model.provider === 'kie' ? 'KIE' : 'Higgsfield API');
  return out;
}

/**
 * Поле параметра по описанию из каталога. `provider` нужен мудборду; `compact` — узкий вид для ноды canvas.
 */
export function ParamField({ def, value, onChange, provider = 'kie', compact = false }: { def: ParamDef; value: ParamValue | undefined; onChange: (v: ParamValue) => void; provider?: ProviderId; compact?: boolean }) {
  if (def.type === 'style') {
    return (
      <div className={styles.field}>
        {compact && <Text variant="label">{def.labelRu}</Text>}
        <StylePicker provider={provider} value={typeof value === 'string' ? value : ''} onChange={onChange} compact={compact} />
      </div>
    );
  }
  if (def.type === 'seed') {
    const seed = typeof value === 'number' ? value : 0;
    const max = def.max ?? 1_000_000;
    return (
      <div className={styles.field}>
        <div className={styles.seedRow}>
          <TextField
            label={def.labelRu}
            inputMode="numeric"
            value={seed > 0 ? String(seed) : ''}
            placeholder="случайный"
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, '');
              onChange(digits === '' ? 0 : Math.min(max, Number(digits)));
            }}
          />
          <button type="button" className={styles.seedButton} title="Новый случайный — и зафиксировать" onClick={() => onChange(1 + Math.floor(Math.random() * max))}>
            <Icon name="sparkle" size={0.875} />
          </button>
          <button type="button" className={styles.seedButton} title={seed > 0 ? 'Сбросить на случайный' : 'Seed уже случайный'} disabled={seed === 0} onClick={() => onChange(0)}>
            <Icon name={seed > 0 ? 'lock' : 'unlock'} size={0.875} />
          </button>
        </div>
        {!compact && def.hintRu !== undefined && (
          <Text variant="caption" tone="tertiary">
            {seed > 0 ? 'Зафиксирован. ' : ''}
            {def.hintRu}
          </Text>
        )}
      </div>
    );
  }
  if (def.type === 'text') {
    const text = typeof value === 'string' ? value : '';
    const bad = text !== '' && def.pattern !== undefined && !def.pattern.test(text);
    return <TextField label={def.labelRu} value={text} placeholder="не задан" onChange={(event) => onChange(event.target.value.trim())} helper={def.hintRu} error={bad ? 'Неверный формат' : undefined} />;
  }
  if (def.type === 'bool') {
    return (
      <div className={styles.switchRow}>
        <Text variant="label">{def.labelRu}</Text>
        <Switch checked={value === true} onChange={onChange} aria-label={def.labelRu} />
      </div>
    );
  }
  if (def.type === 'int') {
    const v = typeof value === 'number' ? value : Number(def.default);
    return (
      <label className={styles.slider}>
        <span className={styles.sliderHead}>
          <Text variant="label">{def.labelRu}</Text>
          <Text variant="label" medium>
            {v} с
          </Text>
        </span>
        <input type="range" min={def.min} max={def.max} step={1} value={v} onChange={(event) => onChange(Number(event.target.value))} />
        <span className={styles.sliderHead}>
          <Text variant="caption" tone="tertiary">
            {def.min} с
          </Text>
          <Text variant="caption" tone="tertiary">
            {def.max} с
          </Text>
        </span>
      </label>
    );
  }
  const options = (def.options ?? []).map((o) => ({ value: o, label: def.optionLabelsRu?.[o] ?? o }));
  // Segmented — только для коротких вариантов: длинные подписи в пилюле переносятся и ломают ряд.
  if (options.length <= 4 && options.every((o) => o.label.length <= 6)) {
    return (
      <div className={styles.field}>
        <Text variant="label">{def.labelRu}</Text>
        <SegmentedControl<string> size="s" value={String(value)} onChange={onChange} options={options} aria-label={def.labelRu} />
      </div>
    );
  }
  return <Select label={def.labelRu} value={String(value)} onChange={onChange} options={options} />;
}

/** Правая панель студии: модель, выход, опции, стоимость. Всё строится из каталога — отдельной вёрстки под модель нет. */
export function Controls({ kind }: { kind: MediaKind }) {
  const composer = useGen((s) => s.composer[kind]);
  const { setModel, setParam } = useGen();
  const [picking, setPicking] = useState(false);
  const model = findModel(composer.modelId);
  if (model === undefined) return null;
  const params = paramsFor(model, composer.params);
  const cost = estimate(model, params, composer.count, composer.refs.length);
  const output = model.params.filter((p) => OUTPUT_KEYS.has(p.key));
  const moodboard = model.params.find((p) => p.type === 'style');
  const options = model.params.filter((p) => !OUTPUT_KEYS.has(p.key) && p.type !== 'style');

  return (
    <aside className={styles.controls}>
      <header className={styles.controlsHead}>
        <Text variant="caption" tone="accent" medium>
          {kind === 'image' ? 'КАРТИНКИ' : 'ВИДЕО'}
        </Text>
        <Text variant="title-s" medium>
          Параметры
        </Text>
      </header>

      <section className={styles.section}>
        <Text variant="caption" tone="tertiary" medium>
          МОДЕЛЬ
        </Text>
        <button type="button" className={styles.modelCard} onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
          <span className={styles.modelIcon}>
            <Icon name={kind === 'image' ? 'image' : 'video'} size={1.125} />
          </span>
          <span className={styles.modelText}>
            <Text variant="label" medium>
              {model.titleRu}
            </Text>
            <Text variant="caption" tone="secondary">
              {model.noteRu}
            </Text>
          </span>
          <Icon name={picking ? 'chevron-up' : 'chevron-down'} size={1} />
        </button>
        {picking && (
          <div className={styles.modelList} role="listbox">
            {modelsOf(kind).map((m) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={m.id === model.id}
                className={`${styles.modelOption} ${m.id === model.id ? styles.modelOptionActive : ''}`}
                onClick={() => {
                  setModel(kind, m.id);
                  setPicking(false);
                }}
              >
                <Text variant="label" medium>
                  {m.titleRu}
                </Text>
                <Text variant="caption" tone="secondary">
                  {m.noteRu}
                </Text>
              </button>
            ))}
          </div>
        )}
        <div className={styles.tags}>
          {capabilities(model).map((c) => (
            <Tag key={c} tone="outline">
              {c}
            </Tag>
          ))}
        </div>
      </section>

      {moodboard !== undefined && (
        <section className={styles.section}>
          <Text variant="caption" tone="tertiary" medium>
            МУДБОРД
          </Text>
          <ParamField def={moodboard} value={params[moodboard.key]} provider={model.provider} onChange={(v) => setParam(kind, moodboard.key, v)} />
          {moodboard.hintRu !== undefined && (
            <Text variant="caption" tone="tertiary">
              {moodboard.hintRu}
            </Text>
          )}
        </section>
      )}

      {output.length > 0 && (
        <section className={styles.section}>
          <Text variant="caption" tone="tertiary" medium>
            ВЫХОД
          </Text>
          {output.map((def) => (
            <ParamField key={def.key} def={def} value={params[def.key]} onChange={(v) => setParam(kind, def.key, v)} />
          ))}
        </section>
      )}

      {options.length > 0 && (
        <section className={styles.section}>
          <Text variant="caption" tone="tertiary" medium>
            ОПЦИИ
          </Text>
          {options.map((def) => (
            <ParamField key={def.key} def={def} value={params[def.key]} onChange={(v) => setParam(kind, def.key, v)} />
          ))}
        </section>
      )}

      <section className={styles.section}>
        <Text variant="caption" tone="tertiary" medium>
          СТОИМОСТЬ
        </Text>
        <div className={styles.costRow}>
          <Text variant="title-s" medium>
            {formatCost(cost)}
          </Text>
          <Text variant="caption" tone="secondary">
            {composer.count > 1 ? `${composer.count} генерации · ` : ''}
            {model.provider === 'kie' ? 'оценка по прайсу KIE; списанное придёт с результатом' : 'цена по estimate Higgsfield API (27.09); кредиты подписки не тратятся'}
          </Text>
        </div>
      </section>
    </aside>
  );
}
