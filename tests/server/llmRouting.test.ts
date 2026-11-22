import { EventEmitter } from 'node:events';
import type * as ChildProcess from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '../../src/core/model/project.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import { DEFAULT_LLM_MODEL } from '../../src/server/llm/codexCli/args.ts';
import { runCodex, type LlmRequest } from '../../src/server/llm/codexCli/provider.ts';
import { LLM_TASKS, selectLlmRoute, type LlmTask } from '../../src/server/llm/routing.ts';

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof ChildProcess>(), spawn: mocked.spawn }));
vi.mock('../../src/server/llm/codexCli/skills.ts', () => ({ skillPathsToDisable: () => [] }));

const overrides = ['SP_LLM_MODEL', 'SP_FIELDS_MODEL', 'SP_EDIT_MODEL', 'SP_REFERENCE_MODEL', 'SP_VISION_MODEL',
  'SP_REFERENCE_QUALITY_MODEL', 'SP_PRODUCTION_MODEL', 'SP_PRODUCTION_CRITIC_MODEL', 'SP_WRITER_MODEL',
  'SP_CRITIC_MODEL', 'SP_PROMPTER_MODEL', 'SP_CANVAS_AI_MODEL'];
const groups: { model: string; effort: 'low' | 'medium'; tasks: LlmTask[] }[] = [
  { model: 'gpt-6-luna', effort: 'low', tasks: ['fields', 'edit', 'reference-plan', 'reference-rank', 'reference-analysis'] },
  { model: 'gpt-6.1-terra', effort: 'medium', tasks: ['vision', 'reference-quality', 'reference-dedup', 'appearance', 'photo-review', 'retouch'] },
  { model: 'gpt-6.1-sol', effort: 'medium', tasks: ['writer', 'planner', 'text-critic', 'prompter', 'canvas-idea', 'canvas-prompt', 'production-director', 'production-prompts', 'series-prompter', 'series-critic'] },
];
const roots: string[] = [];
beforeEach(() => {
  for (const key of overrides) vi.stubEnv(key, undefined);
  mocked.spawn.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('economical product LLM routing', () => {
  it('covers every declared task without an automatic Astra route', () => {
    expect(new Set(LLM_TASKS)).toEqual(new Set(groups.flatMap(group => group.tasks)));
    expect(DEFAULT_LLM_MODEL).toBe('gpt-6-luna');
    for (const task of LLM_TASKS) expect(selectLlmRoute(task).model).not.toContain('astra');
  });

  it.each(groups.flatMap(group => group.tasks.map(task => ({ task, model: group.model, effort: group.effort }))))('$task selects $model with $effort effort', ({ task, model, effort }) => {
    expect(selectLlmRoute(task)).toMatchObject({ model, effort, source: 'profile', policyVersion: 'economical-v1' });
  });

  it('reserves high effort for the existing detailed photo inspection mode', () => {
    expect(selectLlmRoute('photo-review', { detailedInspection: true })).toMatchObject({ model: 'gpt-6.1-terra', effort: 'high' });
    expect(selectLlmRoute('reference-quality', { detailedInspection: true }).effort).toBe('medium');
  });

  it('keeps explicit, ordered role and global overrides ahead of the task profile', () => {
    vi.stubEnv('SP_LLM_MODEL', ' global-model ');
    vi.stubEnv('SP_VISION_MODEL', ' vision-model ');
    vi.stubEnv('SP_REFERENCE_QUALITY_MODEL', ' quality-model ');
    expect(selectLlmRoute('reference-quality', { explicitModel: ' gpt-6-astra ' })).toMatchObject({ model: 'gpt-6-astra', source: 'explicit', effort: 'medium' });
    expect(selectLlmRoute('reference-quality')).toMatchObject({ model: 'quality-model', source: 'role-env' });
    vi.stubEnv('SP_REFERENCE_QUALITY_MODEL', '  ');
    expect(selectLlmRoute('reference-quality')).toMatchObject({ model: 'vision-model', source: 'role-env' });
    vi.stubEnv('SP_VISION_MODEL', '');
    expect(selectLlmRoute('reference-quality')).toMatchObject({ model: 'global-model', source: 'global-env' });
    vi.stubEnv('SP_LLM_MODEL', '  ');
    expect(selectLlmRoute('reference-quality', { explicitModel: '\t' })).toMatchObject({ model: 'gpt-6.1-terra', source: 'profile' });
  });

  it.each([
    ['fields', 'SP_FIELDS_MODEL'], ['edit', 'SP_EDIT_MODEL'], ['reference-plan', 'SP_REFERENCE_MODEL'],
    ['reference-rank', 'SP_REFERENCE_MODEL'], ['reference-analysis', 'SP_VISION_MODEL'], ['vision', 'SP_VISION_MODEL'],
    ['appearance', 'SP_PRODUCTION_MODEL'], ['photo-review', 'SP_PRODUCTION_CRITIC_MODEL'], ['retouch', 'SP_PRODUCTION_CRITIC_MODEL'],
    ['writer', 'SP_WRITER_MODEL'], ['planner', 'SP_WRITER_MODEL'], ['text-critic', 'SP_CRITIC_MODEL'],
    ['prompter', 'SP_PROMPTER_MODEL'], ['canvas-idea', 'SP_CANVAS_AI_MODEL'], ['canvas-prompt', 'SP_CANVAS_AI_MODEL'],
    ['production-director', 'SP_PRODUCTION_MODEL'], ['production-prompts', 'SP_PRODUCTION_MODEL'],
    ['series-prompter', 'SP_PRODUCTION_MODEL'], ['series-critic', 'SP_CRITIC_MODEL'],
  ] as const)('%s preserves its existing %s override', (task, env) => {
    vi.stubEnv('SP_LLM_MODEL', 'global');
    vi.stubEnv(env, 'role-specific');
    expect(selectLlmRoute(task)).toMatchObject({ model: 'role-specific', source: 'role-env' });
  });

  it('fails closed for an unknown task', () => {
    expect(() => selectLlmRoute('untyped-task' as LlmTask)).toThrow('Неизвестная задача');
  });

  it('keeps the selected writer route through a repair even if configuration changes', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'routing-writer-')); roots.push(dataDir);
    const project = newProject('routing', 'Routing');
    project.shots[0]!.segments[0]!.beatsRu = 'Бумажный кораблик плывёт по луже.';
    const calls: LlmRequest[] = [];
    const app = createApp({ rootDir: path.resolve(import.meta.dirname, '../..'), dataDir,
      runLlm: async <T>(request: LlmRequest) => {
        calls.push(request);
        if (calls.length === 1) vi.stubEnv('SP_WRITER_MODEL', 'gpt-6-astra');
        return {
          data: { blocks: [{ segmentId: 'seg-1', en: calls.length === 1 ? '<<<image_1>>>' : 'A paper boat floats slowly across a shallow puddle. A breeze shifts the boat to the right.' }] } as T,
          meta: { durationMs: 1, model: request.model, turns: 1, inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    const response = await app.request('/api/llm/write', { method: 'POST', headers: { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' }, body: JSON.stringify({ project, shotId: 'shot-1' }) });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls.map(call => [call.model, call.effort])).toEqual([['gpt-6.1-sol', 'medium'], ['gpt-6.1-sol', 'medium']]);
  });
});

describe('unsupported model boundary', () => {
  it.each([
    "The 'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account.",
    'model_not_found: The model does not exist or you do not have access to it.',
  ])('returns a clear error without a second invocation: %s', async message => {
    const child = Object.assign(new EventEmitter(), {
      pid: 7654321, stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    });
    mocked.spawn.mockReturnValue(child);
    const promise = runCodex({ system: 'Trusted task', user: 'Input', model: 'gpt-6.1-terra', effort: 'medium',
      jsonSchema: { type: 'object', properties: {}, additionalProperties: false }, timeoutMs: 1000 });
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'turn.failed', error: { message } })}\n`));
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', messageRu: expect.stringContaining('автоматического переключения не было') });
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
  });
});
