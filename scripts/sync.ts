import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'https://github.com/cactiworks/seedance-prompter.git';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(root: string, args: string[], timeout = 30_000): string {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

export function syncRole(root: string): string {
  try { return git(root, ['config', '--local', '--get', 'seedance.syncRole']); }
  catch { return ''; }
}

export function revision(root: string): string | null {
  try { return git(root, ['rev-parse', 'HEAD']); }
  catch { return null; }
}

function assertRepository(root: string, expectedOrigin: string): void {
  let top: string;
  try { top = git(root, ['rev-parse', '--show-toplevel']); }
  catch { throw new Error('Это ZIP-копия, без Git. Установи проект через git clone по README.'); }
  if (realpathSync(top) !== realpathSync(root)) throw new Error('Папка приложения должна быть корнем своего Git clone.');
  const origins = git(root, ['remote', 'get-url', '--all', 'origin']).split('\n');
  const pushOrigins = git(root, ['remote', 'get-url', '--push', '--all', 'origin']).split('\n');
  const allowed = expectedOrigin === ORIGIN
    ? [ORIGIN, ORIGIN.replace(/\.git$/, ''), 'git@github.com:cactiworks/seedance-prompter.git']
    : [expectedOrigin];
  if ([...origins, ...pushOrigins].some((url) => !allowed.includes(url))) {
    throw new Error('origin не совпадает с репозиторием приложения. Автосинхронизация остановлена.');
  }
  if (git(root, ['branch', '--show-current']) !== 'main') throw new Error('Автосинхронизация работает только в main. Текущая ветка сохранена.');
  if (git(root, ['status', '--porcelain']) !== '') throw new Error('Есть локальные изменения. Сохрани их с Codex; обновление не перезаписывает файлы.');
}

function fetchMain(root: string): void {
  git(root, ['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
}

function ancestor(root: string, older: string, newer: string): boolean {
  try { git(root, ['merge-base', '--is-ancestor', older, newer]); return true; }
  catch { return false; }
}

export function updateRepository(root: string, expectedOrigin = ORIGIN): { updated: boolean; revision: string } {
  assertRepository(root, expectedOrigin);
  try { fetchMain(root); }
  catch { throw new Error('GitHub недоступен или нет доступа. Обновление не выполнено; локальные файлы сохранены.'); }
  const before = git(root, ['rev-parse', 'HEAD']);
  const remote = git(root, ['rev-parse', 'origin/main']);
  if (before === remote) return { updated: false, revision: before };
  if (!ancestor(root, before, remote)) {
    throw new Error('Есть неопубликованные коммиты или ветки разошлись. Попроси Codex проверить Git; автоматического reset/rebase нет.');
  }
  // Повторная проверка после сети: не забираем правки, появившиеся за время fetch.
  assertRepository(root, expectedOrigin);
  git(root, ['merge', '--ff-only', remote]);
  return { updated: true, revision: git(root, ['rev-parse', 'HEAD']) };
}

export function publishRepository(root: string, expectedOrigin = ORIGIN): string {
  if (syncRole(root) !== 'source') throw new Error('Публикация включена только на основном Mac: npm run sync:source.');
  assertRepository(root, expectedOrigin);
  fetchMain(root);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (!ancestor(root, git(root, ['rev-parse', 'origin/main']), head)) {
    throw new Error('GitHub содержит другие изменения. Разбери их с Codex; force-push не выполняется.');
  }
  assertRepository(root, expectedOrigin);
  git(root, ['push', 'origin', `${head}:refs/heads/main`], 60_000);
  const remote = git(root, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
  if (remote !== head) throw new Error('Не удалось подтвердить опубликованную версию. Проверь npm run sync:status.');
  return head;
}

function configure(role: 'source' | 'replica'): void {
  // Настройка допускает незакоммиченные изменения, но не чужую/вложенную папку.
  if (realpathSync(git(ROOT, ['rev-parse', '--show-toplevel'])) !== realpathSync(ROOT)) {
    throw new Error('Сначала установи проект через git clone.');
  }
  const hooks = (() => { try { return git(ROOT, ['config', '--get', 'core.hooksPath']); } catch { return ''; } })();
  if (hooks !== '' && hooks !== '.githooks') throw new Error('Настроены другие Git hooks. Попроси Codex согласовать их перед включением синхронизации.');
  git(ROOT, ['config', '--local', 'core.hooksPath', '.githooks']);
  git(ROOT, ['config', '--local', 'seedance.syncRole', role]);
  console.log(role === 'source'
    ? 'Основной Mac: commit в main после проверок автоматически отправляется на GitHub.'
    : 'Второй Mac: обновление из GitHub перед запуском. Автопубликация выключена.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2];
    if (action === 'source' || action === 'replica') configure(action);
    else if (action === 'update') {
      const result = updateRepository(ROOT);
      console.log(`${result.updated ? 'Обновлено' : 'Актуально'}: ${result.revision.slice(0, 7)}`);
    } else if (action === 'publish') {
      console.log(`GitHub подтверждён: ${publishRepository(ROOT).slice(0, 7)}`);
    } else if (action === 'status') {
      console.log(`Режим: ${syncRole(ROOT) || 'не настроен'}; локальная версия: ${revision(ROOT) ?? 'ZIP'}`);
      console.log(git(ROOT, ['status', '--short', '--branch']));
      console.log(`GitHub main: ${git(ROOT, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0]}`);
    } else throw new Error('Команды: source, replica, update, publish, status.');
  } catch (error) {
    console.error(error instanceof Error && !('stderr' in error) ? error.message : 'Git не завершил синхронизацию. Проверь сеть и вход GitHub; локальные файлы сохранены.');
    process.exitCode = 1;
  }
}
