import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Card.module.css';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  elevation?: 'flat' | 'raised' | 'floating';
  padding?: 'none' | 'm' | 'l';
  children: ReactNode;
}

/** Карточка отделена рамкой 1px на 12 % и едва заметной тенью — без рамок «для надёжности». */
export function Card({ elevation = 'flat', padding = 'm', className, children, ...rest }: CardProps) {
  const classes = [styles.card, elevation !== 'flat' ? styles[elevation] : '', padding === 'm' ? styles.padM : padding === 'l' ? styles.padL : '', className ?? ''];
  return (
    <div className={classes.filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}
