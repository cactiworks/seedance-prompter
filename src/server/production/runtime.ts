import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { advanceRun, applyRunAction, completePreparation, newRun, ProductionError, record } from '../../core/production/engine.ts';
import type { ProductionRun, RunAction, RunInput } from '../../core/production/model.ts';
import { StoredRunSchema } from '../../core/production/persistence.ts';
import type { CharacterSelection } from '../../core/production/character.ts';
import { DEFAULT_LLM_MODEL, runCodex } from '../llm/codexCli/provider.ts';
import type { Runner } from '../llm/tasks/write.ts';
import type { GenRuntime } from '../gen/runtime.ts';
import { createPhotoProduction } from './photos.ts';
import { createPhotoReview } from './review.ts';
import { agentError, directScene, writePrompts, type AgentOptions } from './agents.ts';

const ID = /^pr-[a-z0-9-]{6,70}$/;
/** Durable series with explicit, cost-confirmed photo dispatch. Legacy demo runs stay mock. */
export function createProductionRuntime(options: { dataDir: string; now?: () => number; delayMs?: number; runLlm?: Runner; model?: string; gen?: GenRuntime }) {
  const dir = path.join(options.dataDir, 'production-mock');
  const now = options.now ?? Date.now;
  const delay = options.delayMs ?? 1300;
  let tail: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  const damaged = new Map<string, string>();
  const pending = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn); tail = result.catch(() => undefined); return result;
  };
  async function read(id: string): Promise<ProductionRun> {
    if (!ID.test(id)) throw new ProductionError('NOT_FOUND', 'Серия не найдена.');
    try {
      const run = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8')) as ProductionRun;
      if (run?.id !== id || !StoredRunSchema.safeParse(run).success) throw new Error('Неверный файл mock-серии.');
      return run;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ProductionError('NOT_FOUND', 'Серия не найдена.');
      throw new ProductionError('INVALID', 'Файл серии повреждён. Другие серии доступны; исходный файл сохранён для восстановления.');
    }
  }
  async function write(run: ProductionRun): Promise<ProductionRun> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${run.id}.json`);
    const tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(run), { mode: 0o600 });
    await rename(tmp, file);
    return run;
  }
  async function list(): Promise<ProductionRun[]> {
    await mkdir(dir, { recursive: true });
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && ID.test(f.slice(0, -5)));
    const runs: ProductionRun[] = [];
    damaged.clear();
    for (const file of files) {
      try { runs.push(await read(file.slice(0, -5))); }
      catch { damaged.set(file, 'Повреждённая серия пропущена; файл сохранён для восстановления.'); }
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const photoStore = { get: read, update: (id: string, change: (run: ProductionRun) => Promise<void> | void) => exclusive(async () => {
    const run = await read(id); const rev = run.rev;
    await change(run); return run.rev === rev ? run : write(run);
  }) };
  const photos = createPhotoProduction(photoStore, options.gen, now);
  const review = createPhotoReview(photoStore, { dataDir: options.dataDir, gen: options.gen, runLlm: options.runLlm, now });
  async function tick(): Promise<void> {
    await exclusive(async () => {
      for (const run of await list()) {
        const next = advanceRun(run, now(), delay);
        if (next !== run) await write(next);
      }
    });
    for (const run of await list()) if (run.mode === 'photos' && run.photos) { await photos.tick(run.id); await review.tick(run.id); }
  }
  async function updatePreparation(id: string, attempt: number, change: (run: ProductionRun) => ProductionRun | void, includeStopped = false): Promise<void> {
    await exclusive(async () => {
      const run = await read(id);
      if (run.preparation?.attempt !== attempt || (!includeStopped && (run.preparation.status !== 'running' || run.paused))) return;
      await write(change(run) ?? run);
    });
  }
  function launchPreparation(id: string, attempt: number): void {
    if (pending.has(id)) return;
    const controller = new AbortController();
    const job = { controller, done: Promise.resolve() };
    pending.set(id, job);
    job.done = (async () => {
      const agentOptions: AgentOptions = {
        run: options.runLlm ?? runCodex,
        model: options.model ?? process.env.SP_PRODUCTION_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL,
        signal: controller.signal,
        onCall: (call) => updatePreparation(id, attempt, (run) => {
          run.preparation!.calls.push(call);
          record(run, now(), `${call.stage === 'scene' ? 'Режиссёр' : 'Агент prompts'}: ${call.status === 'accepted' ? 'ответ принят' : call.status === 'rejected' ? 'ответ требует исправления' : 'вызов не завершён'}.`);
        }, true),
      };
      try {
        let run = await read(id);
        if (!run.scenePlan) {
          const scene = await directScene(run, agentOptions);
          await updatePreparation(id, attempt, (current) => {
            current.scenePlan = scene; current.preparation!.stage = 'prompts';
            record(current, now(), 'Паспорт сцены и shot plan сохранены. Codex готовит prompts.');
          });
        }
        run = await read(id);
        if (controller.signal.aborted || run.paused || run.preparation?.status !== 'running' || run.preparation.attempt !== attempt || !run.scenePlan) return;
        const prompts = await writePrompts(run.scenePlan, run.style, agentOptions);
        await updatePreparation(id, attempt, (current) => {
          current.promptPlan = prompts;
          return completePreparation(current, now(), delay);
        });
      } catch (error) {
        await updatePreparation(id, attempt, (run) => {
          run.preparation!.status = controller.signal.aborted ? 'interrupted' : 'failed';
          run.preparation!.error = agentError(error);
          record(run, now(), 'Подготовка Codex остановлена. Сохранённые результаты доступны; автоматического повтора нет.');
        });
      }
    })().catch((error: unknown) => console.error('Production preparation storage:', error)).finally(() => {
      if (pending.get(id) === job) pending.delete(id);
    });
  }
  return {
    get: read, list, tick, photos, review,
    forkPhotos: (id: string, rev: number, requestId: string): Promise<ProductionRun> => exclusive(async () => {
      const existing = (await list()).find((r) => r.requestId === requestId);
      if (existing) {
        if (existing.planSourceId !== id) throw new ProductionError('CONFLICT', 'Этот запрос уже использован для другой серии.');
        return existing;
      }
      const source = await read(id);
      if (source.rev !== rev) throw new ProductionError('CONFLICT', 'Серия изменилась. Повтори создание серии фото.');
      if (!source.planned || !source.scenePlan || !source.promptPlan || !source.preparation) throw new ProductionError('INVALID', 'Нужен завершённый план Codex.');
      const fresh = newRun(`pr-${now().toString(36)}-${randomBytes(4).toString('hex')}`, { mode: 'photos', requestId, planningMode: 'codex', title: source.title, script: source.script, direction: source.direction, style: source.style, scenario: 'normal', characterId: source.characterId }, now(), delay);
      fresh.character = source.character; fresh.scenePlan = source.scenePlan; fresh.promptPlan = source.promptPlan; fresh.planSourceId = id;
      fresh.preparation = { ...source.preparation, calls: [] };
      fresh.events = [{ at: fresh.createdAt, message: 'Создана отдельная серия по сохранённому Codex-плану. Новых вызовов LLM не было; mock-файлы и приёмки не перенесены.' }];
      return write(completePreparation(fresh, now(), delay));
    }),
    issues: () => [...damaged].map(([file, message]) => `${file}: ${message}`),
    waitForPreparation: async (id: string): Promise<void> => { await pending.get(id)?.done; },
    create: async (input: RunInput, character: CharacterSelection | null = null): Promise<ProductionRun> => {
      if ((input.characterId ?? null) !== (character?.id ?? null)) throw new ProductionError('INVALID', 'Персонаж серии не проверен.');
      if (input.mode === 'photos' && input.planningMode !== 'codex') throw new ProductionError('INVALID', 'Для реальных фото нужен план Codex.');
      let created = false;
      const run = await exclusive(async () => {
        if (input.requestId) {
          const existing = (await list()).find((r) => r.requestId === input.requestId);
          if (existing) {
            const keys = ['title', 'script', 'direction', 'style', 'scenario', 'planningMode', 'characterId', 'mode'] as const;
            if (keys.some((key) => (existing[key] ?? null) !== (input[key] ?? null))) throw new ProductionError('CONFLICT', 'Этот запрос уже сохранён с другим содержимым. Открой существующую серию.');
            return existing;
          }
        }
        const saved = await write({ ...newRun(`pr-${now().toString(36)}-${randomBytes(4).toString('hex')}`, input, now(), delay), character });
        created = true;
        return saved;
      });
      if (created && run.preparation) launchPreparation(run.id, run.preparation.attempt);
      return run;
    },
    setCharacter: (id: string, rev: number, character: CharacterSelection | null): Promise<ProductionRun> => exclusive(async () => {
      const run = await read(id);
      if (run.rev !== rev) throw new ProductionError('CONFLICT', 'Серия изменилась. Повтори выбор персонажа.');
      if (run.photos) throw new ProductionError('INVALID', 'Персонаж зафиксирован для начатой генерации. Создай новую серию по этому плану.');
      run.character = character; run.characterId = character?.id ?? null;
      record(run, now(), run.mode === 'photos' ? (character ? `Выбран персонаж «${character.name}» для генерации фото.` : 'Серия будет без Soul ID.') : character ? `Выбран персонаж «${character.name}». Mock-кадры не меняются; сходство лица не проверялось.` : 'Персонаж отвязан от серии. Mock-кадры не меняются.');
      return write(run);
    }),
    act: async (id: string, action: RunAction): Promise<ProductionRun> => {
      const run = await exclusive(async () => {
        const source = await read(id);
        if (action.type === 'retryPreparation') {
          if (source.rev !== action.rev) throw new ProductionError('CONFLICT', 'Серия изменилась. Обнови данные перед повтором.');
          if (!source.preparation || source.planned || source.paused || source.preparation.status === 'running' || pending.has(id)) throw new ProductionError('INVALID', 'Повтор подготовки сейчас недоступен.');
          source.preparation = { ...source.preparation, status: 'running', attempt: source.preparation.attempt + 1, error: null, startedAt: new Date(now()).toISOString() };
          record(source, now(), 'Подготовка Codex повторена по запросу владельца.');
          return write(source);
        }
        const next = applyRunAction(source, action, now(), delay);
        if (action.type === 'pause' && next.preparation?.status === 'running') {
          next.preparation.status = 'interrupted';
          next.preparation.error = 'Вызов Codex прерван паузой. После продолжения можно повторить незавершённый этап; это расходует квоту.';
        }
        if (action.type === 'pause' && next.review && ['pending', 'running'].includes(next.review.status)) {
          next.review.status = 'interrupted'; next.review.error = 'Проверка остановлена паузой. Повтори её явно после продолжения.';
        }
        return write(next);
      });
      if (action.type === 'pause') { pending.get(id)?.controller.abort(); review.cancel(id); }
      if (action.type === 'retryPreparation') launchPreparation(id, run.preparation!.attempt);
      return run;
    },
    async start(): Promise<void> {
      if (timer) return;
      // Never relaunch a quota-consuming invocation after a process restart.
      await exclusive(async () => {
        for (const run of await list()) if (run.preparation?.status === 'running' && !pending.has(run.id)) {
          run.preparation.status = 'interrupted';
          run.preparation.error = 'Сервер был перезапущен во время подготовки. Сохранённая сцена доступна; повтори незавершённый этап вручную.';
          record(run, now(), 'Подготовка прервана перезапуском. Codex автоматически не вызывается.');
          await write(run);
        }
      });
      for (const run of await list()) if (run.mode === 'photos') { await review.recover(run.id); if (run.photos && options.gen) await photos.recover(run.id); }
      timer = setInterval(() => {
        if (ticking) return;
        ticking = true;
        void tick().catch((error: unknown) => console.error('Production:', error)).finally(() => { ticking = false; });
      }, 450);
      timer.unref();
    },
    stop(): void { photos.stop(); review.stop(); if (timer) clearInterval(timer); timer = undefined; for (const job of pending.values()) job.controller.abort(); },
  };
}
export type ProductionRuntime = ReturnType<typeof createProductionRuntime>;
