/** Сборка аргументов `claude -p`. Единственное место, где живут флаги изоляции. */

export type Effort = 'low' | 'medium' | 'high';

export interface CliArgsInput {
  systemPromptFile: string;
  jsonSchema: object;
  model: string;
  effort?: Effort;
  fallbackModel?: string;
  maxTurns?: number;
}

/**
 * Почему именно эти флаги (проверено по `claude --help` 2.1.278 и документации):
 * - `--safe-mode` отключает CLAUDE.md, хуки, плагины, MCP, skills, auto-memory, но оставляет auth
 *   подписки. `--bare` не годится: он читает только ANTHROPIC_API_KEY.
 * - `--tools ""` убирает встроенные инструменты; structured output реализован внутренним tool
 *   `StructuredOutput`, поэтому `--disallowedTools "*"` и `--max-turns 1` использовать нельзя.
 * - stream-json в обе стороны: один путь для текста и для vision (image-блок в stdin).
 */
export function buildCliArgs(input: CliArgsInput): string[] {
  const args = [
    '-p',
    '--safe-mode',
    '--strict-mcp-config',
    '--tools',
    '',
    '--disallowedTools',
    'mcp__*',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--system-prompt-file',
    input.systemPromptFile,
    '--model',
    input.model,
    '--effort',
    input.effort ?? 'medium',
    '--max-turns',
    String(input.maxTurns ?? 5),
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--include-hook-events',
    '--json-schema',
    JSON.stringify(input.jsonSchema),
  ];
  if (input.fallbackModel !== undefined && input.fallbackModel !== input.model) {
    args.push('--fallback-model', input.fallbackModel);
  }
  return args;
}

export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
}

/** Одна NDJSON-строка user-сообщения для stdin. */
export function buildStdinMessage(text: string, images: ImageInput[] = []): string {
  const content: unknown[] = [{ type: 'text', text }];
  for (const image of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
    });
  }
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })}\n`;
}
