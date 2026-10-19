import { KEYCHAIN, keyProblem, readSecret } from '../secrets.ts';
import { GenError, type GenProvider, type PollResult, type PollState } from './provider.ts';

// Документация: docs.kie.ai (Market API, File Upload API, Common API). Сверено 27.09.2026.
const API = 'https://api.kie.ai';
// В примерах загрузки — отдельный хост, хотя OpenAPI называет api.kie.ai.
const UPLOAD = 'https://kieai.redpandaai.co';
const UPLOAD_PATH = 'seedance-prompter';

const STATE: Record<string, PollState> = { waiting: 'queued', queuing: 'queued', generating: 'running', success: 'success', fail: 'fail' };

export interface KieOptions {
  /** По умолчанию — Keychain `kie-api-key`. */
  apiKey?: () => string | null;
  fetch?: typeof fetch;
}

interface KieBody {
  code?: number;
  msg?: string;
  data?: unknown;
}

// Ошибки KIE приходят и HTTP-статусом, и полем code в теле при HTTP 200 — разбираем оба.
function errorFor(code: number, msg: string | undefined): GenError {
  const detail = msg !== undefined && msg !== '' ? ` (${msg})` : '';
  switch (code) {
    case 401:
      return new GenError('AUTH', `KIE отклонил ключ${detail}. Проверь запись «${KEYCHAIN.kie}» в хранилище ключей.`);
    case 402:
      return new GenError('NO_CREDITS', `На балансе KIE не хватает кредитов${detail}.`);
    case 404:
      return new GenError('NOT_FOUND', `KIE не нашёл задачу${detail}.`);
    case 422:
      return new GenError('INVALID', `KIE отклонил параметры${detail}.`);
    case 429:
    case 433:
      return new GenError('RATE_LIMIT', `Превышен лимит запросов KIE${detail}. Подожди и повтори.`);
    default:
      return new GenError('PROVIDER', `KIE ответил ошибкой ${code}${detail}.`);
  }
}

const isUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//.test(value);

/** resultJson — строка с JSON: {"resultUrls": [...]} (у Seedance ещё firstFrameUrl/lastFrameUrl — их не берём). */
export function parseResultUrls(resultJson: unknown): string[] {
  if (typeof resultJson !== 'string' || resultJson === '') return [];
  try {
    const parsed = JSON.parse(resultJson) as { resultUrls?: unknown };
    return Array.isArray(parsed.resultUrls) ? parsed.resultUrls.filter(isUrl) : [];
  } catch {
    return [];
  }
}

export function createKieProvider(options: KieOptions = {}): GenProvider {
  const getKey = options.apiKey ?? (() => readSecret(KEYCHAIN.kie));
  const doFetch = options.fetch ?? fetch;

  const key = (): string => {
    const value = getKey();
    const problem = keyProblem('kie', value);
    if (problem !== null || value === null) throw new GenError('NO_KEY', `Ключ KIE не готов: ${problem ?? 'нет значения'}.`);
    return value;
  };

  async function call(url: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${key()}`);
    let res: Response;
    try {
      res = await doFetch(url, { ...init, headers, signal: AbortSignal.timeout(90_000) });
    } catch {
      throw new GenError('NETWORK', 'KIE не отвечает — проверь интернет и повтори.');
    }
    const body = (await res.json().catch(() => null)) as KieBody | null;
    const code = res.ok ? (body?.code ?? 200) : res.status;
    if (code !== 200) throw errorFor(code, body?.msg);
    return body?.data;
  }

  return {
    id: 'kie',

    hasKey: () => keyProblem('kie', getKey()) === null,
    keyProblem: () => keyProblem('kie', getKey()),

    async upload(bytes, fileName, mime) {
      const form = new FormData();
      form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), fileName);
      form.append('uploadPath', UPLOAD_PATH);
      form.append('fileName', fileName);
      const data = (await call(`${UPLOAD}/api/file-stream-upload`, { method: 'POST', body: form })) as { downloadUrl?: unknown; fileUrl?: unknown } | null;
      const url = data?.downloadUrl ?? data?.fileUrl;
      if (!isUrl(url)) throw new GenError('PROVIDER', 'KIE принял файл, но не вернул ссылку на него.');
      return url;
    },

    async submit(providerModel, input) {
      const data = (await call(`${API}/api/v1/jobs/createTask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: providerModel, input }),
      })) as { taskId?: unknown } | null;
      if (typeof data?.taskId !== 'string' || data.taskId === '') throw new GenError('PROVIDER', 'KIE не вернул taskId.');
      return data.taskId;
    },

    async poll(taskId): Promise<PollResult> {
      const data = (await call(`${API}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`)) as {
        state?: unknown;
        resultJson?: unknown;
        failMsg?: unknown;
        failCode?: unknown;
        creditsConsumed?: unknown;
      } | null;
      const providerState = typeof data?.state === 'string' ? data.state : 'unknown';
      const failMsg = typeof data?.failMsg === 'string' && data.failMsg !== '' ? data.failMsg : typeof data?.failCode === 'string' && data.failCode !== '' ? `код ${data.failCode}` : null;
      return {
        state: STATE[providerState] ?? 'running',
        providerState,
        urls: parseResultUrls(data?.resultJson),
        creditsConsumed: typeof data?.creditsConsumed === 'number' ? data.creditsConsumed : null,
        failMsg,
      };
    },

    async freshUrl(url) {
      try {
        const data = await call(`${API}/api/v1/common/download-url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
        return isUrl(data) ? data : null;
      } catch {
        return null;
      }
    },

    async balance() {
      const data = await call(`${API}/api/v1/chat/credit`);
      if (typeof data !== 'number') throw new GenError('PROVIDER', 'KIE вернул баланс в неожиданном виде.');
      return data;
    },
  };
}
