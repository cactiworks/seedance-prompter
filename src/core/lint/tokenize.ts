import type { Paragraph } from './types.ts';

export type DialogueWrap = 'guillemets' | 'braces';

/** Реплика в тексте промпта зависит от диалекта: «ёлочки» гайда или {фигурные скобки} ByteDance. */
export function lineRegex(wrap: DialogueWrap): RegExp {
  // Одинарные скобки, но не плейсхолдер {{…}}.
  return wrap === 'braces' ? /(?<!\{)\{[^{}]+\}(?!\})/g : /«[^»]*»/g;
}

/** Символ-заглушка: не буква, не пробел и не знак конца предложения. */
export const MASK = '¤';

/** Реплики заменяются заглушкой той же длины — правила для английского текста их не видят, позиции совпадают. */
export function maskLines(text: string, wrap: DialogueWrap = 'guillemets'): string {
  return text.replace(lineRegex(wrap), (match) => MASK.repeat(match.length));
}

export function splitSentences(text: string): { text: string; from: number; to: number }[] {
  const sentences: { text: string; from: number; to: number }[] = [];
  const re = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const from = (match.index ?? 0) + lead;
    sentences.push({ text: trimmed, from, to: from + trimmed.length });
  }
  return sentences;
}

export function toParagraphs(raw: string, wrap: DialogueWrap = 'guillemets'): Paragraph[] {
  return raw
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .map((text, index) => {
      const masked = maskLines(text, wrap);
      // Реплика заканчивает предложение: последний символ заглушки читается как точка (длина сохраняется).
      const forSplit = masked.replace(new RegExp(`${MASK}+`, 'g'), (run) => `${run.slice(0, -1)}.`);
      return { index, text, masked, sentences: splitSentences(forSplit) };
    });
}

export function extractLines(paragraphs: Paragraph[], wrap: DialogueWrap = 'guillemets'): { text: string; paragraph: number; from: number }[] {
  const lines: { text: string; paragraph: number; from: number }[] = [];
  for (const paragraph of paragraphs) {
    for (const match of paragraph.text.matchAll(lineRegex(wrap))) {
      lines.push({ text: match[0].slice(1, -1), paragraph: paragraph.index, from: match.index ?? 0 });
    }
  }
  return lines;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\d]/u.test(word)).length;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Регулярка «любое из слов словаря» с границами слова. */
export function anyOf(words: string[], flags = 'i'): RegExp {
  const body = [...words].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  return new RegExp(`(?<![\\p{L}\\d])(?:${body})(?![\\p{L}\\d])`, flags.includes('u') ? flags : `${flags}u`);
}

export function includesAny(text: string, phrases: string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase.toLowerCase()));
}
