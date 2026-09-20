/**
 * Окружение дочернего процесса — по allowlist, а не наследованием.
 * `ANTHROPIC_API_KEY` в env в режиме `-p` используется всегда и молча уводит биллинг на API;
 * `CLAUDECODE` / `CLAUDE_CODE_SESSION_ID` протекают, если сервер запущен из сессии Claude Code.
 */
const ALLOWED = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

const FORCED: Record<string, string> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  DISABLE_AUTOUPDATER: '1',
  NO_COLOR: '1',
};

export function buildChildEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...FORCED };
}

/** Для тестов и doctor: какие опасные переменные были бы унаследованы без allowlist. */
export function leakedKeys(parent: NodeJS.ProcessEnv): string[] {
  return Object.keys(parent).filter(
    (key) => key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_') || key === 'CLAUDECODE' || key === 'CLAUDE_CODE_SESSION_ID',
  );
}
