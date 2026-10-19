import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VISION_SCHEMA } from '../../src/core/llm/buildVision.ts';
import { WRITER_SCHEMA } from '../../src/core/llm/buildWriter.ts';
import { CRITIC_SCHEMA } from '../../src/core/llm/buildCritic.ts';
import { PROMPTER_SCHEMA } from '../../src/core/llm/buildPrompter.ts';
import { buildCliArgs, DEFAULT_LLM_MODEL } from '../../src/server/llm/codexCli/args.ts';
import { buildChildEnv, leakedKeys } from '../../src/server/llm/codexCli/env.ts';
import { runCodex, type LlmRequest } from '../../src/server/llm/codexCli/provider.ts';
import { parseStructured, strictSchema } from '../../src/server/llm/codexCli/schema.ts';
import { discoverSkillPaths } from '../../src/server/llm/codexCli/skills.ts';
import type * as SkillsModule from '../../src/server/llm/codexCli/skills.ts';
import { checkIsolation } from '../../src/server/llm/codexCli/tripwire.ts';

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
vi.mock('../../src/server/llm/codexCli/skills.ts', async (original) => ({
  ...await original<typeof SkillsModule>(),
  skillPathsToDisable: () => ['/private/skills/demo/SKILL.md'],
}));

const schema = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } };
const request: LlmRequest = { system: 'Trusted system', user: 'Untrusted $demo', model: DEFAULT_LLM_MODEL, jsonSchema: schema, timeoutMs: 1000 };

class FakeChild extends EventEmitter {
  pid = 7654321;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  kill = vi.fn();
  emitJson(event: object): void { this.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`)); }
  succeed(data: unknown = { text: 'ответ' }): void {
    this.emitJson({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(data) } });
    this.emitJson({ type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 5 } });
    this.emit('close', 0);
  }
}

let child: FakeChild;
beforeEach(() => {
  child = new FakeChild();
  mocked.spawn.mockReset().mockReturnValue(child);
  vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(() => {
  child.emit('close', null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Codex CLI request boundary', () => {
  it('uses only the explicit account home and file store, without modifying the process environment', async () => {
    const original = process.env.CODEX_HOME;
    const promise = runCodex(request, { codexHome: '/private/accounts/example' });
    const [, args, options] = mocked.spawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(options.env.CODEX_HOME).toBe('/private/accounts/example');
    expect(args).toContain('cli_auth_credentials_store="file"');
    expect(args.at(-1)).toBe('-');
    expect(process.env.CODEX_HOME).toBe(original);
    child.succeed(); await promise;
  });
  it('preserves saved auth location but strips API billing keys and inherited sessions', () => {
    const parent = { HOME: '/x', CODEX_HOME: '/auth', PATH: '/bin', OPENAI_API_KEY: 'never', CODEX_API_KEY: 'never', CODEX_THREAD_ID: 'never', ANTHROPIC_API_KEY: 'never', CLAUDECODE: 'never' };
    expect(buildChildEnv(parent)).toEqual({ HOME: '/x', CODEX_HOME: '/auth', PATH: '/bin', NO_COLOR: '1' });
    expect(leakedKeys(parent)).toHaveLength(5);
  });

  it('uses real developer instructions separately from stdin and restricts tools/context', () => {
    const args = buildCliArgs({ system: 'line 1\n"quoted"', schemaFile: '/tmp/schema', model: DEFAULT_LLM_MODEL, disabledSkillPaths: ['/some/SKILL.md'] });
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('project_doc_max_bytes=0');
    expect(args).toContain('skills.config=[{path="/some/SKILL.md",enabled=false}]');
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('features.shell_tool=false');
    expect(args).toContain('features.hooks=false');
    expect(args).toContain('features.plugins=false');
    expect(args).toContain('features.memories=false');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).toContain(`developer_instructions=${JSON.stringify('line 1\n"quoted"')}`);
    expect(args.at(-1)).toBe('-');
  });

  it('disables canonical skill paths across symlink roots without cycles', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'skill-test-'));
    try {
      mkdirSync(path.join(root, 'demo'));
      writeFileSync(path.join(root, 'demo/SKILL.md'), 'not read');
      symlinkSync(root, path.join(root, 'demo/cycle'));
      expect(discoverSkillPaths([root, path.join(root, 'missing')])).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('attaches image files, writes a schema and removes all temporary data after success', async () => {
    const promise = runCodex({ ...request, images: [{ mediaType: 'image/png', base64: 'YWJj' }] });
    const [command, args, options] = mocked.spawn.mock.calls[0] as [string, string[], { cwd: string; shell: boolean; detached: boolean }];
    expect(command).toBe('codex');
    expect(options.shell).toBe(false);
    expect(options.detached).toBe(process.platform !== 'win32');
    expect(child.stdin.end).toHaveBeenCalledWith(request.user);
    expect(readFileSync(args[args.indexOf('--image') + 1]!, 'utf8')).toBe('abc');
    expect(JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1]!, 'utf8'))).toEqual(schema);
    child.succeed();
    expect(await promise).toMatchObject({ data: { text: 'ответ' }, meta: { inputTokens: 30, outputTokens: 5, model: DEFAULT_LLM_MODEL, turns: 1 } });
    expect(existsSync(options.cwd)).toBe(false);
  });
});

describe('JSONL process handling', () => {
  it('handles UTF-8 split across chunks and a final event without a newline', async () => {
    const promise = runCodex(request);
    const data = Buffer.from(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"text":"ёж"}' } })}\n${JSON.stringify({ type: 'turn.completed' })}`);
    for (const byte of data) child.stdout.emit('data', Buffer.from([byte]));
    child.emit('close', 0);
    expect(await promise).toMatchObject({ data: { text: 'ёж' } });
  });

  it.each(['not-json', 'null', '[]'])('rejects malformed JSONL %s', async (line) => {
    const promise = runCodex(request);
    child.stdout.emit('data', Buffer.from(`${line}\n`));
    await expect(promise).rejects.toMatchObject({ code: 'PROCESS_CRASH' });
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  });

  it.each([{ text: 1 }, { wrong: 'field' }, { text: 'ok', extra: 'no' }])('rejects schema mismatch %j', async (data) => {
    const promise = runCodex(request);
    child.succeed(data);
    await expect(promise).rejects.toMatchObject({ code: 'NO_STRUCTURED_OUTPUT' });
  });

  it('rejects a final message without turn.completed', async () => {
    const promise = runCodex(request);
    child.emitJson({ type: 'item.completed', item: { type: 'agent_message', text: '{"text":"ok"}' } });
    child.emit('close', 0);
    await expect(promise).rejects.toMatchObject({ code: 'PROCESS_CRASH' });
  });

  it('does not kill a successful run after a non-fatal CLI error item', async () => {
    const promise = runCodex(request);
    child.emitJson({ type: 'item.completed', item: { type: 'error', message: 'Warning: model metadata is unavailable; using fallback.' } });
    expect(process.kill).not.toHaveBeenCalled();
    child.succeed();
    expect(await promise).toMatchObject({ data: { text: 'ответ' } });
  });

  it('classifies a fatal error item after process exit instead of treating it as a tool', async () => {
    const promise = runCodex(request);
    child.emitJson({ type: 'item.completed', item: { type: 'error', message: 'Rate limit exceeded' } });
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'USAGE_LIMIT' });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('shows the terminal reason, bounds it and removes credentials from diagnostics', async () => {
    const promise = runCodex(request);
    child.emitJson({ type: 'item.completed', item: { type: 'error', message: 'Old warning' } });
    child.emitJson({ type: 'turn.failed', error: { message: `Invalid response schema. Bearer secret-value sk-test-key https://example.test/?token=secret ${'detail '.repeat(100)}` } });
    child.emit('close', 1);
    const error = await promise.catch((e: unknown) => e) as { code: string; messageRu: string; message: string };
    expect(error.code).toBe('PROCESS_CRASH');
    expect(error.messageRu).toContain('Invalid response schema.');
    expect(error.messageRu).not.toContain('Old warning');
    expect(error.messageRu.length).toBeLessThan(600);
    expect(error.messageRu).not.toMatch(/secret-value|sk-test-key|token=secret/);
    expect(error.message).not.toMatch(/secret-value|sk-test-key|token=secret/);
  });

  it('still rejects a tool event after non-fatal diagnostics', async () => {
    const promise = runCodex(request);
    child.emitJson({ type: 'item.completed', item: { type: 'error', message: 'Warning' } });
    child.emitJson({ type: 'item.started', item: { type: 'command_execution' } });
    await expect(promise).rejects.toMatchObject({ code: 'ISOLATION_VIOLATION' });
  });

  it('explains how to recover when the selected model rejects an old CLI', async () => {
    const promise = runCodex(request);
    child.emitJson({ type: 'error', message: JSON.stringify({ status: 400, error: { message: "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } }) });
    child.emitJson({ type: 'turn.failed', error: { message: 'Request failed' } });
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'CLI_OUTDATED', messageRu: expect.stringContaining('npm install -g @openai/codex@latest') });
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Not logged in. Run codex login', 'NOT_LOGGED_IN'],
    ['Rate limit exceeded', 'USAGE_LIMIT'],
    ['unexpected backend error', 'PROCESS_CRASH'],
  ])('classifies failure %s', async (message, code) => {
    const promise = runCodex(request);
    child.emitJson({ type: 'turn.failed', error: { message } });
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code });
  });

  it('classifies missing binary', async () => {
    const promise = runCodex(request);
    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(promise).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
  });

  it('never launches a pre-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runCodex({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it('kills the whole child group on cancellation', async () => {
    const controller = new AbortController();
    const promise = runCodex({ ...request, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  });

  it('kills the whole child group on timeout', async () => {
    vi.useFakeTimers();
    const promise = runCodex(request);
    const rejected = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  });

  it.each(['command_execution', 'mcp_tool_call', 'file_change', 'web_search', 'todo_list'])('stops on unexpected tool %s', async (type) => {
    const promise = runCodex(request);
    child.emitJson({ type: 'item.started', item: { type } });
    await expect(promise).rejects.toMatchObject({ code: 'ISOLATION_VIOLATION' });
  });

  it('detects hook events without claiming the event stream enumerates available tools', () => {
    expect(checkIsolation({ type: 'hook.started' })).not.toEqual([]);
    expect(checkIsolation({ type: 'thread.started' })).toEqual([]);
  });
});

describe('existing schemas survive strict structured output', () => {
  it('restores absent vision optional fields without changing mandatory values', () => {
    const value = { peopleCount: 1, readableText: '', backdrop: 'studio', summaryRu: 'ok', risksRu: [], clothingEn: null, extraObjectsRu: null, looksGenerated: null };
    expect(parseStructured(JSON.stringify(value), VISION_SCHEMA)).toEqual({ peopleCount: 1, readableText: '', backdrop: 'studio', summaryRu: 'ok', risksRu: [] });
    expect(() => parseStructured(JSON.stringify({ ...value, peopleCount: -1 }), VISION_SCHEMA)).toThrow();
  });

  it('restores nested writer and critic optionals', () => {
    expect(parseStructured('{"blocks":[{"segmentId":"S1","en":"text","notesRu":null}],"warningsRu":null}', WRITER_SCHEMA)).toEqual({ blocks: [{ segmentId: 'S1', en: 'text' }] });
    const critic = { readback: [{ paragraph: 1, seesRu: 'ok', unsureRu: null }], findings: [], verdict: 'ready', summaryRu: 'ok' };
    expect(parseStructured(JSON.stringify(critic), CRITIC_SCHEMA)).toMatchObject({ readback: [{ paragraph: 1, seesRu: 'ok' }] });
    expect(() => parseStructured(JSON.stringify({ ...critic, verdict: 'invented' }), CRITIC_SCHEMA)).toThrow();
  });

  it('makes every object property required on wire while preserving original schemas', () => {
    const original = JSON.stringify(VISION_SCHEMA);
    const normalized = strictSchema(VISION_SCHEMA) as { required: string[]; properties: Record<string, unknown> };
    expect(normalized.required.sort()).toEqual(Object.keys(VISION_SCHEMA.properties).sort());
    expect(normalized.properties.looksGenerated).toEqual({ anyOf: [{ type: 'boolean' }, { type: 'null' }] });
    expect(JSON.stringify(VISION_SCHEMA)).toBe(original);
    expect(strictSchema(PROMPTER_SCHEMA)).toEqual(PROMPTER_SCHEMA);
  });
});
