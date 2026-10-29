import { ui } from '../language.ts';
import { studioFetch as fetch } from '../remoteFetch.ts';
import { useState } from 'react';
import type { ProductionRun } from '../../core/production/model.ts';
import type { quoteRetouch } from '../../core/production/retouch.ts';
import { photoPrice } from '../../core/production/photos.ts';
import { Button, Text } from '../ui/components/index.ts';
import { useProduction } from './store.ts';
import styles from './Production.module.css';

type Quote = ReturnType<typeof quoteRetouch>;
export function RetouchStart({ run, ids, onStarted }: { run: ProductionRun; ids: string[]; onStarted: () => void }) {
  const { busy, photoCommand } = useProduction();
  const [offer, setOffer] = useState<{ quote: Quote; ids: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const key = JSON.stringify(ids);
  const quote = offer?.ids === key ? offer.quote : null;
  async function price() {
    setLoading(true); setConsent(false); setError(null); setOffer(null);
    try {
      const response = await fetch(`/api/production/${run.id}/retouch/quote`, { method: 'POST', headers: { 'x-sp-client': '1', 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
      const data = await response.json() as Quote & { messageRu?: string };
      if (!response.ok) throw new Error(data.messageRu ?? 'Не удалось оценить автоправки.');
      setOffer({ quote: data, ids: key });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  const recoverable = run.retouch?.items.flatMap(i => i.attempts.filter(a => a.jobId && (['download_failed', 'processing_failed'].includes(a.status) || a.errorCode === 'POLL_TIMEOUT'))) ?? [];
  return <div className={styles.costControls}>
    <Text variant="caption" tone="secondary">{ui("После выбора — проверка деталей и локальные правки Seedream. До трёх попыток на кадр за всю серию; исходники сохраняются. Кадры без дефектов не перегенерируются.")}</Text>
    {error && <Text role="alert">{error}</Text>}
    {quote && <><Text variant="label">{ui("До ")}{photoPrice(quote.usd)} {ui(" · не больше ")}{quote.count} {ui(" правок")}</Text><label className={styles.check}><input type="checkbox" checked={consent} disabled={busy || run.paused} onChange={e => setConsent(e.target.checked)} />{ui("Подтверждаю бюджет, отправку выбранных фото и до ")}{quote.referenceCount} {ui(" фото внешности в KIE / Seedream. Codex получит кадры серии и до шести refs; до ")}{quote.checks} {ui(" вызовов через твоё AI-подключение.")}</label><Text variant="caption" tone="secondary">{ui("Неиспользованный запас не расходуется. Готовая выдача — после повторной проверки.")}</Text></>}
    <div className={styles.gateActions}><Button variant={quote ? 'ghost' : 'primary'} disabled={!ids.length || busy || run.paused} loading={loading} onClick={() => void price()}>{quote ? ui("Обновить оценку") : run.retouch ? ui("Продолжить проверку и правки") : ui("Выбрать и рассчитать автоправки")}</Button>
    {quote && <Button variant="primary" disabled={!consent || busy || run.paused} onClick={() => void photoCommand('retouch/start', { rev: quote.rev, requestId, ids, confirmUsd: quote.usd, consent: true }).then(ok => { if (ok) { setOffer(null); setConsent(false); setRequestId(crypto.randomUUID()); onStarted(); } })}>{ui("Принять замысел и проверить детали · до ")}{photoPrice(quote.usd)}</Button>}</div>
    {recoverable.map(a => <Button key={a.tag} variant="border" disabled={busy} onClick={() => void photoCommand('retouch/retry', { jobId: a.jobId })}>{ui("Повторить получение результата · без новой генерации")}</Button>)}
  </div>;
}
