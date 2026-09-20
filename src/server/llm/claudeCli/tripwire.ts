/** Проверка изоляции по событию `system/init`. Срабатывает на каждом вызове, не только в doctor. */

export interface InitEvent {
  tools?: string[];
  mcp_servers?: unknown[];
  plugins?: unknown[];
  skills?: string[];
  slash_commands?: string[];
  apiKeySource?: string;
  model?: string;
  claude_code_version?: string;
}

const ALLOWED_TOOLS = new Set(['StructuredOutput']);

export function checkIsolation(init: InitEvent): string[] {
  const violations: string[] = [];
  const extraTools = (init.tools ?? []).filter((tool) => !ALLOWED_TOOLS.has(tool));
  if (extraTools.length > 0) violations.push(`лишние инструменты: ${extraTools.join(', ')}`);
  if ((init.mcp_servers ?? []).length > 0) violations.push(`подключены MCP-серверы: ${JSON.stringify(init.mcp_servers)}`);
  // Поле `plugins` не проверяем: под --safe-mode CLI лишь перечисляет установленные плагины,
  // но не грузит их skills, команды и хуки (проверено doctor: hook-событий 0, skills пусты).
  if ((init.skills ?? []).length > 0) violations.push(`загружены skills: ${(init.skills ?? []).slice(0, 8).join(', ')}`);
  if ((init.slash_commands ?? []).length > 0) {
    violations.push(`доступны slash-команды: ${(init.slash_commands ?? []).slice(0, 8).join(', ')}`);
  }
  if (init.apiKeySource !== undefined && init.apiKeySource !== 'none') {
    violations.push(`биллинг идёт не по подписке: apiKeySource=${init.apiKeySource}`);
  }
  return violations;
}
