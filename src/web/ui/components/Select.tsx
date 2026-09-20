import { useId, type SelectHTMLAttributes } from 'react';
import { Icon } from '../icons/Icon.tsx';
import styles from './Select.module.css';

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}

/** Выбор из списка в оболочке поля Lab UI (подпись в вырезе рамки). Нативный select — ради клавиатуры и скринридера. */
export function Select({ label, value, onChange, options, ...rest }: SelectProps) {
  const id = useId();
  return (
    <fieldset className={styles.field}>
      <legend className={styles.legend}>
        <label htmlFor={id}>{label}</label>
      </legend>
      <select id={id} className={styles.select} value={value} onChange={(event) => onChange(event.target.value)} {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className={styles.chevron}>
        <Icon name="chevron-down" size={1} />
      </span>
    </fieldset>
  );
}
