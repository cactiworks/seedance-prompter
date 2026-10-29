import { useSyncExternalStore } from 'react';
import messages from './messages.en.json';

export type LanguageChoice = 'ru' | 'en';
export const LANGUAGE_KEY = 'sp-language';
const translations: Readonly<Record<string, string>> = messages;
let current: LanguageChoice | undefined;
const listeners = new Set<() => void>();

export function readLanguage(): LanguageChoice {
  try { return window.localStorage.getItem(LANGUAGE_KEY) === 'en' ? 'en' : 'ru'; }
  catch { return 'ru'; }
}
export function getLanguage(): LanguageChoice { return current ??= readLanguage(); }
export function applyLanguage(language: LanguageChoice): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.documentElement.dataset.language = language;
}
export function setLanguage(language: LanguageChoice): void {
  current = language;
  try { window.localStorage.setItem(LANGUAGE_KEY, language); } catch { /* in-memory choice still works */ }
  applyLanguage(language);
  for (const listener of listeners) listener();
}
const storageChange = (event: StorageEvent): void => {
  if (event.key !== LANGUAGE_KEY && event.key !== null) return;
  current = readLanguage(); applyLanguage(current);
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  if (!listeners.size) window.addEventListener('storage', storageChange);
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', storageChange); };
};
/** Shared browser preference. Switching never changes project data or invokes an agent. */
export function useLanguage(): [LanguageChoice, typeof setLanguage] {
  return [useSyncExternalStore(subscribe, getLanguage, () => 'ru'), setLanguage];
}
/** Explicit UI-copy boundary: callers must never pass user content or generated prompts. */
export function ui(source: string, ...values: unknown[]): string;
export function ui(source: string | undefined, ...values: unknown[]): string | undefined;
export function ui(source: string | undefined, ...values: unknown[]): string | undefined {
  if (source === undefined) return undefined;
  let text = source;
  if (getLanguage() === 'en') {
    const key = Object.hasOwn(translations, source) ? source : source.trim();
    const translated = Object.hasOwn(translations, key) ? translations[key] : undefined;
    if (translated !== undefined) text = (source.match(/^\s*/)?.[0] ?? '') + translated.trim() + (source.match(/\s*$/)?.[0] ?? '');
  }
  return text.replace(/\{(\d+)\}/g, (placeholder, index: string) => Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}
