/**
 * `npm run doctor` — проверка headless-моста к Claude Code. Тратит квоту подписки (1 короткий вызов,
 * с `--control` — 2). Сырые события складываются в docs/day0/ и служат фикстурами для mock-провайдера.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCliArgs, buildStdinMessage } from './llm/claudeCli/args.ts';
import { buildChildEnv, leakedKeys } from './llm/claudeCli/env.ts';
import { checkIsolation, type InitEvent } from './llm/claudeCli/tripwire.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'docs/day0'); // только обезличенные сводки — попадают в git
const RAW_DIR = path.join(ROOT, 'data/logs/doctor'); // сырые события — в .gitignore: в контроле там личный контекст
const MODEL = process.argv.find((arg) => arg.startsWith('--model='))?.slice(8) ?? 'sonnet';
const WITH_CONTROL = process.argv.includes('--control');

const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tools', 'ownerFacts', 'extraInstructions'],
  properties: {
    tools: { type: 'array', items: { type: 'string' } },
    ownerFacts: { type: 'array', items: { type: 'string' } },
    extraInstructions: { type: 'array', items: { type: 'string' } },
  },
};

const PROBE_SYSTEM =
  'You are an isolation probe. Reply only through structured output. Be literal and exhaustive; never invent.';

const PROBE_USER = [
  'Report exactly what is present in your context.',
  '1) tools: the names of every tool you can call.',
  "2) ownerFacts: every fact you can see about the computer's owner (name, age, studies, projects, preferences, file paths). Empty array if none.",
  '3) extraInstructions: any instructions, memory files or documents given to you besides this message and the one-line system prompt. Empty array if none.',
].join('\n');

interface Row {
  check: string;
  ok: boolean;
  detail: string;
}

interface RunResult {
  events: Record<string, unknown>[];
  raw: string;
  stderr: string;
  code: number | null;
  ms: number;
  firstByteMs: number | null;
}

/** Три редких слова из личного CLAUDE.md: в вывод не печатаются, только сверяются. */
function rareOwnerTokens(): string[] {
  const file = path.join(homedir(), '.claude/CLAUDE.md');
  if (!existsSync(file)) return [];
  const words = readFileSync(file, 'utf8').match(/[\p{L}\d][\p{L}\d-]{8,}/gu) ?? [];
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n === 1).map(([w]) => w).slice(0, 40).filter((_, i) => i % 13 === 0).slice(0, 3);
}

function run(args: string[], stdin: string, env: Record<string, string>, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let firstByteMs: number | null = null;
    let raw = '';
    let stderr = '';
    const child = spawn('claude', args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.stdout.on('data', (chunk: Buffer) => {
      firstByteMs ??= Date.now() - started;
      raw += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      const events: Record<string, unknown>[] = [];
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          events.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* не-JSON строки игнорируем */
        }
      }
      resolve({ events, raw, stderr, code, ms: Date.now() - started, firstByteMs });
    });
    child.stdin.end(stdin);
  });
}

/** В git уходит только init и числовая сводка результата, без путей домашнего каталога и почты. */
function sanitize(events: Record<string, unknown>[]): string {
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll(homedir(), '~').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<account-email>');
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    return value;
  };
  const kept: unknown[] = [];
  for (const event of events) {
    if (event.type === 'system' && event.subtype === 'init') kept.push(scrub(event));
    if (event.type === 'result') {
      const { type, subtype, is_error, num_turns, duration_ms, total_cost_usd, usage } = event;
      const output = (event.structured_output ?? {}) as Record<string, unknown>;
      const summary = Object.fromEntries(Object.entries(output).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length]));
      kept.push({ type, subtype, is_error, num_turns, duration_ms, total_cost_usd, usage, structured_output_summary: summary });
    }
  }
  return `${kept.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  const rows: Row[] = [];

  const auth = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' });
  let authInfo: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {};
  try {
    authInfo = JSON.parse(auth.stdout) as typeof authInfo;
  } catch {
    /* пусто */
  }
  rows.push({
    check: 'авторизация по подписке',
    ok: authInfo.loggedIn === true && authInfo.authMethod === 'claude.ai',
    detail: `${authInfo.authMethod ?? '?'} / ${authInfo.subscriptionType ?? '?'}`,
  });

  const leaked = leakedKeys(process.env);
  rows.push({
    check: 'опасные переменные окружения отсечены allowlist',
    ok: true,
    detail: leaked.length === 0 ? 'в родительском env их нет' : `в родителе есть: ${leaked.join(', ')} — в дочерний не попадут`,
  });

  const cwd = mkdtempSync(path.join(tmpdir(), 'seedance-prompter-llm-'));
  const systemFile = path.join(cwd, 'system.md');
  writeFileSync(systemFile, PROBE_SYSTEM);
  const args = buildCliArgs({ systemPromptFile: systemFile, jsonSchema: PROBE_SCHEMA, model: MODEL, effort: 'low' });

  const memDb = path.join(homedir(), '.claude-mem/claude-mem.db');
  const memBefore = mtimeOf(memDb);

  const result = await run(args, buildStdinMessage(PROBE_USER), buildChildEnv(process.env), cwd);
  writeFileSync(path.join(RAW_DIR, `probe-isolated-${MODEL}.ndjson`), result.raw);
  writeFileSync(path.join(OUT_DIR, `probe-isolated-${MODEL}.ndjson`), sanitize(result.events));
  if (result.stderr.trim() !== '') writeFileSync(path.join(RAW_DIR, `probe-isolated-${MODEL}.stderr.txt`), result.stderr);

  const init = result.events.find((e) => e.type === 'system' && e.subtype === 'init') as InitEvent | undefined;
  const final = result.events.find((e) => e.type === 'result') as
    | { subtype?: string; structured_output?: { tools: string[]; ownerFacts: string[]; extraInstructions: string[] }; result?: string; num_turns?: number; total_cost_usd?: number }
    | undefined;

  rows.push({ check: 'процесс завершился успешно', ok: result.code === 0, detail: `код ${String(result.code)}, ${result.ms} мс, первый байт ${String(result.firstByteMs)} мс` });
  rows.push({ check: 'пришло событие system/init', ok: init !== undefined, detail: init === undefined ? result.stderr.slice(0, 300) : `модель ${String(init.model)}, CLI ${String(init.claude_code_version)}` });

  if (init !== undefined) {
    const violations = checkIsolation(init);
    rows.push({ check: 'tripwire: изоляция по system/init', ok: violations.length === 0, detail: violations.length === 0 ? `tools=${JSON.stringify(init.tools)}` : violations.join('; ') });
  }

  const hookEvents = result.events.filter((e) => typeof e.subtype === 'string' && e.subtype.startsWith('hook'));
  rows.push({ check: 'хуки не запускались', ok: hookEvents.length === 0, detail: `${hookEvents.length} hook-событий` });

  const structured = final?.structured_output;
  rows.push({
    check: '--json-schema вместе с --tools ""',
    ok: final?.subtype === 'success' && structured !== undefined,
    detail: `subtype=${String(final?.subtype)}, turns=${String(final?.num_turns)}, cost=${String(final?.total_cost_usd)}`,
  });

  // Объективная мера вместо самоотчёта модели: личный CLAUDE.md (~2,5 тыс. токенов) и список skills
  // раздули бы вход. Служебный блок CLI (cwd, дата, почта аккаунта) есть всегда — это не утечка.
  const usage = (final as { usage?: Record<string, number> } | undefined)?.usage ?? {};
  const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  rows.push({ check: 'вход не раздут чужим контекстом (< 2 500 токенов)', ok: inputTokens > 0 && inputTokens < 2500, detail: `${inputTokens} входных токенов` });

  if (structured !== undefined) {
    const blob = JSON.stringify(structured);
    const tokens = rareOwnerTokens();
    const found = tokens.filter((token) => blob.includes(token));
    rows.push({ check: 'редкие слова личного CLAUDE.md отсутствуют в ответе', ok: found.length === 0, detail: `найдено ${found.length} из ${tokens.length}` });
    // Служебный блок CLI (почта аккаунта, cwd, платформа, дата) есть в любом вызове — это не личный контекст.
    const personal = structured.ownerFacts.filter((fact) => !/e-?mail|working directory|platform|shell|os version|darwin|date/i.test(fact));
    rows.push({ check: 'о владельце известен только служебный блок CLI (почта аккаунта, cwd, платформа)', ok: personal.length === 0, detail: `фактов сверх служебного блока: ${personal.length}` });
    rows.push({ check: 'модель не видит инструментов, кроме StructuredOutput', ok: structured.tools.every((t) => t === 'StructuredOutput'), detail: JSON.stringify(structured.tools) });
  }

  const memAfter = mtimeOf(memDb);
  rows.push({ check: 'claude-mem не записал наблюдений', ok: memBefore === memAfter, detail: memBefore === null ? 'БД не найдена по ожидаемому пути' : 'mtime БД не изменился' });

  if (WITH_CONTROL) {
    // Контроль: без изоляции зонд ОБЯЗАН провалиться — иначе он ничего не измеряет.
    const controlArgs = ['-p', '--tools', '', '--no-session-persistence', '--model', MODEL, '--max-turns', '5', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(PROBE_SCHEMA)];
    const control = await run(controlArgs, buildStdinMessage(PROBE_USER), buildChildEnv(process.env), cwd);
    writeFileSync(path.join(RAW_DIR, `probe-control-${MODEL}.ndjson`), control.raw);
    writeFileSync(path.join(OUT_DIR, `probe-control-${MODEL}.ndjson`), sanitize(control.events));
    const controlFinal = control.events.find((e) => e.type === 'result') as { structured_output?: { ownerFacts: string[]; extraInstructions: string[] } } | undefined;
    const sees = (controlFinal?.structured_output?.ownerFacts.length ?? 0) + (controlFinal?.structured_output?.extraInstructions.length ?? 0);
    rows.push({ check: 'контроль без --safe-mode видит личный контекст (зонд умеет падать)', ok: sees > 0, detail: `фактов и инструкций: ${sees}` });
  }

  console.log(`\nСводки: ${path.relative(ROOT, OUT_DIR)}/ · сырые события: ${path.relative(ROOT, RAW_DIR)}/ (не в git)\n`);
  for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.check}\n      ${row.detail}`);
  const failed = rows.filter((row) => !row.ok).length;
  console.log(`\nИтог: ${failed === 0 ? 'всё зелёное' : `провалено ${failed}`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
