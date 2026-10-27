import { keyProblem, readSecret, KEYCHAIN } from '../secrets.ts';
import { GenError, type GenProvider, type PollResult, type PollState } from './provider.ts';
import { uploadHiggsfieldFile } from './higgsfieldUpload.ts';
import { seedanceTariff } from './seedancePricing.ts';

// Официальный API: docs.higgsfield.ai (quickstart, authentication, models/soul-2). Сверено 27.09.2026.
// Отдельный продукт с балансом в USD — кредиты подписки higgsfield.ai здесь не тратятся (решение 21).
const API = 'https://api.higgsfield.ai';

const STATE: Record<string, PollState> = { queued: 'queued', in_progress: 'running', completed: 'success', failed: 'fail', nsfw: 'fail', canceled: 'fail' };

export interface HiggsfieldOptions {
  /** По умолчанию — Keychain `higgsfield-api-key` в виде `KEY_ID:KEY_SECRET`. */
  apiKey?: () => string | null;
  fetch?: typeof fetch;
}

function errorFor(status: number, detail: string): GenError {
  const tail = detail !== '' ? ` (${detail})` : '';
  if (status === 401) return new GenError('AUTH', `Higgsfield отклонил ключ${tail}. Проверь запись «${KEYCHAIN.higgsfield}» в хранилище ключей (формат KEY_ID:KEY_SECRET).`);
  if (status === 403) return new GenError('NO_CREDITS', `На балансе Higgsfield API не хватает денег${tail}.`);
  if (status === 404) return new GenError('NOT_FOUND', `Higgsfield не нашёл задачу${tail}.`);
  if (status === 422) return new GenError('INVALID', `Higgsfield отклонил параметры${tail}.`);
  if (status === 429 || (status === 400 && /concurrent/i.test(detail))) return new GenError('RATE_LIMIT', `Higgsfield: слишком много одновременных задач${tail}. Подожди, пока доделаются текущие.`);
  if (status === 423 || status === 503) return new GenError('PROVIDER', `Модель Higgsfield сейчас недоступна${tail}.`);
  return new GenError('PROVIDER', `Higgsfield ответил ошибкой ${status}${tail}.`);
}

const isUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//.test(value);

export function createHiggsfieldProvider(options: HiggsfieldOptions = {}): GenProvider {
  const getKey = options.apiKey ?? (() => readSecret(KEYCHAIN.higgsfield));
  const doFetch = options.fetch ?? fetch;

  const key = (): string => {
    const value = getKey();
    const problem = keyProblem('higgsfield', value);
    if (problem !== null || value === null) throw new GenError('NO_KEY', `Ключ Higgsfield API не готов: ${problem ?? 'нет значения'}.`);
    return value;
  };

  async function call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Key ${key()}`);
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, { ...init, headers, signal: AbortSignal.timeout(90_000), redirect: 'error' });
    } catch {
      throw new GenError('NETWORK', 'Higgsfield не отвечает — проверь интернет и повтори.');
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const detail = typeof body.detail === 'string' ? body.detail : typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : '';
      throw errorFor(res.status, detail);
    }
    return body;
  }

  return {
    id: 'higgsfield',

    hasKey: () => keyProblem('higgsfield', getKey()) === null,
    keyProblem: () => keyProblem('higgsfield', getKey()),

    async upload(bytes, _name, mime) {
      try { return await uploadHiggsfieldFile(bytes, mime, (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), doFetch); }
      catch { throw new GenError('NETWORK', 'Не удалось загрузить reference сцены в Higgsfield. Генерация не отправлена.'); }
    },

    async estimate(endpoint, input) {
      const body = await call(`/estimate/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const numeric = (value:unknown) => typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
      const credits = Number(body.credits); const usd = Number(body.usd);
      if (numeric(body.credits) && numeric(body.usd) && Number.isFinite(credits) && Number.isFinite(usd) && credits > 0 && usd > 0) return { credits, usd };
      if (body.type === 'description' && typeof body.pricing_description === 'string') return seedanceTariff(endpoint,input,body.pricing_description);
      throw new GenError('PROVIDER', 'Higgsfield не вернул корректную цену. Генерация не отправлена.');
    },

    async submit(endpoint, input) {
      const body = await call(`/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      if (typeof body.request_id !== 'string' || body.request_id === '') throw new GenError('PROVIDER', 'Higgsfield не вернул request_id.');
      return body.request_id;
    },

    async poll(requestId): Promise<PollResult> {
      const body = await call(`/requests/${encodeURIComponent(requestId)}/status`);
      const providerState = typeof body.status === 'string' ? body.status : 'unknown';
      const images = Array.isArray(body.images) ? body.images.map((i) => (i as { url?: unknown }).url).filter(isUrl) : [];
      const video = (body.video as { url?: unknown } | undefined)?.url;
      const failMsg = providerState === 'nsfw' ? 'модерация Higgsfield отклонила результат (nsfw), деньги не списаны' : providerState === 'canceled' ? 'задача отменена' : typeof body.error === 'string' ? body.error : null;
      return { state: STATE[providerState] ?? 'running', providerState, urls: isUrl(video) ? [video] : images, creditsConsumed: null, failMsg };
    },

    // Ссылки Higgsfield живут не меньше 7 дней; запасного способа получить новую нет.
    freshUrl: async () => null,

    // Готовые мудборды Soul 2 (33 на 28.09.2026). Свой мудборд через API не создаётся — только в вебе Higgsfield.
    async listStyles() {
      const body = (await call('/v1/text2image/soul-styles/v2')) as unknown;
      const list = Array.isArray(body) ? body : Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
      return list
        .map((s) => s as { id?: unknown; name?: unknown; description?: unknown; preview_url?: unknown })
        .filter((s): s is { id: string; name: string; description?: unknown; preview_url?: unknown } => typeof s.id === 'string' && typeof s.name === 'string')
        .map((s) => ({ id: s.id, name: s.name, description: typeof s.description === 'string' ? s.description : '', previewUrl: isUrl(s.preview_url) ? s.preview_url : null }));
    },
  };
}
