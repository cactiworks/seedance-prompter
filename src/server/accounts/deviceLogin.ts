import { spawn } from 'node:child_process';
import { buildChildEnv } from '../llm/codexCli/env.ts';

export type DeviceCode = { url: string; code: string };
export type DeviceLogin = (home: string, onCode: (code: DeviceCode) => void, signal: AbortSignal) => Promise<void>;

/** Only the official device page and code may leave the child process output. */
export function parseDeviceCode(output: string): DeviceCode | undefined {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  const url = plain.match(/https:\/\/auth\.openai\.com\/codex\/device\b/)?.[0];
  const code = plain.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0];
  return url && code ? { url, code } : undefined;
}

export const deviceLogin: DeviceLogin = (home, onCode, signal) => new Promise((resolve, reject) => {
  const child = spawn('codex', ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'], {
    cwd: home, env: buildChildEnv({ ...process.env, CODEX_HOME: home }),
    shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* already exited */ }
  };
  let output = '';
  const consume = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-16_384);
    const code = parseDeviceCode(output);
    if (code) onCode(code);
  };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  child.on('error', () => { signal.removeEventListener('abort', stop); reject(new Error('Не удалось запустить вход Codex.')); });
  child.on('close', code => {
    signal.removeEventListener('abort', stop);
    if (code === 0 && !signal.aborted) resolve();
    else reject(new Error('Вход не завершён. Повтори подключение. Если OpenAI отклонил device login, разреши его в настройках безопасности ChatGPT.'));
  });
});
