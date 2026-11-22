import type { ReferenceCard } from '../../core/references.ts';
import { REFERENCE_FOLDERS } from '../../core/references.ts';
import { ui } from '../language.ts';
import { Text } from '../ui/components/index.ts';
import { referenceImageUrl } from './api.ts';
import styles from './References.module.css';

export function referenceTimestamp(timeMs: number): string {
  const minutes = Math.floor(timeMs / 60_000);
  const seconds = Math.floor(timeMs / 1000) % 60;
  const fraction = Math.floor((timeMs % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${fraction}`;
}

export function referenceCaption(card: ReferenceCard): string {
  return card.timeMs === null ? card.sourceName : `${card.sourceName} · ${referenceTimestamp(card.timeMs)}`;
}

export function ReferenceImage({ card, className, management = false }: { card: ReferenceCard; className?: string; management?: boolean }) {
  return <img className={className ?? styles.frameImage} src={referenceImageUrl(card.id, management)} alt={card.analysis?.visible || referenceCaption(card)} loading="lazy" decoding="async" />;
}

export function ReferenceCardPreview({ card, onOpen }: { card: ReferenceCard; onOpen: () => void }) {
  return (
    <button type="button" className={styles.cardLink} onClick={onOpen} aria-label={ui('Открыть кадр {0}', referenceCaption(card))}>
      <ReferenceImage card={card} />
      <span className={styles.cardCaption}>
        <Text as="span" variant="label" medium className={styles.cardTitle}>{card.analysis?.visible || card.sourceName}</Text>
        <Text as="span" variant="caption" tone="secondary" className={styles.cardSource}>
          {card.timeMs === null ? ui('Фото') : referenceTimestamp(card.timeMs)}
          {' · '}
          {card.folder ? ui(REFERENCE_FOLDERS[card.folder]) : ui('Ожидает разбора')}
        </Text>
      </span>
    </button>
  );
}

export function ReferenceCardContent({ card }: { card: ReferenceCard }) {
  const analysis = card.analysis;
  const features = analysis && [
    ['Сюжет', analysis.subject],
    ['Поза', analysis.pose],
    ['Композиция', analysis.composition],
    ['Ракурс', analysis.angle],
    ['Свет', analysis.lighting],
    ['Цвет', analysis.color],
    ['Фактура', analysis.texture],
    ['Стилизация', analysis.styling],
  ] as const;
  return (
    <div className={styles.details}>
      <ReferenceImage card={card} className={styles.detailImage} />
      {analysis ? (
        <div className={styles.detailsText}>
          <div><Text as="h3" variant="label" medium>{ui('Что видно?')}</Text><Text>{analysis.visible}</Text></div>
          <div><Text as="h3" variant="label" medium>{ui('Как это сделано?')}</Text><Text>{analysis.technique}</Text></div>
          <div><Text as="h3" variant="label" medium>{ui('Что можно перенести?')}</Text><Text>{analysis.transfer}</Text></div>
          {features && <dl className={styles.features}>
            {features.filter(([, value]) => value.trim()).map(([label, value]) => (
              <div key={label}>
                <Text as="dt" variant="caption" tone="secondary">{ui(label)}</Text>
                <Text as="dd" variant="label">{value}</Text>
              </div>
            ))}
          </dl>}
        </div>
      ) : <Text tone="secondary">{ui('Разбор ещё не готов.')}</Text>}
    </div>
  );
}
