import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Fixed names in macOS Keychain or the private Linux credentials directory. Never log values or put them in env. */
export const KEYCHAIN = { kie: 'kie-api-key', higgsfield: 'higgsfield-api-key' } as const;

/** Чем должно быть значение: запись с текстом команды вместо ключа (27.09 так и вышло через `$(pbpaste)`) ловится сразу. */
export const KEY_FORMAT: Record<keyof typeof KEYCHAIN, { re: RegExp; hintRu: string }> = {
  kie: { re: /^[A-Za-z0-9_-]{8,}$/, hintRu: 'ключ KIE — одна строка из букв и цифр, без пробелов' },
  higgsfield: { re: /^[^\s:]+:[^\s:]+$/, hintRu: 'ключ Higgsfield — KEY_ID:KEY_SECRET через двоеточие, без пробелов' },
};

// Кеш на минуту: ключ, исправленный в Keychain, подхватывается без перезапуска сервера.
const TTL_MS = 60_000;
const cache = new Map<string, { value: string; at: number }>();

/** Значение записи или null, если её нет. */
export function readSecret(name: string): string | null {
  if (!Object.values(KEYCHAIN).some((entry) => entry === name)) return null;
  const directory = process.env.CREDENTIALS_DIRECTORY;
  const cacheKey = `${directory ?? 'keychain'}:${name}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    if (directory !== undefined) {
      const file = path.join(directory, name);
      const stat = statSync(file);
      const ownUid = process.getuid?.();
      const ownGid = process.getgid?.();
      const groupReadable = (stat.mode & 0o040) !== 0;
      if (!stat.isFile() || (stat.mode & 0o037) !== 0 || (stat.uid !== 0 && stat.uid !== ownUid) || (groupReadable && stat.gid !== ownGid)) return null;
      const value = readFileSync(file, 'utf8').trim();
      if (!value) return null;
      cache.set(cacheKey, { value, at: Date.now() });
      return value;
    }
    if (process.platform !== 'darwin') return null;
    const value = execFileSync('/usr/bin/security', ['find-generic-password', '-s', name, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (value === '') return null;
    cache.set(cacheKey, { value, at: Date.now() });
    return value;
  } catch {
    cache.delete(cacheKey);
    return null;
  }
}

/** null — ключ есть и похож на ключ; иначе — что с ним не так (без значения). */
export function keyProblem(provider: keyof typeof KEYCHAIN, value: string | null): string | null {
  if (value === null || value === '') return `нет записи «${KEYCHAIN[provider]}» в хранилище ключей`;
  return KEY_FORMAT[provider].re.test(value) ? null : `в записи «${KEYCHAIN[provider]}» не ключ: ${KEY_FORMAT[provider].hintRu}`;
}
