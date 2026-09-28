import { execFileSync } from 'node:child_process';

/** Имена записей macOS Keychain. Значения не пишутся в файлы, логи и `process.env` (его наследует `claude -p`). */
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
  const hit = cache.get(name);
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.value;
  if (process.platform !== 'darwin') return null;
  try {
    const value = execFileSync('/usr/bin/security', ['find-generic-password', '-s', name, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (value === '') return null;
    cache.set(name, { value, at: Date.now() });
    return value;
  } catch {
    cache.delete(name);
    return null;
  }
}

/** null — ключ есть и похож на ключ; иначе — что с ним не так (без значения). */
export function keyProblem(provider: keyof typeof KEYCHAIN, value: string | null): string | null {
  if (value === null || value === '') return `нет записи «${KEYCHAIN[provider]}» в Keychain`;
  return KEY_FORMAT[provider].re.test(value) ? null : `в записи «${KEYCHAIN[provider]}» не ключ: ${KEY_FORMAT[provider].hintRu}`;
}
