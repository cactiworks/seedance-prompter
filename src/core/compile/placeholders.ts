/**
 * Закрытая грамматика плейсхолдеров `{{type:id}}`.
 * Номера ссылок, реплики, языковую фразу и канонические фразы состояний не пишет ни человек, ни LLM:
 * в тексте стоит плейсхолдер, компилятор разворачивает его по порядку панели кадра и диалекту проекта.
 */
export const PLACEHOLDER_TYPES = ['intro', 'ref', 'line', 'state'] as const;
export type PlaceholderType = (typeof PLACEHOLDER_TYPES)[number];

export interface Placeholder {
  type: PlaceholderType;
  id: string;
  from: number;
  to: number;
  raw: string;
}

const WELL_FORMED = /\{\{(intro|ref|line|state):([A-Za-z0-9_-]+)\}\}/g;
const ANY_BRACES = /\{\{[^}]*\}\}/g;

export function findPlaceholders(text: string): Placeholder[] {
  return [...text.matchAll(WELL_FORMED)].map((m) => ({
    type: m[1] as PlaceholderType,
    id: m[2] ?? '',
    from: m.index ?? 0,
    to: (m.index ?? 0) + m[0].length,
    raw: m[0],
  }));
}

/** Всё, что похоже на плейсхолдер, но не проходит грамматику: `{{ref: alexander}}`, `{{image:1}}`. */
export function findMalformed(text: string): { raw: string; from: number }[] {
  const good = new Set(findPlaceholders(text).map((p) => p.from));
  return [...text.matchAll(ANY_BRACES)].filter((m) => !good.has(m.index ?? 0)).map((m) => ({ raw: m[0], from: m.index ?? 0 }));
}

export function placeholder(type: PlaceholderType, id: string): string {
  return `{{${type}:${id}}}`;
}
