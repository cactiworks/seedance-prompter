import type { ProviderId } from '../../core/gen/models.ts';

export type PollState = 'queued' | 'running' | 'success' | 'fail';
export interface ProviderEstimate { credits:number; usd:number; unitRu?:string; approximate?:boolean; pricingNote?:string; pricingDescription?:string }

export interface PollResult {
  state: PollState;
  /** Как состояние назвал сам провайдер. */
  providerState: string;
  urls: string[];
  creditsConsumed: number | null;
  failMsg: string | null;
}

/** Провайдер генерации. Живые реализации — kie.ts; в тестах подменяется через AppOptions.gen. */
export interface GenProvider {
  readonly id: ProviderId;
  /** Ключ есть и похож на ключ. */
  hasKey(): boolean;
  /** Что не так с ключом, по-русски и без значения; null — всё в порядке. */
  keyProblem?(): string | null;
  /** Загрузить локальный файл и получить URL, который примет модель. */
  upload(bytes: Uint8Array, fileName: string, mime: string): Promise<string>;
  /** Создать задачу; возвращает taskId. Повторять вслепую нельзя: идемпотентности нет. */
  submit(providerModel: string, input: Record<string, unknown>): Promise<string>;
  estimate?(endpoint: string, input: Record<string, unknown>): Promise<ProviderEstimate>;
  poll(taskId: string): Promise<PollResult>;
  /** Запасная ссылка на результат, если прямая не отдаёт файл; null — не получилось. */
  freshUrl(url: string): Promise<string | null>;
  /** Баланс в единицах провайдера; у Higgsfield API такого запроса нет. */
  balance?(): Promise<number>;
  /** Готовые мудборды (стили) модели; есть у Higgsfield для Soul 2. */
  listStyles?(): Promise<ProviderStyle[]>;
}

export interface ProviderStyle {
  id: string;
  name: string;
  description: string;
  previewUrl: string | null;
}

export type GenErrorCode = 'NO_KEY' | 'NO_CREDITS' | 'RATE_LIMIT' | 'AUTH' | 'INVALID' | 'NOT_FOUND' | 'PROVIDER' | 'NETWORK';

export class GenError extends Error {
  readonly code: GenErrorCode;
  readonly messageRu: string;
  constructor(code: GenErrorCode, messageRu: string) {
    super(messageRu);
    this.code = code;
    this.messageRu = messageRu;
  }
}

export const GEN_HTTP: Record<GenErrorCode, 402 | 404 | 412 | 422 | 429 | 502> = {
  NO_KEY: 412,
  NO_CREDITS: 402,
  RATE_LIMIT: 429,
  AUTH: 502,
  INVALID: 422,
  NOT_FOUND: 404,
  PROVIDER: 502,
  NETWORK: 502,
};
