import { useState } from 'react';
import type { ReferenceCard } from '../../core/references.ts';
import { ui } from '../language.ts';
import { Button, Icon, Text } from '../ui/components/index.ts';
import { ReferenceCardPreview } from './ReferenceCardView.tsx';
import styles from './References.module.css';

export function ReferenceGraph({ cards, onOpen }: { cards: ReferenceCard[]; onOpen: (card: ReferenceCard) => void }) {
  const [filter, setFilter] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [limit, setLimit] = useState(24);
  const groups = new Map<string, { name: string; cards: ReferenceCard[] }>();
  for (const card of cards) {
    for (const tag of card.tags) {
      const key = tag.trim().toLocaleLowerCase();
      if (!key) continue;
      const group = groups.get(key) ?? { name: tag, cards: [] };
      if (!group.cards.some((existing) => existing.id === card.id)) group.cards.push(card);
      groups.set(key, group);
    }
  }
  const options = [...groups].sort((a, b) => b[1].cards.length - a[1].cards.length || a[1].name.localeCompare(b[1].name));
  const visible = options.filter(([, group]) => group.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const current = groups.get(selectedTag) ?? options[0]?.[1];

  if (!current) return (
    <div className={styles.empty}>
      <Icon name="link" size={1.5} />
      <Text as="h2" variant="title-s" medium>{ui('Здесь появятся связи между кадрами')}</Text>
      <Text tone="secondary">{ui('Проанализируй кадры или добавь приёмы вручную.')}</Text>
    </div>
  );

  return (
    <div className={styles.graph}>
      <div className={styles.graphControls}>
        <label className={styles.search}>
          <Icon name="search" size={1} />
          <input type="search" aria-label={ui('Поиск по приёмам')} placeholder={ui('Найти приём')} value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
        <div className={styles.chips} aria-label={ui('Приёмы')}>
          {visible.slice(0, 30).map(([key, group]) => <Button key={key} variant={group === current ? 'soft' : 'border'} size="xs" aria-pressed={group === current}
            onClick={() => { setSelectedTag(key); setLimit(24); }}>{group.name} · {group.cards.length}</Button>)}
          {!visible.length && <Text variant="label" tone="secondary">{ui('Приёмы не найдены.')}</Text>}
        </div>
      </div>
      <section className={styles.cluster} aria-label={ui('Связанные кадры')}>
        <div className={styles.graphHub}>
          <Icon name="link" size={1} />
          <Text as="h2" variant="label" medium>{current.name}</Text>
        </div>
        <ul className={styles.clusterGrid}>
          {current.cards.slice(0, limit).map((card) => <li key={card.id}><ReferenceCardPreview card={card} onOpen={() => onOpen(card)} /></li>)}
        </ul>
        {current.cards.length > limit && <Button variant="border" onClick={() => setLimit((value) => value + 24)}>{ui('Показать ещё')}</Button>}
      </section>
    </div>
  );
}
