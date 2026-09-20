import { ICONS, type IconName } from './data.ts';

interface IconProps {
  name: IconName;
  variant?: 'outline' | 'filled';
  /** Размер в rem: 1 (16px, плотный UI), 1.25, 1.5 (родной размер иконок Lab UI), 2 (якорь блока). */
  size?: number;
  className?: string;
  /** Подпись для скринридера; без неё иконка декоративная. */
  label?: string;
}

/** Иконка Lab UI. Цвет наследуется от текста; outline — в интерфейсе, filled — для выбранного состояния. */
export function Icon({ name, variant = 'outline', size = 1.25, className, label }: IconProps) {
  const markup = ICONS[name][variant] ?? ICONS[name].outline ?? '';
  return (
    <svg
      width={`${size}rem`}
      height={`${size}rem`}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      style={{ flex: 'none' }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export type { IconName };
