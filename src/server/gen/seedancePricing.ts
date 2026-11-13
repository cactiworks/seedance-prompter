import { GenError, type ProviderEstimate } from './provider.ts';

/** Parse only recognized tariffs returned by /estimate; never fall back to cached prices. */
export function seedanceTariff(endpoint: string, input: Record<string, unknown>, description: string): ProviderEstimate {
  const index = ['480p','720p','1080p'].indexOf(String(input.resolution));
  const seconds = input.duration;
  if (!/^bytedance\/seedance-2\.5\/(?:image-to-video|reference-to-video|text-to-video)$/.test(endpoint)
    || index < 0 || typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 4 || seconds > 30
    || input.video_url != null || (Array.isArray(input.video_urls) && input.video_urls.length > 0) || description.length > 6000) {
    throw new GenError('PROVIDER','Higgsfield вернул описание тарифа, которое не удалось рассчитать. Генерация не отправлена.');
  }
  const text = description.trim().replace(/\s+/g, ' ');
  const selfServe = text.match(/^Standard self-serve rates in USD per video second: 480p: \$(\d+(?:\.\d+)?); 720p: \$(\d+(?:\.\d+)?); 1080p: \$(\d+(?:\.\d+)?)[.] Total price = selected rate × output duration in seconds[.]$/);
  const reference = text.match(/^Standard self-serve rates in USD per second of generated video[.] - Without video input: 480p: \$(\d+(?:\.\d+)?); 720p: \$(\d+(?:\.\d+)?); 1080p: \$(\d+(?:\.\d+)?)[.] - With video input: 480p: \$(\d+(?:\.\d+)?); 720p: \$(\d+(?:\.\d+)?); 1080p: \$(\d+(?:\.\d+)?)[.] Total price = selected rate × output duration in seconds[.] Input video duration is not added to the billed duration[.] Image or audio references alone use the rate without video input[.]$/);
  const legacy = text.match(/^For 16:9 video without video input, your request costs roughly \$(\d+(?:\.\d+)?) per second of generated video at 480p, \$(\d+(?:\.\d+)?) at 720p, and \$(\d+(?:\.\d+)?) at 1080p\./);
  const rates = selfServe ?? reference ?? legacy;
  if (!rates || rates.slice(1).some(rate => !Number.isFinite(Number(rate)) || Number(rate) <= 0)) {
    throw new GenError('PROVIDER','Higgsfield вернул неизвестный тариф Seedance. Повтори расчёт цены. Генерация не отправлена.');
  }
  const perSecond = Number(rates[index + 1]);
  const usd = Number((perSecond * seconds).toFixed(6));
  const basis = selfServe || reference ? 'self-serve' : 'для 16:9';
  return { credits:usd, usd, unitRu:'$', approximate:true, pricingDescription:description,
    pricingNote:`Ориентир по тарифу Higgsfield ${basis}: $${perSecond}/с × ${seconds} с, до скидок аккаунта. Фактическое списание зависит от размеров результата и может отличаться. Это не верхний предел расходов.` };
}
