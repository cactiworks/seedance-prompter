import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { billedSeconds, estimate, findModel, formatCost, forProvider, paramsFor, resolveSeeds, validateGen, type Estimate, type GenModel, type GenParams, type MediaKind, type ProviderId, type SentRef } from '../../core/gen/models.ts';
import { GenParamsSchema, OriginSchema, RefSourceSchema, type GenJob, type JobRef, type RefSource } from '../../core/model/media.ts';
import { createStore } from '../storage/fsStore.ts';
import { createJobStore, newJobId } from '../storage/jobStore.ts';
import { createLibrary, DownloadError, MIME_BY_EXT } from '../storage/library.ts';
import { createSessions } from '../storage/sessions.ts';
import { createUploads } from '../storage/uploads.ts';
import { createHiggsfieldProvider } from './higgsfield.ts';
import { createKieProvider } from './kie.ts';
import { probeVideo, type VideoInfo, type VideoProbe } from './ffmpeg.ts';
import { imageSize } from './imageSize.ts';
import { GenError, type GenProvider, type ProviderStyle } from './provider.ts';

/** Не больше задач за один запуск без отдельного решения владельца (правило объёмов). */
export const MAX_JOBS_PER_REQUEST = 4;
const CONCURRENCY = 3;
/** Дольше не ждём: KIE сам отвечает 408, если апстрим молчит 10 минут; видео 30 с в 1080p — с запасом. */
export const POLL_TIMEOUT_MS = 45 * 60_000;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_MS = [10_000, 60_000];
const ACTIVE = new Set<GenJob['status']>(['queued', 'running', 'downloading']);

export const SubmitRequestSchema = z.object({
  modelId: z.string(),
  prompt: z.string(),
  params: GenParamsSchema.optional(),
  refs: z.array(z.object({ label: z.string().optional(), source: RefSourceSchema, role: z.enum(['ref', 'start', 'end']).optional() })).optional(),
  count: z.number().optional(),
  /** Сумма, которую владелец видел и подтвердил. Не совпала с оценкой — задача не создаётся. */
  confirmCredits: z.number().optional(),
  /** Согласие отправить рефы провайдеру. */
  refsConsent: z.boolean().optional(),
  origin: OriginSchema.optional(),
  sessionId: z.string().optional(),
  /** Метка запуска (калибровка). */
  tag: z.string().max(160).optional(),
});
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

export class SubmitError extends Error {
  readonly code: string;
  readonly status: 409 | 412 | 422 | 428 | 500;
  readonly messageRu: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, status: SubmitError['status'], messageRu: string, details: Record<string, unknown> = {}) {
    super(messageRu);
    this.code = code;
    this.status = status;
    this.messageRu = messageRu;
    this.details = details;
  }
}

export interface GenRuntimeOptions {
  dataDir: string;
  /** По умолчанию — живой KIE с ключом из Keychain. */
  providers?: Partial<Record<ProviderId, GenProvider>>;
  /** fetch для скачивания результатов (в тестах — подмена). */
  fetch?: typeof fetch;
  now?: () => number;
  /** Длительность видео для цены апскейла (по умолчанию ffprobe; в тестах — подмена). */
  probe?: VideoProbe;
}

/** Что сервер намерил во входном файле: параметры для цены и подпись для формы. */
export interface Measured {
  params: GenParams;
  info: { width: number | null; height: number | null; durationSec: number | null; bytes: number } | null;
}

export const MeasureRequestSchema = z.object({ modelId: z.string(), refs: z.array(z.object({ source: RefSourceSchema })).max(1) });

const pollDelay = (job: GenJob): number => Math.min(30_000, (job.kind === 'video' ? 8_000 : 3_000) * 1.4 ** Math.min(job.polls, 10));

/**
 * Генерация целиком на сервере: задача ставится по клику, статус опрашивает сервер (не вкладка), результат
 * скачивается в библиотеку сразу по готовности — KIE хранит файлы около суток (решение 22).
 */
export function createGenRuntime(options: GenRuntimeOptions) {
  const now = options.now ?? Date.now;
  const providers: Partial<Record<ProviderId, GenProvider>> = options.providers ?? { kie: createKieProvider(), higgsfield: createHiggsfieldProvider() };
  const jobs = createJobStore(options.dataDir);
  const library = createLibrary(options.dataDir, { fetch: options.fetch, now });
  const projects = createStore(options.dataDir);
  const uploads = createUploads(options.dataDir);
  const sessions = createSessions(options.dataDir, now);
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const iso = (): string => new Date(now()).toISOString();
  const update = (job: GenJob, patch: Partial<GenJob>): Promise<GenJob> => jobs.put({ ...job, ...patch, updatedAt: iso() });

  const providerOf = (id: ProviderId): GenProvider => {
    const provider = providers[id];
    if (provider === undefined) throw new SubmitError('NO_PROVIDER', 500, `Провайдер «${id}» не подключён.`);
    return provider;
  };

  /** Файл входа. `media` — что ждёт модель: картинку (по умолчанию) или видео; видео берётся только из библиотеки. */
  async function readRef(source: RefSource, media: MediaKind = 'image'): Promise<{ bytes: Uint8Array; fileName: string; mime: string; filePath: string | null }> {
    if (media === 'video') {
      if (source.type !== 'media') throw new SubmitError('REF_NOT_VIDEO', 422, 'Видео на вход берётся из библиотеки.');
      const item = await library.get(source.mediaId);
      if (item === undefined) throw new SubmitError('REF_NOT_FOUND', 422, 'Файл из библиотеки не найден.');
      if (item.kind !== 'video') throw new SubmitError('REF_NOT_VIDEO', 422, 'Сюда нужно видео, а пришла картинка.');
      return { bytes: await library.readBytes(item), fileName: item.file.split('/').pop() ?? `${item.id}.mp4`, mime: item.mime, filePath: library.pathOf(item) };
    }
    if (source.type === 'projectRef') {
      const fileName = source.file.split('?')[0] ?? '';
      try {
        const bytes = await projects.readRef(source.slug, fileName);
        return { bytes, fileName, mime: MIME_BY_EXT[fileName.split('.').pop() ?? ''] ?? 'image/jpeg', filePath: null };
      } catch {
        throw new SubmitError('REF_NOT_FOUND', 422, `Нет файла референса «${fileName}» в проекте «${source.slug}».`);
      }
    }
    if (source.type === 'upload') {
      const found = await uploads.read(source.uploadId);
      if (found === undefined) throw new SubmitError('REF_NOT_FOUND', 422, 'Загруженная картинка не найдена — добавь её заново.');
      return { bytes: found.bytes, fileName: found.upload.fileName, mime: found.upload.mime, filePath: null };
    }
    const item = await library.get(source.mediaId);
    if (item === undefined) throw new SubmitError('REF_NOT_FOUND', 422, 'Файл из библиотеки не найден.');
    if (item.kind !== 'image') throw new SubmitError('REF_NOT_IMAGE', 422, 'Референсом пока может быть только картинка.');
    return { bytes: await library.readBytes(item), fileName: item.file.split('/').pop() ?? `${item.id}.png`, mime: item.mime, filePath: null };
  }

  /**
   * Параметры, которые меряет сервер по первому входу (длинная сторона картинки, секунды видео у апскейла), и предел
   * размера файла. Цена считается по ним, а не по словам клиента; форма берёт то же самое через /api/gen/measure.
   */
  async function measureRefs(model: GenModel, refs: readonly { source: RefSource }[]): Promise<Measured> {
    const derived = model.params.filter((d) => d.fromRef !== undefined);
    const first = refs[0];
    const media = model.refs.media ?? 'image';
    if (first === undefined || (derived.length === 0 && model.refs.maxBytes === undefined)) return { params: {}, info: null };
    const file = await readRef(first.source, media);
    const what = media === 'video' ? 'Видео' : 'Картинка';
    const limit = model.refs.maxBytes;
    if (limit !== undefined && file.bytes.byteLength > limit) throw new SubmitError('REF_TOO_LARGE', 422, `${what} ${(file.bytes.byteLength / 1024 / 1024).toFixed(1)} МБ — ${model.titleRu} принимает до ${limit / 1024 / 1024} МБ.`);
    const params: GenParams = {};
    if (media === 'video') {
      if (file.filePath === null) throw new SubmitError('REF_NOT_VIDEO', 422, 'Видео на вход берётся из библиотеки.');
      let video: VideoInfo;
      try {
        video = await (options.probe ?? probeVideo)(file.filePath);
      } catch (error) {
        throw new SubmitError('BAD_VIDEO', 422, error instanceof Error ? error.message : 'Не удалось прочитать видео.');
      }
      for (const d of derived) if (d.fromRef === 'seconds') params[d.key] = billedSeconds(video.durationSec);
      return { params, info: { width: video.width, height: video.height, durationSec: video.durationSec, bytes: file.bytes.byteLength } };
    }
    if (derived.length === 0) return { params, info: null };
    const size = imageSize(file.bytes);
    if (size === null) throw new SubmitError('BAD_IMAGE', 422, 'Не удалось прочитать размер картинки — нужен PNG, JPEG или WebP.');
    for (const d of derived) if (d.fromRef === 'longSide') params[d.key] = Math.max(size.width, size.height);
    return { params, info: { width: size.width, height: size.height, durationSec: null, bytes: file.bytes.byteLength } };
  }

  /** Замер для формы: тот же, что сделает submit, — цена на кнопке совпадёт с гейтом. */
  async function measure(raw: unknown): Promise<Measured> {
    const parsed = MeasureRequestSchema.safeParse(raw);
    if (!parsed.success) throw new SubmitError('BAD_REQUEST', 422, 'Неверный запрос замера.');
    const model = findModel(parsed.data.modelId);
    if (model === undefined) throw new SubmitError('UNKNOWN_MODEL', 422, `Модели «${parsed.data.modelId}» нет в каталоге.`);
    return measureRefs(model, parsed.data.refs);
  }

  async function submit(raw: unknown): Promise<{ jobs: GenJob[]; estimate: Estimate }> {
    const parsed = SubmitRequestSchema.safeParse(raw);
    if (!parsed.success) throw new SubmitError('BAD_REQUEST', 422, `Неверный запрос: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const request: SubmitRequest = parsed.data;
    const model = findModel(request.modelId);
    if (model === undefined) throw new SubmitError('UNKNOWN_MODEL', 422, `Модели «${request.modelId}» нет в каталоге.`);
    const provider = providerOf(model.provider);
    if (!provider.hasKey()) throw new SubmitError('NO_KEY', 412, `Нет ключа ${model.provider === 'kie' ? 'KIE (Keychain «kie-api-key»)' : 'Higgsfield API (Keychain «higgsfield-api-key»)'} — см. docs/DECISIONS.md, решение 21.`);

    const count = request.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > MAX_JOBS_PER_REQUEST) throw new SubmitError('BAD_COUNT', 422, `За один запуск — от 1 до ${MAX_JOBS_PER_REQUEST} генераций.`);
    // Параметры, которые меряет сервер (длинная сторона, секунды видео у апскейла): цена считается по ним, а не по словам клиента.
    const measured = (await measureRefs(model, request.refs ?? [])).params;
    const params = paramsFor(model, { ...(request.params ?? {}), ...measured });
    const refs: JobRef[] = (request.refs ?? []).map((r) => ({ label: r.label ?? '', source: r.source, role: r.role ?? 'ref' }));
    const roles = refs.map((r) => r.role);
    const problems = validateGen(model, request.prompt, params, roles);
    if (problems.length > 0) throw new SubmitError('INVALID', 422, problems.join(' '), { problems });

    const cost = estimate(model, params, count, refs.length);
    if (request.confirmCredits !== cost.credits) {
      throw new SubmitError('COST_CHANGED', 409, `Стоимость — ${formatCost(cost)}, подтверждено другое. Проверь параметры и подтверди заново.`, { estimate: cost });
    }
    if (refs.length > 0 && request.refsConsent !== true) {
      throw new SubmitError('REFS_CONSENT', 428, `Референсы (${refs.length}) уйдут в ${model.provider.toUpperCase()}, а оттуда — исполнителю модели. Подтверди отправку.`);
    }
    const origin = request.origin ?? null;
    const session = request.sessionId === undefined ? undefined : await sessions.get(request.sessionId);
    if (request.sessionId !== undefined && (session === undefined || session.kind !== model.kind)) throw new SubmitError('NO_SESSION', 422, 'Сессия не найдена или другого типа — выбери сессию заново.');
    // Файлы читаются до создания задач: отсутствующий реф не должен стоить ни кредита.
    const files = await Promise.all(refs.map((r) => readRef(r.source, model.refs.media)));
    const sentPrompt = forProvider(model, request.prompt).prompt;

    // Конкретный seed у каждой задачи сохраняется в её параметрах — кадр можно повторить (решение 27).
    const perJob = resolveSeeds(model, params, count, (max) => randomInt(1, max + 1));

    const created: GenJob[] = [];
    for (let i = 0; i < count; i += 1) {
      const jobParams = perJob[i] ?? params;
      created.push(
        await jobs.put({
          id: newJobId(),
          createdAt: iso(),
          updatedAt: iso(),
          modelId: model.id,
          provider: model.provider,
          providerModel: model.target(jobParams, roles),
          kind: model.kind,
          prompt: sentPrompt,
          params: jobParams,
          refs,
          origin,
          sessionId: session?.id ?? null,
          tag: request.tag ?? null,
          estimateCredits: cost.credits / count,
          estimateUsd: cost.usd / count,
          status: 'submitting',
          taskId: null,
          providerState: null,
          creditsConsumed: null,
          resultUrls: [],
          mediaIds: [],
          error: null,
          polls: 0,
          pollingSince: null,
          nextCheckAt: now(),
          downloadAttempts: 0,
          finishedAt: null,
        }),
      );
    }

    if (session !== undefined) {
      // Безымянная сессия получает имя по первому промпту — как чат в connxn.
      if (session.title === 'Новая сессия') await sessions.update(session.id, { title: request.prompt.replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ').slice(0, 48) });
      else await sessions.touch(session.id);
    }

    const fail = async (job: GenJob, code: string, messageRu: string): Promise<GenJob> => update(job, { status: 'failed', error: { code, messageRu }, finishedAt: iso() });

    // Рефы загружаются один раз на запуск и прямо перед задачей: у KIE загруженное живёт около суток.
    const sent: SentRef[] = [];
    try {
      for (const [i, file] of files.entries()) sent.push({ url: await provider.upload(file.bytes, file.fileName, file.mime), role: roles[i] ?? 'ref' });
    } catch (error) {
      const messageRu = error instanceof GenError ? error.messageRu : 'Не удалось загрузить референсы.';
      return { jobs: await Promise.all(created.map((job) => fail(job, 'UPLOAD_FAILED', messageRu))), estimate: cost };
    }

    const out: GenJob[] = [];
    let fatal: GenError | null = null;
    for (const job of created) {
      if (fatal !== null) {
        out.push(await fail(job, fatal.code, fatal.messageRu));
        continue;
      }
      try {
        const taskId = await provider.submit(job.providerModel, model.input(sentPrompt, job.params, sent));
        // taskId пишется сразу: по нему задача найдётся и после остановки сервера.
        out.push(await update(job, { status: 'queued', taskId, pollingSince: now(), nextCheckAt: now() + pollDelay(job) }));
      } catch (error) {
        const genError = error instanceof GenError ? error : new GenError('PROVIDER', error instanceof Error ? error.message : 'Задача не создана.');
        // Без кредитов или ключа следующие задачи упадут так же — не стучимся зря.
        if (['NO_CREDITS', 'AUTH', 'NO_KEY', 'INVALID'].includes(genError.code)) fatal = genError;
        out.push(await fail(job, genError.code, genError.messageRu));
      }
    }
    return { jobs: out, estimate: cost };
  }

  async function saveResults(job: GenJob): Promise<GenJob> {
    const provider = providerOf(job.provider);
    const mediaIds = [...job.mediaIds];
    let lastError = '';
    for (const [index, url] of job.resultUrls.entries()) {
      if (mediaIds[index] !== null && mediaIds[index] !== undefined) continue;
      const meta = {
        kind: job.kind,
        jobId: job.id,
        taskId: job.taskId,
        provider: job.provider,
        modelId: job.modelId,
        providerModel: job.providerModel,
        prompt: job.prompt,
        params: job.params,
        refs: job.refs,
        origin: job.origin,
        sessionId: job.sessionId,
        index,
        sourceUrl: url,
        creditsConsumed: job.creditsConsumed,
        createdAt: job.createdAt,
      };
      try {
        mediaIds[index] = (await library.download(url, meta)).id;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // Прямая ссылка не отдаёт файл — просим у провайдера временную (у KIE — download-url, 20 минут).
        if (error instanceof DownloadError && [401, 403, 404, 410].includes(error.status)) {
          const fresh = await provider.freshUrl(url);
          if (fresh !== null) {
            try {
              mediaIds[index] = (await library.download(fresh, meta)).id;
            } catch (retryError) {
              lastError = retryError instanceof Error ? retryError.message : String(retryError);
            }
          }
        }
      }
    }
    if (mediaIds.every((id) => id !== null)) return update(job, { status: 'saved', mediaIds, error: null, finishedAt: iso() });

    const attempts = job.downloadAttempts + 1;
    const error = { code: 'DOWNLOAD_FAILED', messageRu: `Не удалось скачать результат (${lastError}). Ссылка провайдера живёт около суток — нажми «Скачать снова».` };
    if (attempts >= MAX_DOWNLOAD_ATTEMPTS) return update(job, { status: 'download_failed', mediaIds, downloadAttempts: attempts, error, finishedAt: iso() });
    return update(job, { mediaIds, downloadAttempts: attempts, error, nextCheckAt: now() + (DOWNLOAD_RETRY_MS[attempts - 1] ?? 60_000) });
  }

  async function pollOnce(job: GenJob): Promise<GenJob> {
    if (job.taskId === null) return update(job, { status: 'failed', error: { code: 'NO_TASK', messageRu: 'У задачи нет taskId.' }, finishedAt: iso() });
    const timedOut = (): boolean => job.pollingSince !== null && now() - job.pollingSince > POLL_TIMEOUT_MS;
    const timeout = { status: 'failed' as const, error: { code: 'POLL_TIMEOUT', messageRu: `Результата нет ${POLL_TIMEOUT_MS / 60_000} минут. Задача могла доделаться — «Проверить снова» или kie.ai/logs.` }, finishedAt: iso() };
    let result;
    try {
      result = await providerOf(job.provider).poll(job.taskId);
    } catch (error) {
      if (!(error instanceof GenError)) throw error;
      // Ошибка опроса — не провал генерации: результат может прийти, продолжаем реже.
      if (timedOut()) return update(job, timeout);
      return update(job, { polls: job.polls + 1, error: { code: `POLL_${error.code}`, messageRu: `Не удалось узнать статус: ${error.messageRu}` }, nextCheckAt: now() + (error.code === 'AUTH' || error.code === 'NO_KEY' ? 60_000 : 30_000) });
    }
    if (result.state === 'success') {
      if (result.urls.length === 0) return update(job, { status: 'failed', providerState: result.providerState, creditsConsumed: result.creditsConsumed, error: { code: 'NO_RESULT', messageRu: 'Провайдер сообщил об успехе, но не вернул файл.' }, finishedAt: iso() });
      const ready = await update(job, { status: 'downloading', providerState: result.providerState, creditsConsumed: result.creditsConsumed, resultUrls: result.urls, mediaIds: result.urls.map(() => null), error: null });
      return saveResults(ready);
    }
    if (result.state === 'fail') {
      return update(job, { status: 'failed', providerState: result.providerState, creditsConsumed: result.creditsConsumed, error: { code: 'PROVIDER_FAIL', messageRu: result.failMsg === null ? 'Генерация не удалась, провайдер не назвал причину.' : `Генерация не удалась: ${result.failMsg}` }, finishedAt: iso() });
    }
    if (timedOut()) return update(job, { ...timeout, providerState: result.providerState });
    return update(job, { status: result.state, providerState: result.providerState, polls: job.polls + 1, error: null, nextCheckAt: now() + pollDelay(job) });
  }

  /** Один проход: берёт задачи, которым пора, не больше CONCURRENCY одновременно. Промис — для тестов. */
  async function tick(): Promise<void> {
    const due = (await jobs.all()).filter((job) => ACTIVE.has(job.status) && job.nextCheckAt <= now() && !inFlight.has(job.id)).sort((a, b) => a.nextCheckAt - b.nextCheckAt);
    const batch = due.slice(0, Math.max(0, CONCURRENCY - inFlight.size));
    await Promise.all(
      batch.map(async (job) => {
        inFlight.add(job.id);
        try {
          await (job.status === 'downloading' ? saveResults(job) : pollOnce(job));
        } catch (error) {
          console.error(`Задача ${job.id}:`, error);
          // Неожиданная ошибка не должна дёргать задачу каждую секунду.
          await update(job, { nextCheckAt: now() + 60_000 }).catch(() => undefined);
        } finally {
          inFlight.delete(job.id);
        }
      }),
    );
  }

  /**
   * После перезапуска: задача с taskId продолжает опрос; без taskId — провал без повтора. Сервер
   * остановился посреди createTask, задача могла быть создана и оплачена — решать владельцу.
   */
  async function recover(): Promise<void> {
    for (const job of await jobs.all()) {
      if (job.status !== 'submitting') continue;
      if (job.taskId !== null) await update(job, { status: 'queued', nextCheckAt: now() });
      else await update(job, { status: 'failed', error: { code: 'SUBMIT_INTERRUPTED', messageRu: 'Сервер остановился во время отправки. Посмотри kie.ai/logs, прежде чем запускать заново: задача могла быть создана и оплачена.' }, finishedAt: iso() });
    }
  }

  async function retry(id: string): Promise<GenJob> {
    const job = await jobs.get(id);
    if (job === undefined) throw new SubmitError('NOT_FOUND', 422, 'Задача не найдена.');
    if (job.status === 'download_failed') return update(job, { status: 'downloading', downloadAttempts: 0, error: null, nextCheckAt: now(), finishedAt: null });
    if (job.status === 'failed' && job.error?.code === 'POLL_TIMEOUT' && job.taskId !== null) return update(job, { status: 'running', pollingSince: now(), error: null, nextCheckAt: now(), finishedAt: null });
    throw new SubmitError('NOT_RETRYABLE', 409, 'Эту задачу не повторить без новой генерации — запусти заново (это новые кредиты).');
  }

  // Готовые мудборды меняются редко — кеш на час, чтобы не дёргать провайдера при каждом открытии панели.
  const styleCache = new Map<string, { at: number; list: ProviderStyle[] }>();
  async function styles(id: ProviderId): Promise<ProviderStyle[]> {
    const provider = providers[id];
    if (provider?.listStyles === undefined || !provider.hasKey()) return [];
    const hit = styleCache.get(id);
    if (hit !== undefined && now() - hit.at < 60 * 60_000) return hit.list;
    const list = await provider.listStyles();
    styleCache.set(id, { at: now(), list });
    return list;
  }

  type Status = { hasKey: boolean; keyProblem?: string; balance?: number; balanceError?: string };
  async function status(withBalance: boolean): Promise<Record<string, Status>> {
    const out: Record<string, Status> = {};
    for (const [id, provider] of Object.entries(providers)) {
      const hasKey = provider.hasKey();
      const problem = provider.keyProblem?.() ?? null;
      out[id] = problem === null ? { hasKey } : { hasKey, keyProblem: problem };
      if (!withBalance || !hasKey || provider.balance === undefined) continue;
      try {
        out[id] = { hasKey, balance: await provider.balance() };
      } catch (error) {
        out[id] = { hasKey, balanceError: error instanceof GenError ? error.messageRu : 'Баланс не получен.' };
      }
    }
    return out;
  }

  return {
    jobs,
    library,
    uploads,
    sessions,
    styles,
    submit,
    measure,
    retry,
    status,
    tick,
    recover,
    async start(): Promise<void> {
      if (timer !== null) return;
      await recover();
      timer = setInterval(() => void tick(), 1_000);
      timer.unref();
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

export type GenRuntime = ReturnType<typeof createGenRuntime>;
