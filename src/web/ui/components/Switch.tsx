import { Switch as RadixSwitch } from 'radix-ui';
import { useId, type ReactNode } from 'react';
import styles from './Switch.module.css';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  'aria-label'?: string;
}

export function Switch({ checked, onChange, label, disabled, ...rest }: SwitchProps) {
  const id = useId();
  const control = (
    <RadixSwitch.Root id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className={styles.root} aria-label={rest['aria-label']}>
      <RadixSwitch.Thumb className={styles.thumb} />
    </RadixSwitch.Root>
  );
  if (label === undefined) return control;
  return (
    <label htmlFor={id} className={styles.row}>
      {control}
      <span className={styles.label}>{label}</span>
    </label>
  );
}
