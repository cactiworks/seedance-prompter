import { z } from 'zod';
import { uploadHiggsfieldFile } from '../gen/higgsfieldUpload.ts';
import { KEYCHAIN, keyProblem, readSecret } from '../secrets.ts';

const API = 'https://api.higgsfield.ai';
const ReferenceSchema = z.object({
  id: z.uuid(), name: z.string().max(100),
  status: z.enum(['not_ready', 'queued', 'in_progress', 'completed', 'failed']),
  model_version: z.string().optional(),
});
export type SoulReference = z.infer<typeof ReferenceSchema>;
export interface SoulIdProvider {
  upload(bytes: Uint8Array, mime: string): Promise<string>;
  create(name: string, urls: string[]): Promise<SoulReference>;
  get(id: string): Promise<SoulReference>;
  list(page: number): Promise<{ items: SoulReference[]; total_pages: number }>;
}
export class SoulIdError extends Error {
  readonly status: 401 | 404 | 409 | 422 | 502;
  constructor(message: string, status: SoulIdError['status'] = 502) { super(message); this.status = status; }
}
/** No retries, no inference SDK. Credentials never leave the API host or enter process.env. */
export function createSoulIdProvider(options: { apiKey?: () => string | null; fetch?: typeof fetch } = {}): SoulIdProvider {
  const doFetch = options.fetch ?? fetch;
  async function call(endpoint: string, body?: object): Promise<unknown> {
    const key = (options.apiKey ?? (() => readSecret(KEYCHAIN.higgsfield)))();
    if (key === null || keyProblem('higgsfield', key)) throw new SoulIdError('Проверь ключ Higgsfield в настройках подключений.', 401);
    let response: Response;
    try {
      response = await doFetch(`${API}${endpoint}`, {
        method: body ? 'POST' : 'GET', headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90_000), redirect: 'error',
      });
    } catch { throw new SoulIdError('Higgsfield не ответил. Отправка автоматически не повторяется.'); }
    // Do not expose vendor messages, signed URLs, or credentials in local errors/logs.
    if (!response.ok) throw new SoulIdError(response.status === 401 ? 'Higgsfield отклонил ключ.' : response.status === 404 ? 'Soul ID не найден в этом API-аккаунте.' : `Higgsfield отклонил запрос (HTTP ${response.status}).`, response.status === 401 ? 401 : response.status === 404 ? 404 : 502);
    try { return await response.json(); } catch { throw new SoulIdError('Higgsfield вернул нечитаемый ответ.'); }
  }
  const reference = (value: unknown): SoulReference => {
    const parsed = ReferenceSchema.safeParse(value);
    if (!parsed.success) throw new SoulIdError('Ответ Soul ID не соответствует ожидаемому формату.');
    return parsed.data;
  };
  return {
    async upload(bytes, mime) {
      try { return await uploadHiggsfieldFile(bytes, mime, call, doFetch); }
      catch (error) { throw error instanceof SoulIdError ? error : new SoulIdError(error instanceof Error ? error.message : 'Не удалось загрузить фото.'); }
    },
    create: async (name, urls) => reference(await call('/v1/custom-references', { name, model_version: 'v2', input_images: urls.map((image_url) => ({ type: 'image_url', image_url })) })),
    get: async (id) => reference(await call(`/v1/custom-references/${encodeURIComponent(z.uuid().parse(id))}`)),
    async list(page) {
      const parsed = z.object({ items: z.array(ReferenceSchema), total_pages: z.number().int().min(0).max(100) }).safeParse(await call(`/v1/custom-references/list?page=${page}&page_size=20`));
      if (!parsed.success) throw new SoulIdError('Не удалось прочитать список Soul ID.');
      return parsed.data;
    },
  };
}
