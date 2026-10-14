/** Read-only local checks by default; --live explicitly spends the owner's Codex quota. */
import { spawnSync } from 'node:child_process';
import { buildChildEnv, leakedKeys } from './llm/codexCli/env.ts';
import { DEFAULT_LLM_MODEL, LlmError, runCodex } from './llm/codexCli/provider.ts';
import { skillPathsToDisable } from './llm/codexCli/skills.ts';

const model = process.argv.find((arg) => arg.startsWith('--model='))?.slice(8) ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL;

async function main(): Promise<void> {
  const env = buildChildEnv(process.env);
  const version = spawnSync('codex', ['--version'], { env, encoding: 'utf8', timeout: 10_000 });
  if (version.status !== 0) throw new Error('Codex CLI не найден или не отвечает.');
  console.log(`Codex: ${version.stdout.trim()}`);
  const auth = spawnSync('codex', ['login', 'status'], { env, encoding: 'utf8', timeout: 10_000 });
  const chatgpt = auth.status === 0 && /logged in using chatgpt/i.test(`${auth.stdout}\n${auth.stderr}`);
  console.log(`Авторизация ChatGPT: ${chatgpt ? 'OK' : 'нужен codex login'}`);
  if (!chatgpt) process.exitCode = 1;
  console.log(`Отсечено переменных окружения: ${leakedKeys(process.env).length}`);
  console.log(`Отключено локальных skills: ${skillPathsToDisable(process.env).length}`);
  console.log('Изоляция: временный cwd, без пользовательского config/AGENTS, MCP из пользовательского config, plugins, hooks и памяти; read-only и approval=never.');
  console.log('Ограничение: CLI может предлагать встроенный apply_patch. Любое событие инструмента отклоняется. Это не доказательство отсутствия инструментов или административного контекста.');

  if (!process.argv.includes('--live')) {
    console.log('LLM не вызывался. Живой зонд запускает владелец: npm run doctor -- --live');
    return;
  }
  if (!chatgpt) return;
  const result = await runCodex<{ tools: string[]; unexpectedContext: string[] }>({
    model, effort: 'low', timeoutMs: 90_000, taskRu: 'Зонд',
    system: 'Report only tools and context actually visible to you. Do not call tools. Do not infer personal facts. Return the requested JSON object.',
    user: 'List callable tool names in tools. In unexpectedContext list any personal, project, skill or memory instructions beyond the built-in Codex instructions and this probe. Empty array if none.',
    jsonSchema: {
      type: 'object', additionalProperties: false, required: ['tools', 'unexpectedContext'],
      properties: { tools: { type: 'array', items: { type: 'string' } }, unexpectedContext: { type: 'array', items: { type: 'string' } } },
    },
  });
  // Counts only: no raw model text or private context is written into docs or logs.
  console.log(`Зонд: ${result.meta.durationMs} мс, вход ${result.meta.inputTokens}, выход ${result.meta.outputTokens} tokens.`);
  console.log(`Самоотчёт модели: tools=${result.data.tools.length}, unexpectedContext=${result.data.unexpectedContext.length}. Самоотчёт не является доказательством изоляции.`);
  if (result.data.unexpectedContext.length > 0 || result.data.tools.some((tool) => !/(^|\.)apply_patch$/.test(tool))) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof LlmError ? error.messageRu : String(error));
  process.exitCode = 1;
});
