import { spawn } from 'node:child_process';
import { buildChildEnv } from '../llm/codexCli/env.ts';

export type ApiLogin = (home: string, apiKey: string, signal: AbortSignal) => Promise<void>;

/** Official CLI credential import, with the secret only on stdin. No inference or raw output. */
export const apiLogin: ApiLogin = (home, apiKey, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('Подключение отменено.')); return; }
  const child = spawn('codex', ['login', '--with-api-key', '-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="api"'], {
    cwd: home, env: buildChildEnv({ ...process.env, CODEX_HOME: home }),
    shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore'],
  });
  const stop = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* already exited */ }
  };
  signal.addEventListener('abort', stop, { once:true });
  if (signal.aborted) stop();
  child.stdin.on('error', () => { /* reported by process close */ });
  child.on('error', () => { signal.removeEventListener('abort', stop); reject(new Error('Не удалось сохранить API-подключение. Проверь установку Codex CLI.')); });
  child.on('close', code => {
    signal.removeEventListener('abort', stop);
    if (code === 0 && !signal.aborted) resolve();
    else reject(new Error('Не удалось сохранить API-подключение. Попробуй ещё раз.'));
  });
  child.stdin.end(`${apiKey}\n`);
});
