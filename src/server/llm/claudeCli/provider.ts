import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCliArgs, buildStdinMessage, type Effort, type ImageInput } from './args.ts';
import { buildChildEnv } from './env.ts';
import { checkIsolation, type InitEvent } from './tripwire.ts';

export type LlmErrorCode = 'NOT_INSTALLED' | 'NOT_LOGGED_IN' | 'USAGE_LIMIT' | 'ISOLATION_VIOLATION' | 'NO_STRUCTURED_OUTPUT' | 'TIMEOUT' | 'CANCELLED' | 'PROCESS_CRASH';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly messageRu: string;
  constructor(code: LlmErrorCode, messageRu: string, detail = '') {
    super(`${code}: ${detail || messageRu}`);
    this.code = code;
    this.messageRu = messageRu;
  }
}

export interface LlmRequest {
  system: string;
  user: string;
  jsonSchema: object;
  model: string;
  fallbackModel?: string;
  effort?: Effort;
  images?: ImageInput[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LlmResult<T> {
  data: T;
  meta: { durationMs: number; model: string | null; turns: number | null; inputTokens: number; outputTokens: number };
}

function classify(text: string): LlmError | null {
  if (/not logged in|please run \/login|login expired/i.test(text)) return new LlmError('NOT_LOGGED_IN', 'Claude Code разлогинен. Открой терминал, запусти `claude` и выполни /login.', text.slice(0, 200));
  if (/hit your (session|weekly|usage|opus) limit|usage limit|rate limit/i.test(text)) {
    const reset = text.match(/resets?\s+([^\n·(]+)/i)?.[1]?.trim();
    return new LlmError('USAGE_LIMIT', `Лимит подписки исчерпан${reset === undefined ? '' : ` — сброс ${reset}`}. Всё, кроме писателя, продолжает работать.`, text.slice(0, 200));
  }
  return null;
}

/** Каталог вне репозитория и пустой: CLI ищет CLAUDE.md вверх по родителям cwd. */
const SANDBOX = mkdtempSync(path.join(tmpdir(), 'seedance-prompter-llm-'));
const systemFiles = new Map<string, string>();

function systemFile(system: string): string {
  const hash = createHash('sha256').update(system).digest('hex').slice(0, 16);
  let file = systemFiles.get(hash);
  if (file === undefined) {
    file = path.join(SANDBOX, `system-${hash}.md`);
    mkdirSync(SANDBOX, { recursive: true });
    writeFileSync(file, system);
    systemFiles.set(hash, file);
  }
  return file;
}

/** Один изолированный вызов `claude -p` со структурным ответом. */
export function runClaude<T>(request: LlmRequest): Promise<LlmResult<T>> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const args = buildCliArgs({ systemPromptFile: systemFile(request.system), jsonSchema: request.jsonSchema, model: request.model, fallbackModel: request.fallbackModel, effort: request.effort });
    const child = spawn('claude', args, { cwd: SANDBOX, env: buildChildEnv(process.env), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

    let buffer = '';
    let stderr = '';
    let settled = false;
    let init: InitEvent | null = null;
    let final: Record<string, unknown> | null = null;

    const stop = (): void => {
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    const fail = (error: LlmError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(error);
    };

    const timer = setTimeout(() => fail(new LlmError('TIMEOUT', `Писатель не ответил за ${Math.round(request.timeoutMs / 1000)} с.`)), request.timeoutMs);
    request.signal?.addEventListener('abort', () => fail(new LlmError('CANCELLED', 'Отменено.')), { once: true });

    child.on('error', (error: NodeJS.ErrnoException) => fail(error.code === 'ENOENT' ? new LlmError('NOT_INSTALLED', 'Не найден `claude` в PATH. Нужен установленный Claude Code.') : new LlmError('PROCESS_CRASH', 'Не удалось запустить claude.', error.message)));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line === '') continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.type === 'system' && event.subtype === 'init') {
          init = event as InitEvent;
          // Tripwire на каждом вызове: чужой контекст — повод убить процесс, а не использовать ответ.
          const violations = checkIsolation(init);
          if (violations.length > 0) return fail(new LlmError('ISOLATION_VIOLATION', `Вызов не изолирован: ${violations.join('; ')}. Запусти npm run doctor.`));
        }
        if (event.type === 'result') final = event;
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const resultText = typeof final?.result === 'string' ? final.result : '';
      const known = classify(`${stderr}\n${resultText}`);
      if (known !== null) return reject(known);
      if (final === null || final.subtype !== 'success') return reject(new LlmError('PROCESS_CRASH', 'Писатель завершился с ошибкой.', `code=${String(code)} subtype=${String(final?.subtype)} ${stderr.slice(0, 300)}`));

      let data = final.structured_output as T | undefined;
      if (data === undefined || data === null) {
        // Документация предупреждает: бывает success без structured_output — пробуем разобрать текст.
        try {
          data = JSON.parse(resultText) as T;
        } catch {
          return reject(new LlmError('NO_STRUCTURED_OUTPUT', 'Писатель ответил не по схеме.', resultText.slice(0, 200)));
        }
      }
      const usage = (final.usage ?? {}) as Record<string, number>;
      resolve({
        data,
        meta: {
          durationMs: Date.now() - started,
          model: init?.model ?? null,
          turns: typeof final.num_turns === 'number' ? final.num_turns : null,
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
        },
      });
    });

    child.stdin.end(buildStdinMessage(request.user, request.images));
  });
}
