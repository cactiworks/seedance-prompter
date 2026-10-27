import { GenError, type ProviderEstimate } from './provider.ts';

/** Higgsfield returns a tariff for Seedance, rather than an account-specific quote.
 * Use only its explicit 16:9/no-video per-second rates; never claim inferred output dimensions.
 */
export function seedanceTariff(endpoint: string, input: Record<string, unknown>, description: string): ProviderEstimate {
  const rates = description.match(/For 16:9 video without video input, your request costs roughly \$(\d+(?:\.\d+)?) per second of generated video at 480p, \$(\d+(?:\.\d+)?) at 720p, and \$(\d+(?:\.\d+)?) at 1080p\./);
  const index = ['480p','720p','1080p'].indexOf(String(input.resolution));
  const seconds = input.duration;
  if (!/^bytedance\/seedance-2\.5\/(?:image-to-video|reference-to-video|text-to-video)$/.test(endpoint)
    || !rates || index < 0 || typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 4 || seconds > 30
    || (Array.isArray(input.video_urls) && input.video_urls.length > 0) || description.length > 6000) {
    throw new GenError('PROVIDER','Higgsfield вернул описание тарифа, которое не удалось рассчитать. Генерация не отправлена.');
  }
  const perSecond = Number(rates[index + 1]);
  if (!Number.isFinite(perSecond) || perSecond <= 0) throw new GenError('PROVIDER','Higgsfield не вернул применимый тариф. Генерация не отправлена.');
  const usd = Number((perSecond * seconds).toFixed(6));
  return { credits:usd, usd, unitRu:'$', approximate:true, pricingDescription:description,
    pricingNote:`Ориентир по тарифу Higgsfield для 16:9: $${perSecond}/с × ${seconds} с, до скидок аккаунта. Фактическое списание зависит от размеров результата и может отличаться. Это не верхний предел расходов.` };
}
