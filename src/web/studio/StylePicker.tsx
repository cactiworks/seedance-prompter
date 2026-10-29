import { ui } from '../language.ts';
import { useEffect } from 'react';
import type { ProviderId } from '../../core/gen/models.ts';
import { useGen } from '../gen/genStore.ts';
import { Text } from '../ui/components/index.ts';
import styles from './Studio.module.css';

/**
 * Готовые мудборды провайдера (Soul 2 — 33 стиля Higgsfield) сеткой превью, как в вебе Higgsfield.
 * `compact` — списком (для ноды canvas, где сетка не помещается).
 */
export function StylePicker({ provider, value, onChange, compact = false }: { provider: ProviderId; value: string; onChange: (id: string) => void; compact?: boolean }) {
  const list = useGen((s) => s.styles[provider]);
  const loadStyles = useGen((s) => s.loadStyles);
  useEffect(() => {
    if (list === undefined) void loadStyles(provider);
  }, [list, loadStyles, provider]);

  if (list === undefined) {
    return (
      <Text variant="caption" tone="tertiary">
        {ui("Загружаю мудборды…")}</Text>
    );
  }
  if (list.length === 0) {
    return (
      <Text variant="caption" tone="tertiary">
        {ui("Мудборды недоступны — нет ключа провайдера или он не ответил.")}</Text>
    );
  }
  if (compact) {
    return (
      <select className={styles.styleSelect} value={value} onChange={(event) => onChange(event.target.value)} aria-label={ui("Мудборд")}>
        <option value="">{ui("Без мудборда")}</option>
        {list.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    );
  }
  const chosen = list.find((s) => s.id === value);
  return (
    <>
    <Text variant="label" medium>
      {chosen?.name ?? ui("Без мудборда")}
    </Text>
    <div className={styles.styleGrid} role="listbox" aria-label={ui("Мудборд")}>
      <button type="button" role="option" aria-selected={value === ''} className={`${styles.styleItem} ${value === '' ? styles.styleOn : ''}`} onClick={() => onChange('')}>
        <span className={`${styles.stylePreview} lab-hatch`} />
        <Text as="span" variant="caption">
          {ui("Без мудборда")}</Text>
      </button>
      {list.map((s) => (
        <button key={s.id} type="button" role="option" aria-selected={value === s.id} title={s.description || s.name} className={`${styles.styleItem} ${value === s.id ? styles.styleOn : ''}`} onClick={() => onChange(s.id)}>
          {s.previewUrl !== null ? <img className={styles.stylePreview} src={s.previewUrl} alt="" loading="lazy" /> : <span className={`${styles.stylePreview} lab-hatch`} />}
          <Text as="span" variant="caption">
            {s.name}
          </Text>
        </button>
      ))}
    </div>
    </>
  );
}
