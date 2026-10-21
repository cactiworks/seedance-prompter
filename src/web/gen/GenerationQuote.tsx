import { useState } from 'react';
import { create } from 'zustand';
import { formatCost, type Estimate } from '../../core/gen/models.ts';
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
  const refs = Array.isArray(pending.body.refs) ? pending.body.refs.length : 0;
  const cancel = () => { useQuote.setState({ pending: null }); pending.reject(new Error('Запуск отменён. Видео не отправлено.')); };
  const calculate = async () => {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/gen/quote', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sp-client': '1' }, body: JSON.stringify({ ...pending.body, refsConsent: true }) });
      const value = await res.json();
      if (!res.ok) throw new Error(value.messageRu ?? 'Не удалось получить цену.');
      setQuote(value as { quoteId: string; estimate: Estimate });
    } catch (e) { setError(e instanceof Error ? e.message : 'Оценка недоступна.'); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) cancel(); }} title="Seedance 2.5 · Higgsfield" description="Стоимость этого запуска" size="m">
    <Text>{quote ? `Запуск ${Number(pending.body.count ?? 1)} видео: ${formatCost(quote.estimate)}` : 'Получим цену для твоего аккаунта и выбранных настроек. Видео пока не запускается.'}</Text>
    {refs > 0 && <Text variant="caption" tone="secondary">Для расчёта и генерации {refs} фото будут переданы в Higgsfield API.</Text>}
    {error && <Text role="alert">{error}</Text>}
    <div style={{ display: 'flex', gap: 'var(--lab-space-8)', flexWrap: 'wrap', marginTop: 'var(--lab-space-16)' }}>
      <Button variant="border" onClick={cancel}>Отмена</Button>
      {quote ? <Button variant="primary" onClick={() => { useQuote.setState({ pending: null }); pending.resolve({ ...pending.body, refsConsent: true, quoteId: quote.quoteId, confirmCredits: quote.estimate.credits }); }}>Сгенерировать · {formatCost(quote.estimate)}</Button> : <Button variant="primary" loading={busy} onClick={() => void calculate()}>Рассчитать цену</Button>}
    </div>
  </Dialog>;
}
