import { formatCost, tariffNote } from '../formatCost.ts';
import { ui } from '../language.ts';
import { useState } from 'react';
import { create } from 'zustand';
import { type Estimate } from '../../core/gen/models.ts';
import { studioFetch as fetch } from '../remoteFetch.ts';
import { Button, Dialog, Text } from '../ui/components/index.ts';

interface Pending { body: Record<string, unknown>; resolve: (body: Record<string, unknown>) => void; reject: (error: Error) => void }
const useQuote = create<{ pending: Pending | null }>(() => ({ pending: null }));
export function confirmGenerationQuote(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (useQuote.getState().pending) return Promise.reject(new Error('Сначала заверши текущую проверку цены.'));
  return new Promise((resolve, reject) => useQuote.setState({ pending: { body, resolve, reject } }));
}
export function GenerationQuote() {
  const pending = useQuote(s => s.pending);
  return pending ? <QuoteDialog key={String(pending.body.prompt)} pending={pending} /> : null;
}
function QuoteDialog({ pending }: { pending: Pending }) {
  const [quote, setQuote] = useState<{ quoteId: string; estimate: Estimate } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [acceptApproximate,setAcceptApproximate] = useState(false);
  const refs = Array.isArray(pending.body.refs) ? pending.body.refs.length : 0;
  const cancel = () => { useQuote.setState({ pending: null }); pending.reject(new Error('Запуск отменён. Видео не отправлено.')); };
  const calculate = async () => {
    setBusy(true); setError(''); setAcceptApproximate(false);
    try {
      const res = await fetch('/api/gen/quote', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sp-client': '1' }, body: JSON.stringify({ ...pending.body, refsConsent: true }) });
      const value = await res.json();
      if (!res.ok) throw new Error(value.messageRu ?? 'Не удалось получить цену.');
      setQuote(value as { quoteId: string; estimate: Estimate });
    } catch (e) { setError(e instanceof Error ? e.message : 'Оценка недоступна.'); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) cancel(); }} title="Seedance 2.5 · Higgsfield" description={ui("Стоимость этого запуска")} size="m">
    <Text>{quote ? ui("{0} за {1} видео: {2}", quote.estimate.approximate ? ui("Ориентировочная цена") : ui("Цена"), Number(pending.body.count ?? 1), formatCost(quote.estimate)) : ui("Запросим цену Higgsfield. Если сервис вернёт только тариф, покажем ориентировочный расчёт. Видео пока не запускается.")}</Text>
    {quote?.estimate.approximate && <>
      <Text variant="caption" tone="secondary">{tariffNote(quote.estimate.pricingNote)} {ui(" Выбранный формат: ")}{String((pending.body.params as Record<string,unknown> | undefined)?.aspectRatio ?? ui("по исходному фото"))}.</Text>
      <label style={{display:'flex',alignItems:'flex-start',gap:'var(--lab-space-4)',marginTop:'var(--lab-space-8)'}}><input type="checkbox" checked={acceptApproximate} onChange={e=>setAcceptApproximate(e.target.checked)} />{ui("Понимаю, что цена ориентировочная и фактическое списание может отличаться.")}</label>
    </>}
    {refs > 0 && <Text variant="caption" tone="secondary">{ui("Для расчёта и генерации ")}{refs} {ui(" фото будут переданы в Higgsfield API.")}</Text>}
    {error && <Text role="alert">{error}</Text>}
    <div style={{ display: 'flex', gap: 'var(--lab-space-8)', flexWrap: 'wrap', marginTop: 'var(--lab-space-16)' }}>
      <Button variant="border" onClick={cancel}>{ui("Отмена")}</Button>
      {quote ? <Button variant="primary" disabled={quote.estimate.approximate && !acceptApproximate} onClick={() => { useQuote.setState({ pending: null }); pending.resolve({ ...pending.body, refsConsent: true, quoteId: quote.quoteId, confirmCredits: quote.estimate.credits, acceptApproximate }); }}>{ui("Сгенерировать · ")}{formatCost(quote.estimate)}</Button> : <Button variant="primary" loading={busy} onClick={() => void calculate()}>{ui("Рассчитать цену")}</Button>}
    </div>
  </Dialog>;
}
