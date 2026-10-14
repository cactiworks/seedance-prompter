/** Keep saved Codex authentication; discard API keys, inherited agent sessions and hooks. */
const ALLOWED = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME'] as const;

export function buildChildEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: '1' };
  for (const key of ALLOWED) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  return env;
}

export function leakedKeys(parent: NodeJS.ProcessEnv): string[] {
  return Object.keys(parent).filter((key) =>
    /^(?:OPENAI_|ANTHROPIC_|CLAUDE|CODEX_)/.test(key) && key !== 'CODEX_HOME',
  );
}
