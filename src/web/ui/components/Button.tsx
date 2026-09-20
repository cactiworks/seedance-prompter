import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'dark' | 'secondary' | 'soft' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'm' | 's';
  icon?: ReactNode;
  loading?: boolean;
  /** Кнопка только с иконкой: обязателен aria-label. */
  iconOnly?: boolean;
}

/**
 * Действие — пилюля. `primary` — единственный акцент экрана; `dark` — второе весомое действие без второго
 * цвета (как «Show filters» на эталоне); остальное — нейтральные заливки.
 */
export function Button({ variant = 'secondary', size = 'm', icon, loading = false, iconOnly = false, disabled, children, className, type = 'button', ...rest }: ButtonProps) {
  const classes = [styles.button, styles[variant], styles[size], iconOnly ? styles.iconOnly : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={classes} disabled={disabled === true || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className={styles.spinner} aria-hidden /> : icon}
      {iconOnly ? null : children}
    </button>
  );
}
