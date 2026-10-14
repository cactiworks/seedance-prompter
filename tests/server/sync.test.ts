import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishRepository, revision, updateRepository } from '../../scripts/sync.ts';

const temporary: string[] = [];
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sp-sync-test-'));
  temporary.push(root);
  const remote = path.join(root, 'origin.git');
  const source = path.join(root, 'source');
  const replica = path.join(root, 'replica');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, source);
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'config', 'core.hooksPath', '/dev/null');
  writeFileSync(path.join(source, '.gitignore'), 'data/\nnode_modules/\n');
  writeFileSync(path.join(source, 'app.txt'), 'v1');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'v1');
  git(source, 'push', 'origin', 'main');
  git(root, 'clone', remote, replica);
  git(replica, 'config', 'user.name', 'Test');
  git(replica, 'config', 'user.email', 'test@example.invalid');
  git(replica, 'config', 'core.hooksPath', '/dev/null');
  const change = (directory = source, text = 'v2') => {
    writeFileSync(path.join(directory, 'app.txt'), text);
    git(directory, 'add', 'app.txt');
    git(directory, 'commit', '-m', text);
  };
  return { root, remote, source, replica, change };
}
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('синхронизация кода двух Mac без внешней сети', () => {
  it('получает main только fast-forward, сохраняет локальные данные, повтор ничего не меняет', () => {
    const { source, replica, remote, change } = fixture();
    mkdirSync(path.join(replica, 'data'));
    writeFileSync(path.join(replica, 'data', 'private.txt'), 'local only');
    change();
    git(source, 'push', 'origin', 'main');
    expect(updateRepository(replica, remote)).toEqual({ updated: true, revision: revision(source) });
    expect(readFileSync(path.join(replica, 'app.txt'), 'utf8')).toBe('v2');
    expect(readFileSync(path.join(replica, 'data', 'private.txt'), 'utf8')).toBe('local only');
    expect(updateRepository(replica, remote).updated).toBe(false);
  });
  it.each(['modified', 'staged', 'untracked'])('не трогает локальную работу: %s', (kind) => {
    const { source, replica, remote, change } = fixture();
    change();
    git(source, 'push', 'origin', 'main');
    const file = kind === 'untracked' ? 'draft.txt' : 'app.txt';
    writeFileSync(path.join(replica, file), 'my work');
    if (kind === 'staged') git(replica, 'add', file);
    const before = revision(replica);
    expect(() => updateRepository(replica, remote)).toThrow('локальные изменения');
    expect(revision(replica)).toBe(before);
    expect(readFileSync(path.join(replica, file), 'utf8')).toBe('my work');
  });
  it.each([false, true])('сохраняет неопубликованный commit; divergence=%s', (diverged) => {
    const { source, replica, remote, change } = fixture();
    change(replica, 'replica work');
    if (diverged) { change(source); git(source, 'push', 'origin', 'main'); }
    const before = revision(replica);
    expect(() => updateRepository(replica, remote)).toThrow('неопубликованные');
    expect(revision(replica)).toBe(before);
  });
  it('не обновляет чужой remote, другую ветку и ZIP внутри чужого репозитория', () => {
    const { replica, remote } = fixture();
    expect(() => updateRepository(replica, `${remote}-other`)).toThrow('origin');
    git(replica, 'switch', '-c', 'feature');
    expect(() => updateRepository(replica, remote)).toThrow('только в main');
    const zip = path.join(replica, 'zip');
    mkdirSync(zip);
    expect(() => updateRepository(zip, remote)).toThrow('корнем своего');
  });
  it('при недоступном remote сохраняет HEAD', () => {
    const { replica, root } = fixture();
    const missing = path.join(root, 'unavailable.git');
    git(replica, 'remote', 'set-url', 'origin', missing);
    const before = revision(replica);
    expect(() => updateRepository(replica, missing)).toThrow('GitHub недоступен');
    expect(revision(replica)).toBe(before);
  });
  it('публикует только с основного Mac и подтверждает remote HEAD', () => {
    const { source, replica, remote, change } = fixture();
    change();
    expect(() => publishRepository(source, remote)).toThrow('основном Mac');
    git(source, 'config', '--local', 'seedance.syncRole', 'source');
    expect(publishRepository(source, remote)).toBe(revision(source));
    expect(updateRepository(replica, remote).revision).toBe(revision(source));
    expect(() => publishRepository(replica, remote)).toThrow('основном Mac');
  });
  it('не перезаписывает чужой commit на GitHub при публикации', () => {
    const { source, replica, remote, change } = fixture();
    git(source, 'config', '--local', 'seedance.syncRole', 'source');
    change(source, 'source work');
    change(replica, 'remote work');
    git(replica, 'push', 'origin', 'main');
    expect(() => publishRepository(source, remote)).toThrow('другие изменения');
    expect(git(source, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0]).toBe(revision(replica));
  });
});
