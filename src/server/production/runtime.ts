import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { advanceRun, applyRunAction, completePreparation, newRun, ProductionError, record } from '../../core/production/engine.ts';
import type { ProductionRun, RunAction, RunInput } from '../../core/production/model.ts';
import type { CharacterSelection } from '../../core/production/character.ts';
import { DEFAULT_LLM_MODEL, runCodex } from '../llm/codexCli/provider.ts';
import type { Runner } from '../llm/tasks/write.ts';
import { agentError, directScene, writePrompts, type AgentOptions } from './agents.ts';

const ID = /^pr-[a-z0-9-]{6,70}$/;
/** Codex prepares text; media stays mock. No media provider or credentials are accepted. */
export function createProductionRuntime(options: { dataDir: string; now?: () => number; delayMs?: number; runLlm?: Runner; model?: string }) {
  const dir = path.join(options.dataDir, 'production-mock');
  const now = options.now ?? Date.now;
  const delay = options.delayMs ?? 1300;
  let tail: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  const pending = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn); tail = result.catch(() => undefined); return result;
  };
  async function read(id: string): Promise<ProductionRun> {
    if (!ID.test(id)) throw new ProductionError('NOT_FOUND', 'Серия не найдена.');
    try {
      const run = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8')) as ProductionRun;
      if (run.id !== id || run.mode !== 'mock' || !Array.isArray(run.shots) || !Array.isArray(run.artifacts)) throw new Error('Неверный файл mock-серии.');
      return run;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ProductionError('NOT_FOUND', 'Серия не найдена.');
      throw error;
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
    const runs = await Promise.all(files.map((f) => read(f.slice(0, -5))));
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function tick(): Promise<void> {
    await exclusive(async () => {
      for (const run of await list()) {
        const next = advanceRun(run, now(), delay);
        if (next !== run) await write(next);
      }
    });
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
    get: read, list, tick,
    waitForPreparation: async (id: string): Promise<void> => { await pending.get(id)?.done; },
    create: async (input: RunInput, character: CharacterSelection | null = null): Promise<ProductionRun> => {
      if ((input.characterId ?? null) !== (character?.id ?? null)) throw new ProductionError('INVALID', 'Персонаж серии не проверен.');
      const run = await exclusive(() => write({ ...newRun(`pr-${now().toString(36)}-${randomBytes(4).toString('hex')}`, input, now(), delay), character }));
      if (run.preparation) launchPreparation(run.id, run.preparation.attempt);
      return run;
    },
    setCharacter: (id: string, rev: number, character: CharacterSelection | null): Promise<ProductionRun> => exclusive(async () => {
      const run = await read(id);
      if (run.rev !== rev) throw new ProductionError('CONFLICT', 'Серия изменилась. Повтори выбор персонажа.');
      run.character = character; run.characterId = character?.id ?? null;
      record(run, now(), character ? `Выбран персонаж «${character.name}». Mock-кадры не меняются; сходство лица не проверялось.` : 'Персонаж отвязан от серии. Mock-кадры не меняются.');
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
        return write(next);
      });
      if (action.type === 'pause') pending.get(id)?.controller.abort();
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
      timer = setInterval(() => {
        if (ticking) return;
        ticking = true;
        void tick().catch((error: unknown) => console.error('Production mock:', error)).finally(() => { ticking = false; });
      }, 450);
      timer.unref();
    },
    stop(): void { if (timer) clearInterval(timer); timer = undefined; for (const job of pending.values()) job.controller.abort(); },
  };
}
export type ProductionRuntime = ReturnType<typeof createProductionRuntime>;
