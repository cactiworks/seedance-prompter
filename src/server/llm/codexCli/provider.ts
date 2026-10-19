import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { buildCliArgs, type Effort, type ImageInput } from './args.ts';
import { buildChildEnv } from './env.ts';
import { parseStructured, strictSchema } from './schema.ts';
import { checkIsolation } from './tripwire.ts';
import { skillPathsToDisable } from './skills.ts';

export { DEFAULT_LLM_MODEL } from './args.ts';
export type LlmErrorCode = 'NOT_INSTALLED' | 'CLI_OUTDATED' | 'NOT_LOGGED_IN' | 'USAGE_LIMIT' | 'ISOLATION_VIOLATION' | 'NO_STRUCTURED_OUTPUT' | 'TIMEOUT' | 'CANCELLED' | 'PROCESS_CRASH';

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
  effort?: Effort;
  images?: ImageInput[];
  timeoutMs: number;
  signal?: AbortSignal;
  taskRu?: string;
}

export interface LlmResult<T> {
  data: T;
  meta: { durationMs: number; model: string | null; turns: number | null; inputTokens: number; outputTokens: number };
}

function classify(text: string): LlmError | null {
  if (/requires a newer version of Codex|please upgrade to the latest app or CLI/i.test(text)) {
    return new LlmError('CLI_OUTDATED', 'Выбранной модели нужна новая версия Codex CLI. Обнови: npm install -g @openai/codex@latest. Затем повтори незавершённый этап.');
  }
  if (/not logged in|not authenticated|login required|authentication required|unauthorized|401|refresh token|forced login|requires? (?:a )?chatgpt|must (?:be logged|log) in|run [`']?codex login/i.test(text)) {
    return new LlmError('NOT_LOGGED_IN', 'Нужен вход в Codex через ChatGPT. Выполни `codex login` в терминале.', text.slice(0, 200));
  }
  if (/usage limit|rate.?limit|quota|too many requests|429/i.test(text)) {
    return new LlmError('USAGE_LIMIT', 'Лимит Codex исчерпан. Попробуй после его сброса; остальные функции доступны.', text.slice(0, 200));
  }
  return null;
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Keep a bounded diagnostic, never an auth header, API key or signed URL. */
function safeDiagnostic(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/https?:\/\/[^\s"']+/g, '[URL]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** One restricted, ephemeral Codex invocation. Authentication stays in the user's CODEX_HOME. */
export async function runCodex<T>(request: LlmRequest, options: { codexHome?: string } = {}): Promise<LlmResult<T>> {
  if (request.signal?.aborted === true) throw new LlmError('CANCELLED', 'Отменено.');
  const started = Date.now();
  const parentEnv = options.codexHome ? { ...process.env, CODEX_HOME: options.codexHome } : process.env;
  const cwd = mkdtempSync(path.join(tmpdir(), 'seedance-prompter-codex-'));
  const cleanup = (): void => rmSync(cwd, { recursive: true, force: true });
  let args: string[];
  try {
    const schemaFile = path.join(cwd, 'schema.json');
    writeFileSync(schemaFile, JSON.stringify(strictSchema(request.jsonSchema)), { mode: 0o600 });
    const imageFiles = (request.images ?? []).map((image, index) => {
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[image.mediaType];
      const file = path.join(cwd, `input-${index}.${extension}`);
      writeFileSync(file, Buffer.from(image.base64, 'base64'), { mode: 0o600 });
      return file;
    });
    args = buildCliArgs({ system: request.system, schemaFile, model: request.model, effort: request.effort, imageFiles, disabledSkillPaths: skillPathsToDisable(parentEnv) });
    if (options.codexHome) args.splice(args.length - 1, 0, '-c', 'cli_auth_credentials_store="file"');
  } catch (error) {
    cleanup();
    throw new LlmError('PROCESS_CRASH', 'Не удалось подготовить вызов Codex.', String(error));
  }

  return new Promise((resolve, reject) => {
    const task = request.taskRu ?? 'Агент';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('codex', args, { cwd, env: buildChildEnv(parentEnv), shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      cleanup();
      reject(new LlmError('PROCESS_CRASH', 'Не удалось запустить Codex.', String(error)));
      return;
    }
    let settled = false;
    let closed = false;
    let buffer = '';
    let stderr = '';
    let errorText = '';
    let diagnosticText = '';
    let outputBytes = 0;
    let finalText = '';
    let completed = false;
    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const decoder = new StringDecoder('utf8');

    const stop = (): void => {
      if (closed) return;
      // Detached POSIX process group includes the npm launcher and its native Codex child.
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already exited */ }
    };
    const detach = (): void => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: LlmError): void => {
      if (settled) return;
      settled = true;
      detach();
      stop();
      reject(error);
    };
    const onAbort = (): void => fail(new LlmError('CANCELLED', 'Отменено.'));
    const timer = setTimeout(() => fail(new LlmError('TIMEOUT', `${task} не ответил за ${Math.round(request.timeoutMs / 1000)} с. Попробуй ещё раз.`)), request.timeoutMs);
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const consumeLine = (line: string): void => {
      if (settled || line.trim() === '') return;
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('event is not an object');
        event = parsed as Record<string, unknown>;
      } catch {
        fail(new LlmError('PROCESS_CRASH', 'Codex вернул повреждённый поток событий.'));
        return;
      }
      const violations = checkIsolation(event);
      if (violations.length > 0) {
        fail(new LlmError('ISOLATION_VIOLATION', `Вызов Codex остановлен: ${violations.join('; ')}.`));
        return;
      }
      if (event.type === 'item.completed') {
        const item = event.item as { type?: string; text?: string; message?: string };
        if (item.type === 'agent_message' && typeof item.text === 'string') finalText = item.text;
        if (item.type === 'error' && typeof item.message === 'string') diagnosticText = safeDiagnostic(item.message);
      }
      if (event.type === 'error' || event.type === 'turn.failed') {
        const detail = event.error as { message?: string } | undefined;
        const message = typeof event.message === 'string' ? event.message : detail?.message ?? 'Codex failed';
        errorText = `${errorText}\n${message}`.slice(-16_384);
      }
      if (event.type === 'turn.completed') {
        completed = true;
        turns += 1;
        const usage = event.usage as Record<string, number> | undefined;
        // cached_input_tokens is a subset of input_tokens, not an extra charge/count.
        inputTokens += usage?.input_tokens ?? 0;
        outputTokens += usage?.output_tokens ?? 0;
      }
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(error.code === 'ENOENT'
        ? new LlmError('NOT_INSTALLED', 'Не найден `codex` в PATH. Установи актуальный Codex CLI: npm install -g @openai/codex@latest.')
        : new LlmError('PROCESS_CRASH', 'Не удалось запустить Codex.', error.message));
      cleanup();
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-16_384); });
    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) return fail(new LlmError('PROCESS_CRASH', 'Слишком большой поток событий Codex.'));
      buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
      }
    });
    // EPIPE is reported with the process exit and stderr; never leave an unhandled stream error.
    child.stdin?.on('error', (error: Error) => { stderr += `\n${error.message}`; });
    child.on('close', (code) => {
      closed = true;
      cleanup();
      if (settled) return;
      buffer += decoder.end();
      consumeLine(buffer);
      if (settled) return;
      settled = true;
      detach();
      if (code !== 0 || !completed || errorText !== '') {
        const detail = safeDiagnostic(errorText || diagnosticText || stderr.slice(-2000));
        const known = classify(`${stderr}\n${errorText}\n${diagnosticText}`);
        if (known !== null) return reject(known);
        return reject(new LlmError('PROCESS_CRASH', `${task}: Codex завершился с ошибкой.${detail ? ` ${detail}` : ''}`, `code=${String(code)} ${detail}`));
      }
      try {
        const data = parseStructured<T>(finalText, request.jsonSchema);
        resolve({ data, meta: { durationMs: Date.now() - started, model: request.model, turns, inputTokens, outputTokens } });
      } catch {
        reject(new LlmError('NO_STRUCTURED_OUTPUT', `${task}: ответ Codex не соответствует схеме.`));
      }
    });
    if (request.signal?.aborted === true) onAbort();
    if (!settled) child.stdin?.end(request.user);
  });
}
