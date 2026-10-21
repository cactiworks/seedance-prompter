import { createHash, randomUUID } from 'node:crypto';
import { forProvider, type Estimate, type GenModel, type GenParams, type SentRef } from '../../core/gen/models.ts';
import type { JobRef } from '../../core/model/media.ts';
import type { GenProvider } from './provider.ts';
import { SubmitError } from './runtime.ts';

export interface QuoteFile { bytes: Uint8Array; fileName: string; mime: string }
interface Quote { fingerprint: string; expiresAt: number; sent: SentRef[]; estimate: Estimate }
/** Quotes authorize one exact submission. Lost/restarted quotes require a new user confirmation. */
export function createGenerationQuotes(now: () => number) {
  const quotes = new Map<string, Quote>();
  const fingerprint = (model: GenModel, prompt: string, params: GenParams, refs: JobRef[], count: number, files: QuoteFile[]) =>
    createHash('sha256').update(JSON.stringify([model.id, prompt, Object.entries(params).sort(), refs.map(r => ({ label:r.label, role:r.role, source:r.source })), count, files.map(f => createHash('sha256').update(f.bytes).digest('hex'))])).digest('hex');
  async function price(provider: GenProvider, model: GenModel, prompt: string, params: GenParams, sent: SentRef[], count: number): Promise<Estimate> {
    if (!provider.estimate) throw new SubmitError('NO_ESTIMATE', 412, 'Оценка Higgsfield недоступна. Генерация не отправлена.');
    const value = await provider.estimate(model.target(params, sent.map(r => r.role)), model.input(forProvider(model, prompt).prompt, params, sent));
    if (!Number.isFinite(value.credits) || !Number.isFinite(value.usd) || value.credits <= 0 || value.usd <= 0) throw new SubmitError('NO_ESTIMATE', 412, 'Higgsfield не вернул цену. Генерация не отправлена.');
    return { credits: Number((value.credits * count).toFixed(6)), usd: Number((value.usd * count).toFixed(6)), unitRu: 'кр Higgsfield' };
  }
  return {
    async prepare(provider: GenProvider, model: GenModel, prompt: string, params: GenParams, refs: JobRef[], count: number, files: QuoteFile[]) {
      for (const [id, q] of quotes) if (q.expiresAt <= now()) quotes.delete(id);
      if (quotes.size >= 100) throw new SubmitError('QUOTE_LIMIT', 409, 'Слишком много незавершённых оценок. Повтори позже.');
      const sent: SentRef[] = [];
      for (const [i, file] of files.entries()) sent.push({ url: await provider.upload(file.bytes, file.fileName, file.mime), role: refs[i]!.role });
      const estimate = await price(provider, model, prompt, params, sent, count);
      const quoteId = randomUUID();
      quotes.set(quoteId, { fingerprint: fingerprint(model, prompt, params, refs, count, files), expiresAt: now() + 600_000, sent, estimate });
      return { quoteId, estimate };
    },
    async consume(id: string | undefined, confirmed: number | undefined, provider: GenProvider, model: GenModel, prompt: string, params: GenParams, refs: JobRef[], count: number, files: QuoteFile[]) {
      const quote = id ? quotes.get(id) : undefined;
      if (!quote || quote.expiresAt <= now() || quote.fingerprint !== fingerprint(model, prompt, params, refs, count, files)) throw new SubmitError('QUOTE_REQUIRED', 409, 'Запрос изменился или оценка устарела. Рассчитай и подтверди цену заново.');
      // Reserve synchronously before any await: a double click cannot spend twice.
      quotes.delete(id!);
      const estimate = await price(provider, model, prompt, params, quote.sent, count);
      if (confirmed !== quote.estimate.credits || quote.estimate.credits !== estimate.credits || quote.estimate.usd !== estimate.usd) throw new SubmitError('COST_CHANGED', 409, 'Цена Higgsfield изменилась. Рассчитай и подтверди её заново.', { estimate });
      return { estimate, sent: quote.sent };
    },
  };
}
