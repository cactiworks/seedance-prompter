import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCliArgs, buildStdinMessage } from '../../src/server/llm/claudeCli/args.ts';
import { buildChildEnv, leakedKeys } from '../../src/server/llm/claudeCli/env.ts';
import { checkIsolation, type InitEvent } from '../../src/server/llm/claudeCli/tripwire.ts';

// Реальные события, записанные `npm run doctor -- --control` 20.09.2026.
function initOf(file: string): InitEvent {
  const raw = readFileSync(path.join(import.meta.dirname, '../../docs/day0', file), 'utf8');
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const event = JSON.parse(line) as { type?: string; subtype?: string };
    if (event.type === 'system' && event.subtype === 'init') return event as InitEvent;
  }
  throw new Error(`нет system/init в ${file}`);
}

describe('tripwire изоляции', () => {
  it('пропускает изолированный вызов', () => {
    expect(checkIsolation(initOf('probe-isolated-sonnet.ndjson'))).toEqual([]);
  });

  it('ловит вызов без --safe-mode: skills, команды, MCP владельца', () => {
    const violations = checkIsolation(initOf('probe-control-sonnet.ndjson'));
    expect(violations.length).toBeGreaterThan(0);
  });

  it('ловит биллинг по API-ключу', () => {
    expect(checkIsolation({ tools: ['StructuredOutput'], apiKeySource: 'ANTHROPIC_API_KEY' })).toHaveLength(1);
  });

  it('ловит лишний инструмент', () => {
    expect(checkIsolation({ tools: ['StructuredOutput', 'Bash'] })[0]).toContain('Bash');
  });
});

describe('окружение дочернего процесса', () => {
  const parent = {
    HOME: '/Users/x',
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'sk-secret',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    SOME_OTHER: 'value',
  };

  it('не наследует ключи API и маркеры родительской сессии', () => {
    const env = buildChildEnv(parent);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.SOME_OTHER).toBeUndefined();
    expect(env.HOME).toBe('/Users/x');
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  });

  it('называет опасные переменные родителя', () => {
    expect(leakedKeys(parent).sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']);
  });
});

describe('аргументы CLI', () => {
  const args = buildCliArgs({ systemPromptFile: '/tmp/s.md', jsonSchema: { type: 'object' }, model: 'opus', fallbackModel: 'sonnet' });

  it('включает изоляцию и не ломает structured output', () => {
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--bare');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('mcp__*');
    expect(Number(args[args.indexOf('--max-turns') + 1])).toBeGreaterThan(1);
    expect(args[args.indexOf('--fallback-model') + 1]).toBe('sonnet');
  });

  it('кладёт картинку в stdin base64-блоком', () => {
    const line = buildStdinMessage('hi', [{ mediaType: 'image/jpeg', base64: 'AAAA' }]);
    const parsed = JSON.parse(line) as { message: { content: { type: string }[] } };
    expect(parsed.message.content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(line.endsWith('\n')).toBe(true);
  });
});
