import { ToggleGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import styles from './SegmentedControl.module.css';

interface Option<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: Option<T>[];
  size?: 'm' | 's';
  'aria-label': string;
}

/** Выбор одного из немногих: пилюля на нейтральной подложке с белым бегунком. */
export function SegmentedControl<T extends string>({ value, onChange, options, size = 'm', ...rest }: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      // Radix отдаёт '' при повторном клике — у segmented control пустого состояния нет.
      onValueChange={(next) => next !== '' && onChange(next as T)}
      className={`${styles.root} ${styles[size]}`}
      aria-label={rest['aria-label']}
    >
      {options.map((option) => (
        <ToggleGroup.Item key={option.value} value={option.value} disabled={option.disabled} className={styles.item}>
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
