import { randomUUID } from 'node:crypto';
import { canRegenerateMaster, masterAttempts, masterRejected, replaceRejectedMaster, PHOTO_MODEL, photoParams, quotePhotos, type PhotoStart, type PhotoState } from '../../core/production/photos.ts';
import { ProductionError, record } from '../../core/production/engine.ts';
import type { ProductionRun, Artifact } from '../../core/production/model.ts';
import type { GenRuntime } from '../gen/runtime.ts';
import { SubmitError } from '../gen/runtime.ts';
import { appearanceReady, boundPrompts, pendingAppearance } from '../../core/production/appearance.ts';
import { masterApproved, pendingReview } from '../../core/production/review.ts';
import { hasStoryEvents } from '../../core/production/plan.ts';
import { quotePhotoSelection, type ContinuePhotos } from '../../core/production/selection.ts';

interface Store {
  get(id: string): Promise<ProductionRun>;
  update(id: string, change: (run: ProductionRun) => Promise<void> | void): Promise<ProductionRun>;
}
const failed = (item: PhotoState['items'][number]) => ['failed', 'unknown', 'download_failed'].includes(item.status);
const readyForPhotos = (run: ProductionRun): void => {
  if (run.mode !== 'photos' || !run.planned || !run.promptPlan || !run.scenePlan) throw new ProductionError('INVALID', 'Сначала нужен готовый план серии реальных фото.');
  if (run.paused) throw new ProductionError('INVALID', 'Сначала сними паузу серии.');
};

/** One durable intent per image. No blind resubmission; pending slots need renewed consent after restart. */
export function createPhotoProduction(store: Store, gen: GenRuntime | undefined, now: () => number) {
  const sending = new Set<string>();
  let stopped = false;
  const requireGen = (): GenRuntime => {
    if (!gen) throw new ProductionError('INVALID', 'Генератор фото не подключён. Перезапусти сервер новой версии.');
    return gen;
  };
  async function continueSelection(id: string, input: ContinuePhotos): Promise<ProductionRun> {
    return store.update(id, run => {
      if (run.photos?.requests.some(r => r.id === input.requestId)) return;
      if (run.rev !== input.rev) throw new ProductionError('CONFLICT', 'Серия изменилась. Обнови выбор и стоимость.');
      const quote = quotePhotoSelection(run, input.ids);
      if (input.consent !== true || quote.usd !== input.confirmUsd) throw new ProductionError('INVALID', 'Подтверди текущую стоимость перегенерации.');
      if (quote.count) {
        requireGen();
        if (!masterApproved(run)) throw new ProductionError('INVALID', 'Перед новыми генерациями нужна пройденная проверка опорного кадра.');
      }
      const state = run.photos!;
      for (const shot of run.shots) {
        if (shot.acceptedPhotoId) continue;
        if (input.ids.includes(shot.photoId!)) {
          shot.acceptedPhotoId = shot.photoId;
          shot.step = 'ready'; shot.error = null;
          run.approvals.push({ kind: 'photo', artifactId: shot.photoId!, at: new Date(now()).toISOString() });
        } else {
          const index = state.items.findIndex(i => i.key === shot.id);
          if (index < 0) throw new ProductionError('INVALID', 'Позиция отсутствует в задачах серии.');
          state.items[index] = { key: shot.id, tag: `production:${run.id}:${input.requestId}:${shot.id}`, jobId: null, taskId: null, status: 'pending', mediaId: null, error: null, errorCode: null };
          shot.photoId = null; shot.step = 'photos'; shot.error = null;
        }
      }
      state.requests.push({ id: input.requestId, usd: quote.usd, at: new Date(now()).toISOString() });
      state.budget = { remainingUsd: quote.usd, perImageUsd: quote.perImageUsd, masterLimit: 1 };
      state.status = quote.count ? 'running' : 'complete';
      if (quote.count) run.review = { ...pendingReview(input.requestId, now()), referenceLimit: 6 };
      record(run, now(), quote.count
        ? `Принято ${input.ids.length} фото. Пересоздаём только ${quote.count} невыбранных позиций за $${quote.usd.toFixed(3)}. Принятые кадры и прежние версии сохранены.`
        : `Все ${run.shots.length} позиции приняты владельцем. Фото готовы к скачиванию; правки в Canvas — по желанию.`);
    });
  }
  async function start(id: string, input: PhotoStart): Promise<ProductionRun> {
    requireGen();
    return store.update(id, (run) => {
      if (run.photos?.requests.some((r) => r.id === input.requestId)) return;
      if (run.rev !== input.rev) throw new ProductionError('CONFLICT', 'Серия изменилась. Проверь стоимость и персонажа заново.');
      readyForPhotos(run);
      if ([run.review, run.masterReview, run.appearance].some(s => s?.status === 'running')) throw new ProductionError('INVALID', 'Сначала дождись критика или поставь серию на паузу.');
      if (run.photos?.status === 'running' || run.photos?.items.some(failed)) throw new ProductionError('INVALID', 'Сначала дождись текущих задач или разбери остановленную генерацию. Повтора платных задач нет.');
      if (input.retryMaster && (!input.masterRetryConsent || !canRegenerateMaster(run))) throw new ProductionError('INVALID', 'Повтор master недоступен: нужны завершённая проверка, согласие на бюджет и не более трёх попыток в серии.');
      const quote = quotePhotos(run, { retries: input.masterRetryConsent, retryMaster: input.retryMaster });
      if (!quote.count || quote.usd !== input.confirmUsd || input.refsConsent !== true || input.reviewConsent !== true || input.masterGateConsent !== true) throw new ProductionError('INVALID', 'Стоимость или согласие не совпали. Подтверди также проверку изображений через Codex.');
      if (!run.photos) {
        run.photos = { status: 'stopped', identityId: run.character?.referenceId ?? null, masterArtifactId: null, requests: [],
          items: ['scene', ...run.shots.map((s) => s.id)].map((key) => ({ key, tag: `production:${run.id}:${input.requestId}:${key}`, jobId: null, taskId: null, status: 'pending', mediaId: null, error: null, errorCode: null })) };
      }
      if (run.photos.identityId !== (run.character?.referenceId ?? null)) throw new ProductionError('INVALID', 'Персонаж изменился после начала серии. Создай отдельную серию.');
      if (masterRejected(run) && !input.retryMaster) throw new ProductionError('INVALID', 'Master не принят. Повтори проверку без генерации или пересоздай опорный кадр в этой серии.');
      if (input.retryMaster) replaceRejectedMaster(run, input.requestId, now());
      run.photos.budget = { remainingUsd: quote.usd, perImageUsd: quote.perImageUsd, masterLimit: input.masterRetryConsent ? 3 : 1 };
      if (run.character && !appearanceReady(run)) run.appearance = pendingAppearance(run, input.requestId, now());
      if (!masterApproved(run)) run.masterReview = { ...pendingReview(input.requestId, now()), referenceLimit: 6 };
      run.photos.requests.push({ id: input.requestId, usd: quote.usd, at: new Date(now()).toISOString() });
      run.photos.status = 'running';
      run.review = { ...pendingReview(input.requestId, now()), referenceLimit: 6 };
      record(run, now(), `Подтверждено до ${quote.count} изображений, включая ${quote.reserveCount} запасных попыток master: оценка до $${quote.usd.toFixed(3)}. ${hasStoryEvents(run.scenePlan) ? 'Кадры создаются независимо; Soul ID применяется к кадрам с персонажем.' : 'Reference сцены и Soul ID передаются Higgsfield.'} Видео и upscale отключены.`);
    });
  }

  async function reconcile(id: string): Promise<void> {
    const runtime = requireGen();
    const snapshot = await store.get(id);
    if (!snapshot.photos) return;
    // Recover a link if the process stopped after the job was saved but before the series was saved.
    const jobs = await runtime.jobs.all();
    await store.update(id, async (run) => {
      if (!run.photos) return;
      let changed = false;
      for (const item of run.photos.items) {
        if (item.status === 'pending') continue;
        const job = item.jobId ? jobs.find((j) => j.id === item.jobId) : jobs.find((j) => j.tag === item.tag);
        if (!job) {
          if (sending.has(id) || ['unknown', 'failed'].includes(item.status)) continue;
          item.status = 'unknown'; item.error = 'Отправка была прервана; задача могла быть оплачена. Проверь историю Higgsfield. Автоповтора нет.'; item.errorCode = 'SUBMIT_UNKNOWN';
          run.photos.status = 'stopped'; changed = true; continue;
        }
        if (item.jobId !== job.id || item.status !== job.status || item.error !== (job.error?.messageRu ?? null)) changed = true;
        item.jobId = job.id; item.taskId = job.taskId; item.status = job.status;
        item.error = job.error?.messageRu ?? null; item.errorCode = job.error?.code ?? null;
        if (failed(item)) run.photos.status = 'stopped';
        const shot = run.shots.find((s) => s.id === item.key);
        if (shot && shot.error !== item.error) { shot.error = item.error; changed = true; }
        if (job.status !== 'saved' || item.mediaId) continue;
        const mediaId = job.mediaIds[0];
        const media = mediaId ? await runtime.library.get(mediaId) : undefined;
        if (!media || media.kind !== 'image') {
          item.status = 'failed'; item.error = 'Полученное изображение отсутствует в библиотеке.'; item.errorCode = 'MISSING_MEDIA'; run.photos.status = 'stopped'; changed = true; continue;
        }
        try { await runtime.library.readBytes(media); }
        catch { item.status = 'failed'; item.error = 'Файл фотографии недоступен на диске.'; item.errorCode = 'MISSING_MEDIA'; run.photos.status = 'stopped'; changed = true; continue; }
        item.mediaId = media.id;
        const artifact: Artifact = {
          id: `${item.key}-photo-${media.id}`, shotId: item.key, kind: 'photo', version: 1 + Math.max(0, ...run.artifacts.filter(a => a.shotId === item.key && a.kind === 'photo').map(a => a.version)),
          sourceId: item.key === 'scene' || hasStoryEvents(run.scenePlan) ? null : run.photos.masterArtifactId,
          url: `/api/library/${media.id}/file`, poster: `/api/library/${media.id}/file`, prompt: job.prompt,
          model: 'Soul 2 · Higgsfield', providerModel: job.providerModel, taskId: job.taskId ?? job.id,
          createdAt: media.savedAt, qc: 'review', qcNote: 'Файл скачан и проверен декодированием. Визуальная оценка критика показана отдельно; получение файла не подтверждает его качество.',
          note: '', cost: job.estimateUsd, mediaId: media.id, generationJobId: job.id,
        };
        run.artifacts.push(artifact);
        if (item.key === 'scene') run.photos.masterArtifactId = artifact.id;
        else if (shot) { shot.photoId = artifact.id; shot.step = 'photoQc'; shot.error = null; }
        changed = true;
      }
      if (run.photos.items.every((i) => i.status === 'saved' && i.mediaId) && run.photos.status !== 'complete' && run.photos.status !== 'review') { run.photos.status = 'review'; changed = true; }
      if (changed) record(run, now(), 'Обновлены реальные задачи фотографий. На приёмку доступны только файлы, сохранённые в библиотеке.');
    });
  }

  async function tick(id: string): Promise<void> {
    if (!gen || sending.has(id)) return;
    sending.add(id);
    try {
      await reconcile(id);
      if (stopped) return;
      let intent: { key: string; tag: string; prompt: string; masterMediaId: string | null; identityId: string | null } | undefined;
      await store.update(id, (run) => {
        const state = run.photos;
        if (run.paused || !state || state.status !== 'running' || state.items.some(failed) || !run.masterReview || !appearanceReady(run)) return;
        if (state.items.some((i) => !['pending', 'saved'].includes(i.status))) return;
        if (canRegenerateMaster(run) && state.budget?.masterLimit === 3 && masterAttempts(run) < state.budget.masterLimit && state.budget.remainingUsd >= state.budget.perImageUsd) {
          replaceRejectedMaster(run, randomUUID(), now());
          record(run, now(), `Опорный кадр не прошёл проверку. Попытка ${(state.masterHistory?.length ?? 0) + 1} из 3 в пределах подтверждённого бюджета.`);
        }
        const item = state.items.find((i) => i.status === 'pending');
        if (!item) return;
        const masterMediaId = state.items.find((i) => i.key === 'scene')?.mediaId ?? null;
        if (item.key !== 'scene' && (!masterMediaId || !masterApproved(run))) return;
        const prompts = boundPrompts(run)!;
        const first = prompts.shots[0]!.imagePrompt;
        const prompt = item.key === 'scene'
          ? prompts.masterPrompt ?? `${first} Wide establishing composition showing the entire room, the subject, wardrobe, main objects and light direction. This image establishes the location for a consistent photo series.`
          : prompts.shots.find((s) => s.shotId === item.key)!.imagePrompt;
        const price = quotePhotos(run).perImageUsd;
        if (state.budget && (state.budget.perImageUsd !== price || state.budget.remainingUsd < price)) {
          state.status = 'stopped'; record(run, now(), 'Цена изменилась или бюджет исчерпан. Подтверди новую оценку перед продолжением.'); return;
        }
        if (state.budget) state.budget.remainingUsd = Number((state.budget.remainingUsd - price).toFixed(6));
        item.status = 'submitting';
        record(run, now(), `${item.key === 'scene' ? 'Опорный кадр' : run.shots.find((s) => s.id === item.key)!.title}: отправка в Higgsfield.`);
        const independent = hasStoryEvents(run.scenePlan);
        const visibility = run.scenePlan?.shots.find(s => s.id === item.key)?.subjectVisibility;
        intent = { key: item.key, tag: item.tag, prompt, masterMediaId: independent ? null : masterMediaId,
          identityId: independent && item.key !== 'scene' && visibility !== 'person' ? null : state.identityId };
      });
      if (!intent) return;
      const sent = intent;
      try {
        const current = await store.get(id);
        if (stopped || current.paused || current.photos?.status !== 'running' || !appearanceReady(current) || (sent.key !== 'scene' && !masterApproved(current))) {
          await store.update(id, (run) => {
            const item = run.photos!.items.find((i) => i.key === sent.key)!;
            if (run.photos!.budget) run.photos!.budget.remainingUsd = Number((run.photos!.budget.remainingUsd + run.photos!.budget.perImageUsd).toFixed(6));
            item.status = 'pending'; record(run, now(), 'Отправка отложена до подтверждённого продолжения.');
          });
          return;
        }
        const unitPrice = quotePhotos(current).perImageUsd;
        const result = await gen.submit({ modelId: PHOTO_MODEL, prompt: sent.prompt,
          params: { ...photoParams(current), soulId: sent.identityId ?? '' }, count: 1, confirmCredits: unitPrice, refsConsent: true, tag: sent.tag,
          refs: sent.key === 'scene' || !sent.masterMediaId ? [] : [{ source: { type: 'media', mediaId: sent.masterMediaId }, role: 'ref', label: 'Общая сцена серии' }],
        });
        await store.update(id, (run) => {
          const item = run.photos!.items.find((i) => i.key === sent.key)!;
          item.jobId = result.jobs[0]!.id;
          record(run, now(), 'Задача Higgsfield сохранена. Ожидается результат; повторной отправки нет.');
        });
      } catch (error) {
        await store.update(id, (run) => {
          const item = run.photos!.items.find((i) => i.key === sent.key)!;
          // SubmitError is a preflight rejection. Other errors may happen after a paid submit.
          item.status = error instanceof SubmitError ? 'failed' : 'unknown';
          item.error = error instanceof SubmitError ? error.messageRu : 'Исход отправки неизвестен. Проверь историю Higgsfield; задача автоматически не повторяется.';
          item.errorCode = error instanceof SubmitError ? error.code : 'SUBMIT_UNKNOWN';
          run.photos!.status = 'stopped';
          record(run, now(), item.error);
        });
      }
      await reconcile(id);
    } finally { sending.delete(id); }
  }
  return {
    start, tick, continueSelection,
    selectionQuote: async (id: string, ids: string[]) => quotePhotoSelection(await store.get(id), ids),
    quote: async (id: string, retryMaster = false) => {
      const run = await store.get(id); readyForPhotos(run);
      if (retryMaster && !canRegenerateMaster(run)) throw new ProductionError('INVALID', 'Новый master недоступен: лимит три попытки, до запуска остальных кадров.');
      return quotePhotos(run, { retries: true, retryMaster });
    },
    retry: async (id: string, jobId: string) => {
      const run = await store.get(id);
      if (!run.photos?.items.some((i) => i.jobId === jobId)) throw new ProductionError('INVALID', 'Задача не относится к этой серии.');
      await requireGen().retry(jobId); await reconcile(id); return store.get(id);
    },
    recover: async (id: string) => {
      await store.update(id, (run) => {
        if (run.photos?.status === 'running') { run.photos.status = 'stopped'; record(run, now(), 'Сервер перезапущен: известные задачи проверяются, оставшиеся изображения требуют нового подтверждения стоимости.'); }
      });
      await reconcile(id);
    },
    stop: () => { stopped = true; },
  };
}
