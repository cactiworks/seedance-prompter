import { ui } from '../language.ts';
import { useState } from 'react';
import type { ProductionRun } from '../../core/production/model.ts';
import { photoPrice } from '../../core/production/photos.ts';
import type { PhotoSelectionQuote } from '../../core/production/selection.ts';
import { studioFetch as fetch } from '../remoteFetch.ts';
import { Button, Text } from '../ui/components/index.ts';
import { useProduction } from './store.ts';
import styles from './Production.module.css';

export function PhotoSelection({ run, ids, onDone, onLoading }: { run: ProductionRun; ids: string[]; onDone: () => void; onLoading: (loading: boolean) => void }) {
  const { busy, photoCommand } = useProduction();
  const [offer, setOffer] = useState<{ quote: PhotoSelectionQuote; key: string; requestId: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([run.rev, ids]);
  const current = offer?.key === key ? offer : null;
  async function commit(quote: PhotoSelectionQuote, requestId: string) {
    const ok = await photoCommand('photos/continue', { rev: quote.rev, ids: quote.ids, requestId, confirmUsd: quote.usd, consent: true });
    if (ok) { setOffer(null); onDone(); }
  }
  async function next() {
    setLoading(true); onLoading(true); setError(null); setOffer(null);
    try {
      const response = await fetch(`/api/production/${run.id}/photos/selection/quote`, { method: 'POST', headers: { 'x-sp-client': '1', 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
      const quote = await response.json() as PhotoSelectionQuote & { messageRu?: string };
      if (!response.ok) throw new Error(quote.messageRu ?? 'Не удалось сохранить выбор.');
      const requestId = crypto.randomUUID();
      if (!quote.count) await commit(quote, requestId);
      else setOffer({ quote, requestId, key: JSON.stringify([quote.rev, ids]) });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); onLoading(false); }
  }
  const remaining = run.shots.filter(s => !s.acceptedPhotoId).length - ids.length;
  return <div className={styles.costControls}>
    <Text variant="label">{ui("Выбрано ")}{ids.length}. {remaining ? ui("Без галочки: {0} — будут созданы заново.", remaining) : ui("Все оставшиеся позиции выбраны.")}</Text>
    {error && <Text role="alert">{error}</Text>}
    {current ? <>
      <Text variant="caption" tone="secondary">{ui("Сохраним выбранные. Позиций на перегенерацию: ")}{current.quote.count}{ui(". Кнопка подтверждает ")}{photoPrice(current.quote.usd)}{ui(", передачу данных в Higgsfield и проверку фото с фрагментами и до шести refs в Codex / OpenAI (лимиты и оплата твоего подключения).")}</Text>
      <div><Button variant="primary" disabled={busy || run.paused} onClick={() => void commit(current.quote, current.requestId)}>{ui("Пересоздать ")}{current.quote.count} · {photoPrice(current.quote.usd)}</Button></div>
    </> : <div><Button variant="primary" disabled={busy || loading || run.paused} loading={loading} onClick={() => void next()}>{ui("Продолжить")}</Button></div>}
  </div>;
}
