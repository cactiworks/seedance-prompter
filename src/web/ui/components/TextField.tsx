import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import styles from './TextField.module.css';

interface Common {
  label: string;
  helper?: ReactNode;
  error?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}

type InputProps = Common & { multiline?: false } & Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>;
type AreaProps = Common & { multiline: true } & TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Поле с подписью на рамке и подсказкой под ним. Ошибка заменяет подсказку и красит рамку. */
export function TextField(props: InputProps | AreaProps) {
  const id = useId();
  const { label, helper, error, leading, trailing } = props;
  const invalid = error !== undefined && error !== null && error !== false;
  const describedBy = invalid || helper !== undefined ? `${id}-help` : undefined;

  let control: ReactNode;
  if (props.multiline === true) {
    const { label: _l, helper: _h, error: _e, leading: _le, trailing: _t, multiline: _m, ...rest } = props;
    control = <textarea id={id} className={styles.textarea} aria-invalid={invalid || undefined} aria-describedby={describedBy} {...rest} />;
  } else {
    const { label: _l, helper: _h, error: _e, leading: _le, trailing: _t, multiline: _m, ...rest } = props;
    control = <input id={id} className={styles.input} aria-invalid={invalid || undefined} aria-describedby={describedBy} {...rest} />;
  }

  return (
    <div className={styles.wrap}>
      <fieldset className={`${styles.field} ${invalid ? styles.invalid : ''}`}>
        <legend className={styles.legend}>
          <label htmlFor={id}>{label}</label>
        </legend>
        {leading !== undefined && <span className={styles.adornment}>{leading}</span>}
        {control}
        {trailing !== undefined && <span className={styles.adornment}>{trailing}</span>}
      </fieldset>
      {describedBy !== undefined && (
        <span id={describedBy} className={`${styles.helper} ${invalid ? styles.helperError : ''}`}>
          {invalid ? error : helper}
        </span>
      )}
    </div>
  );
}
