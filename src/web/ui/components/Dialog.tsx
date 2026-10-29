import { ui } from '../../language.ts';
import { Dialog as RadixDialog } from 'radix-ui';
import { useRef, type ReactNode } from 'react';
import { Icon } from '../icons/Icon.tsx';
import { Button } from './Button.tsx';
import { Text } from './Text.tsx';
import styles from './Dialog.module.css';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** Плавающий хром: заголовок и подвал. Тело — solid, под плотным текстом стекло не используется. */
  footer?: ReactNode;
  size?: 'm' | 'l';
  children: ReactNode;
}

/** Модальное окно Lab UI: затемнение с блюром, плавающая карточка с крупным радиусом, закрытие по Esc и клику мимо. */
export function Dialog({ open, onOpenChange, title, description, footer, size = 'm', children }: DialogProps) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content className={`${styles.content} ${size === 'l' ? styles.l : ''}`} aria-describedby={undefined} onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={(event) => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus({ preventScroll: true }); } }}>
          <header className={`${styles.head} lab-glass-thin`}>
            <div className={styles.headText}>
              <RadixDialog.Title asChild>
                <Text as="h2" variant="title-s">{title}</Text>
              </RadixDialog.Title>
              {description !== undefined && (
                <RadixDialog.Description asChild>
                  <Text variant="label" tone="secondary">{description}</Text>
                </RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="s" iconOnly aria-label={ui("Закрыть")} icon={<Icon name="close" />} />
            </RadixDialog.Close>
          </header>
          <div className={styles.body}>{children}</div>
          {footer !== undefined && <footer className={`${styles.foot} lab-glass-thin`}>{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
