import styles from './PromptText.module.css';

/** Подсветка того, что поставил компилятор: ссылки, реплики (оба диалекта), неразвёрнутые плейсхолдеры. */
export function PromptText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(<<<image_\d+>>>|@Image \d+|«[^»]*»|\{\{[^}]*\}\}|\{[^{}]+\})/g);
  return (
    <p className={`${styles.text} ${className ?? ''}`}>
      {parts.map((part, i) => {
        if (/^(?:<<<image_\d+>>>|@Image \d+)$/.test(part)) return <span key={i} className={`${styles.hl} ${styles.ref}`}>{part}</span>;
        if (part.startsWith('«') || /^\{[^{]/.test(part)) return <span key={i} className={`${styles.hl} ${styles.say}`}>{part}</span>;
        if (part.startsWith('{{')) return <span key={i} className={`${styles.hl} ${styles.bad}`}>{part}</span>;
        return <span key={i}>{part}</span>;
      })}
    </p>
  );
}
