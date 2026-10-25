export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Exact, owner-configured targets. Browser input cannot turn the studio into a network proxy. */
export function apiBaseUrl(value: unknown, allowed: readonly string[]): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : OPENAI_BASE_URL;
  const url = new URL(text);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\s\\]/.test(text) || text.length > 1024) throw new Error('Invalid API URL');
  const normalized = url.href.replace(/\/+$/, '');
  if (![OPENAI_BASE_URL, ...allowed.map(s => s.replace(/\/+$/, ''))].includes(normalized)) throw new Error('API URL not allowed');
  return normalized;
}
