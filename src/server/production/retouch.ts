import { z } from 'zod';
import { GeneratedRetouchAuditSchema, auditPassed, repairable, quoteRetouch, retouchPrice, retouchPrompt, validateRetouchAudit, MAX_RETOUCH_ATTEMPTS, RETOUCH_MODEL, retouchParams, type RetouchStart, type RetouchItem } from '../../core/production/retouch.ts';
import { currentArtifact, type ProductionRun } from '../../core/production/model.ts';
import { ProductionError, record } from '../../core/production/engine.ts';
import { appearanceReady } from '../../core/production/appearance.ts';
import { reviewedPhoto } from '../../core/production/review.ts';
import { sceneForShot } from '../../core/production/plan.ts';
import { PHOTO_CRITIC_SYSTEM } from './review.ts';
import { identityImages } from './appearance.ts';
import { retainOutsideRegions } from './regional.ts';
import { visionCopy } from './vision.ts';
import { DEFAULT_LLM_MODEL, runCodex } from '../llm/codexCli/provider.ts';
import type { Runner } from '../llm/tasks/write.ts';
import { SubmitError, type GenRuntime } from '../gen/runtime.ts';

export const RETOUCH_SYSTEM = `${PHOTO_CRITIC_SYSTEM}
Проверяй выбранный style по исходному заданию. Смена манеры UGC на cinema требует света/композиции всего кадра: это visualInterest=fail, fixes=[]; локальная ретушь не должна выдавать такой кадр за подходящий или перекрашивать его целиком.
В этой задаче действуют следующие уточнения формата и этапа: владелец выбрал кадр по замыслу на milestone, теперь ты проверяешь детали перед выдачей. Ответ — объект {result, preserved, fixes} по схеме вместо отчёта серии. result содержит один artifactId текущего candidate. Вход содержит original (кадр, выбранный владельцем), current (проверяемая версия), identity и при наличии другие кадры серии для контекста; imageMap определяет роли. original НЕ эталон отсутствия дефектов. Ни original, ни другие кадры не доказывают правильность внешности.
Для shotMatch и творческого акцента visualInterest эталон — замысел original, уже выбранный владельцем: не отклоняй его повторно за расхождение с прежним prompt. При этом соответствие выбранному style проверяй по исходному заданию; выбор original не отменяет Cinematic. Сохраняй выбранные локацию, одежду и событие; continuity оценивай по сохранности обстановки выбранного кадра. Локальные дефекты внешности относятся только к face/likeness/character, рук — к hands, фоновых лиц — к identityLeakage, надписей — к text, неполной/неуместной одежды — к wardrobe, опоры и пространственной логики — к sceneLogic; не дублируй их как continuity/shotMatch/visualInterest=fail, иначе система не сможет отправить локальную правку.
Выбор кадра владельцем не подтверждает отсутствие логических ошибок: отсутствующий низ одежды, случайное обнажение и невозможные контакты остаются дефектами. Сохранить одежду означает сохранить её стиль и нормальные части, а не зафиксировать пропущенную вещь. Локально восстанови недостающий низ из scene.wardrobe; если старый паспорт неполон, выбери простой закрывающий эту область низ в согласованной палитре, без изменения позы/телосложения и деталей вне box. Для уверенного дефекта одежды укажи wardrobe fix; sceneLogic fix допустим для локального контакта/опоры без смены действия или композиции. Если исправление требует большей области или неоднозначного переустройства сцены — fixes=[], объясни ограничение.
Проверь все критерии, особенно новую бороду/усы относительно identity, кисти/контакт/физику, чужих людей/плакаты с лицом героя и текст. preserved=pass означает, что замысел, композиция, внешность героя и неизменяемые детали вне заданных previousFixes сохранились относительно original. Для первой версии без правок preserved=pass. Новые дефекты внутри/вне правок всё равно указывай в result. Нежелательный сдвиг композиции или внешности после правки → preserved=fail, он не принимается.
Для каждого уверенно видимого локального fail предложи fixes: check, точный box в координатах 0…999 от левого верхнего угла CURRENT, reason по-русски и instructionEn для Seedream. Коррекция локальна: каждый box охватывает только дефект и небольшой контекст, максимум 30% площади. Не обводи весь кадр. Для руки включи нужный сустав/контакт, для бороды — нижнюю часть лица, для чужого лица — только соответствующее лицо на плакате/прохожем. Каждой области — своя инструкция; нельзя менять лицо героя при исправлении лица на плакате. Основной персонаж сохраняет внешность identity; остальные получают естественные отдельные лица с сохранением их возраста, визуальной подачи, позы и одежды. Не устанавливай личности людей.
Текст: точную замену бери только из явно заданной в scenario/direction/shot надписи или однозначно читаемого original. Если несущественный декоративный текст испорчен и точная фраза неизвестна, убери его в пределах области, сохранив материал/дизайн носителя. Не придумывай лозунг. Если неизвестный текст важен для события, fixes=[] и краткая причина, что нужно уточнить текст.
fixes исправляют только fail для character/face/likeness/hands/identityLeakage/text/wardrobe/sceneLogic. Неверное событие, локация, глобальная композиция или неопределённость не лечатся перерисовкой всего кадра: fixes=[], объясни причину. При pass/variation ничего не ретушируй. Если локальная правка исправляет сразу likeness и character, обозначь обе проверки отдельными fixes с одной областью. instructionEn описывает только требуемое изменение, без Image N, bbox-тегов, ссылок, глобальных указаний и текста вне области. Никаких собственных вызовов инструментов. Система отдельно применяет лимит попыток и стоимости; ты не обещаешь успешное исправление.`;

interface Store { get(id: string): Promise<ProductionRun>; update(id: string, fn: (run: ProductionRun) => Promise<void> | void): Promise<ProductionRun> }
const inFlight = (status: string) => ['submitting', 'queued', 'running', 'downloading'].includes(status);
export function createRetouch(store: Store, options: { dataDir: string; gen?: GenRuntime; runLlm?: Runner; runLlmForAccount?: (id?: string) => Runner; now: () => number }) {
  const pending = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const sending = new Set<string>();
  const ticking = new Set<string>();
  let stopped = false;
  const now = options.now;
  const gen = () => { if (!options.gen) throw new ProductionError('INVALID', 'Генератор не подключён.'); return options.gen; };
  function eligible(run: ProductionRun, ids: string[]) {
    if (run.mode !== 'photos' || run.paused || !run.photos || run.photos.status === 'running' || !appearanceReady(run)) throw new ProductionError('INVALID', 'Сначала заверши генерацию фотографий и сними паузу.');
    if ([run.review, run.masterReview].some(s => s?.status === 'running' || s?.status === 'pending') || run.photos.items.some(i => inFlight(i.status))) throw new ProductionError('INVALID', 'Дождись проверки и текущих задач.');
    if (!ids.length || new Set(ids).size !== ids.length) throw new ProductionError('INVALID', 'Выбери текущие фотографии.');
    for (const id of ids) {
      const shot = run.shots.find(s => s.photoId === id);
      const item = run.retouch?.items.find(i => i.shotId === shot?.id);
      if (!shot || !currentArtifact(run, id)?.mediaId || !['photoReview', 'ready'].includes(shot.step) || (!item && !reviewedPhoto(run, id))) throw new ProductionError('INVALID', 'На milestone доступны только текущие проверенные кадры.');
      if (item?.status === 'complete') throw new ProductionError('INVALID', 'Этот кадр уже исправлен и проверен.');
      if (item?.attempts.some(a => !a.artifactId && a.status !== 'cancelled' && !(a.status === 'failed' && a.errorCode !== 'POLL_TIMEOUT'))) throw new ProductionError('INVALID', 'Сначала разбери незавершённую задачу. Неизвестная отправка не повторяется.');
    }
  }
  async function start(id: string, input: RetouchStart, codexAccountId?: string) {
    gen();
    return store.update(id, run => {
      if (run.retouch?.requests.includes(input.requestId)) return;
      if (run.rev !== input.rev) throw new ProductionError('CONFLICT', 'Серия изменилась. Обнови оценку автоправок.');
      if (pending.has(id) || sending.has(id) || run.retouch?.status === 'running') throw new ProductionError('INVALID', 'Автоправки уже идут.');
      eligible(run, input.ids);
      const quote = quoteRetouch(run, input.ids);
      if (input.consent !== true || input.confirmUsd !== quote.usd) throw new ProductionError('INVALID', 'Подтверди точную стоимость автоправок и передачу изображений.');
      if (!run.retouch) run.retouch = { status: 'stopped', requestId: input.requestId, requests: [], selected: [], items: [], uploadIds: run.character ? run.appearance!.uploadIds.slice(0, 2) : [], appearanceRequestId: run.character ? run.appearance!.requestId : null, remainingUsd: 0, perEditUsd: quote.perEditUsd };
      const state = run.retouch;
      state.selected = [];
      for (const artifactId of input.ids) {
        const shot = run.shots.find(s => s.photoId === artifactId)!;
        let item = state.items.find(i => i.shotId === shot.id);
        if (!item) { item = { shotId: shot.id, originalId: artifactId, currentId: artifactId, status: 'pending', error: null, audit: null, history: [], attempts: [] }; state.items.push(item); }
        item.status = 'pending'; item.error = null;
        state.selected.push(shot.id);
        shot.acceptedPhotoId = null; shot.step = 'photoReview'; shot.error = null;
        run.approvals.push({ kind: 'photo', artifactId, at: new Date(now()).toISOString() });
      }
      state.codexAccountId = codexAccountId;
      state.status = 'running'; state.requestId = input.requestId; state.requests.push(input.requestId); state.remainingUsd = quote.usd; state.perEditUsd = quote.perEditUsd;
      run.photos!.status = 'review';
      record(run, now(), `Milestone: выбрано ${input.ids.length} кадров. Автоправки Seedream — до ${quote.count}, бюджет до $${quote.usd.toFixed(3)}. До ${quote.checks} проверок Codex; выдача только после проверки деталей.`);
    });
  }
  function finish(run: ProductionRun) {
    const state = run.retouch!;
    if (state.selected.every(key => state.items.some(i => i.shotId === key && ['complete', 'blocked'].includes(i.status)))) state.status = state.selected.some(key => state.items.some(i => i.shotId === key && i.status === 'blocked')) ? 'stopped' : 'complete';
    run.photos!.status = run.shots.every(s => s.step === 'ready' && s.acceptedPhotoId === s.photoId) ? 'complete' : 'review';
  }
  async function audit(id: string, item: RetouchItem) {
    const controller = new AbortController();
    const task = { controller, done: Promise.resolve() }; pending.set(id, task);
    task.done = (async () => {
      let requestId = '';
      try {
        const run = await store.update(id, current => {
          const target = current.retouch?.items.find(i => i.shotId === item.shotId);
          if (current.paused || current.retouch?.status !== 'running' || target?.status !== 'pending') return;
          target.status = 'checking'; requestId = current.retouch.requestId; record(current, now(), 'Проверяем детали выбранного кадра.');
        });
        if (!requestId) return;
        const images = []; const imageMap = [];
        const refs = run.character ? await identityImages(options.dataDir, run, run.appearance!.uploadIds) : { images: [] };
        for (const image of refs.images) { images.push(image); imageMap.push({ imageIndex: images.length, role: 'identity' }); }
        const imageIds = [...new Set([item.originalId, item.currentId, ...run.shots.map(s => s.photoId).filter((v): v is string => !!v)])];
        for (const artifactId of imageIds) {
          const artifact = currentArtifact(run, artifactId)!; const media = await gen().library.get(artifact.mediaId!);
          if (!media || media.kind !== 'image') throw new Error('Файл не найден');
          images.push(await visionCopy(await gen().library.readBytes(media)));
          imageMap.push({ imageIndex: images.length, artifactId, role: artifactId === item.currentId ? 'current' : artifactId === item.originalId ? 'original' : 'context', original: artifactId === item.originalId });
        }
        const shot = run.scenePlan!.shots.find(s => s.id === item.shotId)!;
        const reply = await (options.runLlmForAccount?.(run.retouch?.codexAccountId) ?? options.runLlm ?? runCodex)<unknown>({ system: RETOUCH_SYSTEM, user: JSON.stringify({ inspectionMode: 'logic-audit-v5', scope: 'series', style: run.style, contentMode: run.contentMode ?? 'story', scenePlan: { contentMode: run.scenePlan?.contentMode ?? 'story' }, candidate: { artifactId: item.currentId, shot }, originalId: item.originalId, imageMap, identityRequired: !!run.character, appearance: run.appearance?.output?.profile ?? null, scene: sceneForShot(run.scenePlan!, shot), scenario: run.script, direction: run.direction, previousFixes: item.history.flatMap(h => h.audit.fixes), identityAvailable: refs.images.length > 0 }), images, jsonSchema: z.toJSONSchema(GeneratedRetouchAuditSchema), model: process.env.SP_PRODUCTION_CRITIC_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL, effort: 'medium', timeoutMs: 240_000, signal: controller.signal, taskRu: 'Автоправки деталей Production' });
        const result = validateRetouchAudit(GeneratedRetouchAuditSchema.parse(reply.data), item.currentId, refs.images.length, !!run.character);
        await store.update(id, current => {
          const state = current.retouch!; const target = state.items.find(i => i.shotId === item.shotId)!;
          if (controller.signal.aborted || current.paused || state.status !== 'running' || state.requestId !== requestId || target.status !== 'checking' || target.currentId !== item.currentId) return;
          if (state.appearanceRequestId !== (current.character ? current.appearance?.requestId : null)) throw new Error('Внешность изменилась');
          target.audit = result; target.history.push({ artifactId: item.currentId, audit: result });
          const shot = current.shots.find(s => s.id === item.shotId)!;
          if (auditPassed(result)) {
            target.status = 'complete'; target.error = null; shot.photoId = target.currentId; shot.acceptedPhotoId = target.currentId; shot.step = 'ready'; shot.error = null;
            const a = currentArtifact(current, target.currentId)!; a.qc = 'pass'; a.qcNote = 'Выбран владельцем по замыслу; детали и сохранность композиции проверены после milestone.';
          } else if (repairable(result) && target.attempts.length < MAX_RETOUCH_ATTEMPTS) target.status = 'planned';
          else { target.status = 'blocked'; target.error = result.preserved !== 'pass' ? 'Правка изменила удачный кадр. Исходник сохранён.' : target.attempts.length >= MAX_RETOUCH_ATTEMPTS ? 'Три попытки исчерпаны. Кадр требует решения.' : result.result.reason; shot.error = target.error; }
          finish(current); record(current, now(), target.status === 'complete' ? `${shot.title}: детали проверены, кадр готов.` : `${shot.title}: ${target.error ?? 'найдены локальные дефекты, готовим правку.'}`);
        });
      } catch {
        await store.update(id, run => {
          const item = run.retouch?.items.find(i => i.status === 'checking');
          if (!item) return;
          item.status = 'blocked'; item.error = 'Проверка деталей не завершилась. Повтори проверку сохранённого кадра.';
          finish(run); record(run, now(), item.error);
        });
      }
    })().catch(error => console.error('Production retouch audit storage:', error)).finally(() => pending.delete(id));
  }
  async function reconcile(id: string) {
    const jobs = await gen().jobs.all();
    await store.update(id, async run => {
      const state = run.retouch; if (!state) return;
      let changed = false;
      for (const item of state.items) {
        const attempt = item.attempts.at(-1);
        if (!attempt || attempt.artifactId || ['cancelled', 'processing_failed'].includes(attempt.status)) continue;
        const job = jobs.find(j => attempt.jobId ? j.id === attempt.jobId : j.tag === attempt.tag);
        if (!job) {
          if (sending.has(id) || ['unknown', 'failed'].includes(attempt.status)) continue;
          attempt.status = 'unknown'; item.status = 'blocked'; item.error = 'Исход отправки неизвестен. Проверь историю KIE; автоматического повтора нет.'; changed = true; continue;
        }
        if (attempt.status === job.status && ['failed', 'download_failed'].includes(job.status)) continue;
        if (attempt.status !== job.status || attempt.jobId !== job.id) changed = true;
        attempt.status = job.status; attempt.jobId = job.id; attempt.errorCode = job.error?.code ?? null;
        if (inFlight(job.status)) { if (item.status !== 'generating') changed = true; item.status = 'generating'; continue; }
        if (job.status !== 'saved') { item.status = 'blocked'; item.error = job.error?.messageRu ?? 'Правка остановилась. Проверь задачу KIE.'; continue; }
        let media = job.mediaIds[0] ? await gen().library.get(job.mediaIds[0]) : undefined;
        if (!media || media.kind !== 'image') { attempt.status = 'processing_failed'; item.status = 'blocked'; item.error = 'Файл правки пока недоступен.'; changed = true; continue; }
        const source = currentArtifact(run, attempt.sourceId)!;
        const sourceMedia = await gen().library.get(source.mediaId!);
        if (!sourceMedia || !item.audit?.fixes.length) { item.status = 'blocked'; item.error = 'Исходник или области правки недоступны.'; changed = true; continue; }
        try { media = await retainOutsideRegions(gen(), sourceMedia, media, item.audit.fixes.map(f => f.box)); }
        catch { attempt.status = 'processing_failed'; item.status = 'blocked'; item.error = 'Не удалось сохранить области правки. Исходник сохранён.'; changed = true; continue; }
        const artifactId = `${item.shotId}-retouch-${media.id}`;
        run.artifacts.push({ ...source, id: artifactId, sourceId: source.id, version: source.version + 1, url: `/api/library/${media.id}/file`, poster: `/api/library/${media.id}/file`, mediaId: media.id, generationJobId: job.id, model: 'Seedream 5 Pro · KIE', providerModel: job.providerModel, taskId: job.taskId ?? job.id, prompt: job.prompt, createdAt: media.savedAt, cost: job.estimateUsd, qc: 'review', qcNote: 'Локальная правка ожидает повторной проверки.', note: item.audit?.result.reason ?? '' });
        attempt.artifactId = artifactId; item.currentId = artifactId; item.status = 'pending'; item.audit = null; item.error = null;
        run.shots.find(s => s.id === item.shotId)!.photoId = artifactId;
        changed = true;
      }
      if (changed) { if (state.status === 'running') finish(run); record(run, now(), 'Обновлены задачи локальной правки. Новые версии ждут проверки.'); }
    });
  }
  async function tickWork(id: string) {
    if (!options.gen || sending.has(id) || pending.has(id)) return;
    await reconcile(id);
    const run = await store.get(id);
    if (stopped || run.paused || run.retouch?.status !== 'running') return;
    const item = run.retouch.items.find(i => run.retouch!.selected.includes(i.shotId) && ['pending', 'planned'].includes(i.status));
    if (!item || run.retouch.items.some(i => i.status === 'generating')) return;
    if (item.status === 'pending') { await audit(id, item); return; }
    sending.add(id);
    let tag = '';
    try {
      const intent = await store.update(id, current => {
        const state = current.retouch!; const target = state.items.find(i => i.shotId === item.shotId)!;
        if (current.paused || state.status !== 'running' || target.status !== 'planned' || !target.audit || !repairable(target.audit)) return;
        const price = retouchPrice(1 + state.uploadIds.length, current);
        if (state.perEditUsd !== price.usd || state.remainingUsd < price.usd || target.attempts.length >= MAX_RETOUCH_ATTEMPTS) {
          target.status = 'blocked'; target.error = 'Лимит правок или стоимость изменились. Нужна новая оценка.'; finish(current); record(current, now(), target.error); return;
        }
        tag = `retouch:${id}:${item.shotId}:${target.attempts.length + 1}`;
        target.attempts.push({ tag, sourceId: target.currentId, jobId: null, artifactId: null, prompt: retouchPrompt(target.audit), status: 'submitting' });
        state.remainingUsd = Number((state.remainingUsd - price.usd).toFixed(6)); target.status = 'generating';
        record(current, now(), `${current.shots.find(s => s.id === item.shotId)!.title}: локальная правка ${target.attempts.length} из ${MAX_RETOUCH_ATTEMPTS}.`);
      });
      if (!tag) return;
      const attempt = intent.retouch!.items.find(i => i.shotId === item.shotId)!.attempts.at(-1)!;
      const current = await store.get(id);
      if (stopped || current.paused || current.retouch?.status !== 'running') {
        await store.update(id, r => { const a = r.retouch!.items.find(i => i.shotId === item.shotId)!.attempts.at(-1)!; a.status = 'cancelled'; r.retouch!.remainingUsd += r.retouch!.perEditUsd; record(r, now(), 'Отправка правки отменена до вызова провайдера.'); }); return;
      }
      const result = await gen().submit({ modelId: RETOUCH_MODEL, params: retouchParams(current), prompt: attempt.prompt, count: 1, refsConsent: true, confirmCredits: retouchPrice(1 + current.retouch.uploadIds.length, current).credits, tag,
        refs: [{ source: { type: 'media', mediaId: currentArtifact(current, attempt.sourceId)!.mediaId! }, role: 'ref', label: 'Редактируемый кадр' }, ...current.retouch.uploadIds.map(uploadId => ({ source: { type: 'upload' as const, uploadId }, role: 'ref' as const, label: 'Только внешность главного героя' }))] });
      await store.update(id, run => { run.retouch!.items.find(i => i.shotId === item.shotId)!.attempts.at(-1)!.jobId = result.jobs[0]!.id; record(run, now(), 'Задача Seedream сохранена.'); });
    } catch (error) {
      if (tag) await store.update(id, run => { const item = run.retouch!.items.find(i => i.attempts.some(a => a.tag === tag))!; item.attempts.at(-1)!.status = error instanceof SubmitError ? 'failed' : 'unknown'; item.status = 'blocked'; item.error = error instanceof SubmitError ? error.messageRu : 'Исход отправки неизвестен. Проверь историю KIE; автоповтора нет.'; finish(run); record(run, now(), item.error); });
    } finally { sending.delete(id); }
  }
  async function tick(id: string) {
    if (ticking.has(id)) return; ticking.add(id);
    try { await tickWork(id); } finally { ticking.delete(id); }
  }
  return { start, tick,
    quote: async (id: string, ids: string[]) => { const run = await store.get(id); eligible(run, ids); return quoteRetouch(run, ids); },
    wait: async (id: string) => { await pending.get(id)?.done; },
    cancel: (id: string) => pending.get(id)?.controller.abort(),
    retry: async (id: string, jobId: string) => { const run = await store.get(id); if (!run.retouch?.items.some(i => i.attempts.some(a => a.jobId === jobId))) throw new ProductionError('INVALID', 'Задача не относится к автоправкам этой серии.'); const attempt = run.retouch.items.flatMap(i => i.attempts).find(a => a.jobId === jobId)!;
      if (attempt.status === 'processing_failed') await store.update(id, r => { r.retouch!.items.flatMap(i => i.attempts).find(a => a.jobId === jobId)!.status = 'saved'; record(r, now(), 'Повторяем локальное сохранение областей без генерации.'); });
      else await gen().retry(jobId);
      await reconcile(id); return store.get(id); },
    recover: async (id: string) => { await store.update(id, run => { if (!run.retouch || run.retouch.status !== 'running') return; run.retouch.status = 'stopped'; for (const item of run.retouch.items) if (item.status === 'checking') { item.status = 'pending'; item.error = 'Проверка прервана перезапуском.'; } record(run, now(), 'Автоправки остановлены перезапуском. Известные задачи сохранятся; продолжение — по кнопке.'); }); if (options.gen) await reconcile(id); },
    stop: () => { stopped = true; for (const task of pending.values()) task.controller.abort(); },
  };
}
