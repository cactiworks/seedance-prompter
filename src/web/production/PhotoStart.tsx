import { ui } from '../language.ts';
import { studioFetch as fetch } from '../remoteFetch.ts';
import { useEffect, useState } from 'react';
import type { ProductionRun } from '../../core/production/model.ts';
import { photoOutput } from '../../core/production/output.ts';
import { canRegenerateMaster, masterAttempts, masterRejected, photoPrice, type PhotoQuote } from '../../core/production/photos.ts';
import { Button, Text } from '../ui/components/index.ts';
import { useProduction } from './store.ts';
import styles from './Production.module.css';

export function PhotoStart({ run }: { run: ProductionRun }) {
  const { photoCommand, busy } = useProduction();
  const [quote, setQuote] = useState<PhotoQuote | null>(null);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const rejected = masterRejected(run);
  useEffect(() => { setQuote(null); setConsent(false); }, [run.characterId, run.paused, run.resolution, run.aspectRatio, rejected]);
  const blocked = run.photos?.items.some(i => ['failed', 'unknown', 'download_failed', 'submitting', 'queued', 'running', 'downloading'].includes(i.status));
  const remaining = run.photos ? run.photos.items.filter(i => i.status === 'pending').length : run.shots.length + 1;
  if (!run.planned || run.photos?.status === 'running' || blocked || !remaining || (!!run.photos?.masterArtifactId && ['failed', 'interrupted'].includes(run.masterReview?.status ?? '')) || [run.appearance, run.masterReview, run.review].some(s => s?.status === 'running')) return null;
  if (rejected && !canRegenerateMaster(run)) return <Text variant="label" tone="secondary">{masterAttempts(run) >= 3 ? ui("Три опорных кадра не прошли проверку — в этой серии больше попыток нет.") : ui("По этому master уже создавались кадры — заменить его в этой серии нельзя.")} {ui(" Создай новую серию по сохранённому плану: Codex повторно не вызывается, стоимость фото подтверждается отдельно.")}</Text>;
  async function price(): Promise<void> {
    setLoading(true); setError(null); setConsent(false);
    try {
      const response = await fetch(`/api/production/${run.id}/photos/quote${rejected ? '?retryMaster=true' : ''}`);
      const data = await response.json() as PhotoQuote & { messageRu?: string };
      if (!response.ok) throw new Error(data.messageRu ?? 'Не удалось получить стоимость.');
      setQuote(data);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setLoading(false); }
  }
  return <div className={styles.costControls} data-photo-cost>
    {error && <Text role="alert">{error}</Text>}
    {quote && <>
      <Text variant="title-s">{ui("До ")}{photoPrice(quote.usd)} {ui(" за оставшуюся работу")}</Text>
      <Text variant="caption" tone="secondary">{photoOutput(run).resolution} · {photoOutput(run).aspectRatio}{ui(". Кадры: ")}{quote.shotCount} {ui(" · новых master: ")}{quote.sceneCount} {ui(" · запасных попыток: ")}{quote.reserveCount}{ui(". Без запаса — ")}{photoPrice(quote.baseUsd)}{ui(". Неиспользованные попытки не запускаются. Это оценка каталога; списание определяет Higgsfield.")}</Text>
      <label className={styles.check}><input type="checkbox" checked={consent} disabled={busy || run.paused} onChange={e => setConsent(e.target.checked)} />{ui("Подтверждаю сумму, автоматический подбор master (до трёх попыток всего) и передачу фото в Higgsfield и Codex.")}</label>
      <Text variant="caption" tone="secondary">{ui("Codex / OpenAI получит до шести фото Soul ID и результаты с четырьмя крупными фрагментами каждого фото для проверки деталей. Фрагменты увеличивают расход квоты. До пяти вызовов через твоё AI-подключение: внешность, до трёх проверок master, отбор серии. Видео и upscale не запускаются.")}</Text>
    </>}
    <div className={styles.gateActions}>
      <Button variant={quote ? 'ghost' : 'primary'} disabled={busy || run.paused} loading={loading} onClick={() => void price()}>{quote ? ui("Обновить оценку") : rejected ? ui("Пересоздать опорный кадр") : run.photos ? ui("Продолжить серию") : ui("Рассчитать стоимость фото")}</Button>
      {quote && <Button variant="primary" disabled={!consent || busy || run.paused} loading={busy} onClick={() => void photoCommand('photos/start', { rev: quote.rev, requestId, confirmUsd: quote.usd, refsConsent: true, reviewConsent: true, masterGateConsent: true, masterRetryConsent: true, ...(rejected ? { retryMaster: true } : {}) }).then(ok => { if (ok) { setQuote(null); setConsent(false); setRequestId(crypto.randomUUID()); } })}>{rejected ? ui("Новый master и серия") : ui("Создать фото")} {ui(" · до ")}{photoPrice(quote.usd)}</Button>}
    </div>
  </div>;
}
