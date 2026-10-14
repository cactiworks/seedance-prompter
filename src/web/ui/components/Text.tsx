import type { ElementType, HTMLAttributes, ReactNode, Ref } from 'react';
import styles from './Text.module.css';

type Variant = 'caption' | 'label' | 'body' | 'title-s' | 'title-m' | 'title-l' | 'display';
type Tone = 'primary' | 'secondary' | 'tertiary' | 'accent';

interface TextProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  variant?: Variant;
  tone?: Tone;
  medium?: boolean;
  mono?: boolean;
  className?: string;
  children: ReactNode;
  ref?: Ref<HTMLElement>;
}

/** Иерархия Lab UI держится на весе и непрозрачности, а не на размере и цвете: два веса, три тона. */
export function Text({ as: Tag = 'p', variant = 'body', tone = 'primary', medium = false, mono = false, className, children, ...rest }: TextProps) {
  const classes = [styles.text, styles[variant], tone !== 'primary' ? styles[tone] : '', medium ? styles.medium : '', mono ? styles.mono : '', className ?? ''];
  return <Tag {...rest} className={classes.filter(Boolean).join(' ')}>{children}</Tag>;
}
