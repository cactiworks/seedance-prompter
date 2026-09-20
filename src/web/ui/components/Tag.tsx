import type { ReactNode } from 'react';
import styles from './Tag.module.css';

export type TagTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'outline';

/** Статус — мягкий фон цвета статуса на 12 % и тот же цвет текстом. Цвет только там, где есть статус. */
export function Tag({ tone = 'neutral', dot = false, children }: { tone?: TagTone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`${styles.tag} ${styles[tone]}`}>
      {dot && <span className={styles.dot} aria-hidden />}
      {children}
    </span>
  );
}
