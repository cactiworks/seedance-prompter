import styles from './Meter.module.css';

interface MeterProps {
  label: string;
  value: number;
  /** Верхняя граница бюджета. */
  max: number;
  /** Текст после значения: «/ 6», «/ 67 слов». */
  unit?: string;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
}

/**
 * Производный компонент (в Lab UI его нет): бюджет «подпись над значением» + тонкая шкала.
 * Собран по паттерну статистики с эталона lab.pics.
 */
export function Meter({ label, value, max, unit, tone = 'accent' }: MeterProps) {
  const ratio = max <= 0 ? 0 : Math.min(1, value / max);
  return (
    <div className={`${styles.meter} ${tone !== 'accent' ? styles[tone] : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span className={styles.caption}>{label}</span>
      <span className={styles.value}>
        {value}
        <span className={styles.of}>{unit ?? `/ ${max}`}</span>
      </span>
      <div className={styles.track}>
        <div className={styles.bar} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
