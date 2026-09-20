import { placeholder } from '../compile/placeholders.ts';
import type { DialectPack, Dialect } from '../compile/dialect.ts';

export interface ParsedPrompt {
  /** Абзацы в плейсхолдерной форме. */
  paragraphs: string[];
  /** Ключи референсов в порядке панели: r1…rN. */
  panel: string[];
  lines: Record<string, { ru: string }>;
  /** Что не удалось привести к плейсхолдерам — остаётся сырым и будет поймано линтером. */
  leftovers: { kind: 'foreign-ref' | 'bare-line'; text: string; paragraph: number }[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Сырой текст промпта → плейсхолдерная форма. Нужен для импорта готовых промптов, для фикстур гайда и
 * для проверки обратимости: resolve(parsePrompt(raw)) обязан вернуть raw байт в байт.
 */
export function parsePrompt(raw: string, options: { panelSize: number; dialect: Dialect; language: string; pack: DialectPack }): ParsedPrompt {
  const { pack, dialect } = options;
  const panel = Array.from({ length: options.panelSize }, (_, i) => `r${i + 1}`);
  const lines: ParsedPrompt['lines'] = {};
  const leftovers: ParsedPrompt['leftovers'] = [];

  const refTemplate = pack.refSyntax[dialect.refSyntax].template;
  const refRe = new RegExp(escapeRegExp(refTemplate).replace('\\{N\\}', '(\\d+)'), 'g');
  const foreignSyntax = dialect.refSyntax === 'higgsfield-chip' ? /@image\s?_?\d+/gi : /<<<image_\d+>>>/g;

  const language = pack.languageNames[options.language] ?? options.language;
  const wrap = pack.dialogueWrap[dialect.dialogueWrap].template.replace('{LANG}', language);
  const [head = '', tail = ''] = wrap.split('{TEXT}');
  const lineRe = new RegExp(`${escapeRegExp(head)}([^»}]*)${escapeRegExp(tail)}`, 'g');

  let counter = 0;
  const paragraphs = raw
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((paragraph, index) => {
      let text = paragraph.replace(lineRe, (_whole, ru: string) => {
        counter += 1;
        const id = `L${counter}`;
        lines[id] = { ru };
        return placeholder('line', id);
      });
      text = text.replace(refRe, (whole, n: string) => {
        const key = panel[Number(n) - 1];
        return key === undefined ? whole : placeholder('ref', key);
      });
      for (const m of text.matchAll(foreignSyntax)) leftovers.push({ kind: 'foreign-ref', text: m[0], paragraph: index });
      for (const m of text.matchAll(/«[^»]*»/g)) leftovers.push({ kind: 'bare-line', text: m[0], paragraph: index });
      return text;
    });

  return { paragraphs, panel, lines, leftovers };
}
