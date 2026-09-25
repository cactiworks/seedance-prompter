import { findMalformed, findPlaceholders, type PlaceholderType } from './placeholders.ts';

export type RefSyntax = 'higgsfield-chip' | 'at-image';
export type DialogueWrap = 'guillemets' | 'braces';

export interface Dialect {
  refSyntax: RefSyntax;
  dialogueWrap: DialogueWrap;
}

export interface DialectPack {
  refSyntax: Record<RefSyntax, { template: string }>;
  dialogueWrap: Record<DialogueWrap, { template: string }>;
  intro: { character: string; object: string; studioBackdropClause: string };
  languageNames: Record<string, string>;
  /** Как формат кадра называется в формуле формата: «Vertical 9:16», «Horizontal 16:9». */
  aspect?: { phrases: Record<string, string>; labelsRu: Record<string, string> };
}

export interface ResolveEntity {
  /** Имя в прозе: «Alexander», «the main pickup». */
  name: string;
  kind: 'character' | 'object';
  /** Ключ референса в панели; у сущности без референса intro разворачивается просто в имя. */
  refKey?: string;
  studioBackdrop?: boolean;
}

export interface ResolveContext {
  /** Ключи референсов в порядке панели ЭТОГО кадра. Порядок = нумерация. */
  panel: string[];
  lines: Record<string, { ru: string }>;
  entities: Record<string, ResolveEntity>;
  /** Канонические английские предложения состояний (сторона, степень, ограничитель). */
  states: Record<string, string>;
  dialect: Dialect;
  /** Код языка реплик: 'ru'. */
  language: string;
  pack: DialectPack;
}

export interface ResolveIssue {
  code: 'UNKNOWN_REF' | 'REF_NOT_IN_PANEL' | 'UNKNOWN_LINE' | 'UNKNOWN_ENTITY' | 'UNKNOWN_STATE' | 'MALFORMED';
  placeholder: string;
  from: number;
  messageRu: string;
}

export interface ResolveResult {
  text: string;
  issues: ResolveIssue[];
  /** Карта позиций: диапазон в исходном тексте → диапазон в развёрнутом. Нужна линтеру и подсветке. */
  map: { type: PlaceholderType; id: string; source: [number, number]; target: [number, number] }[];
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Z]+)\}/g, (whole, key: string) => values[key] ?? whole);
}

export function refToken(ctx: ResolveContext, refKey: string): string | null {
  const index = ctx.panel.indexOf(refKey);
  if (index === -1) return null;
  return fill(ctx.pack.refSyntax[ctx.dialect.refSyntax].template, { N: String(index + 1) });
}

/**
 * Разворачивает плейсхолдеры. Неизвестный плейсхолдер НЕ удаляется и не заменяется пустотой —
 * он остаётся в тексте и попадает в issues: молчаливое удаление рождает «висящий from» из гайда.
 */
export function resolve(source: string, ctx: ResolveContext): ResolveResult {
  const issues: ResolveIssue[] = [];
  const map: ResolveResult['map'] = [];
  for (const bad of findMalformed(source)) {
    issues.push({ code: 'MALFORMED', placeholder: bad.raw, from: bad.from, messageRu: `Плейсхолдер вне грамматики: ${bad.raw}` });
  }

  let out = '';
  let cursor = 0;
  for (const p of findPlaceholders(source)) {
    out += source.slice(cursor, p.from);
    cursor = p.to;
    let expansion: string | null = null;

    if (p.type === 'ref') {
      expansion = refToken(ctx, p.id);
      if (expansion === null) issues.push({ code: 'REF_NOT_IN_PANEL', placeholder: p.raw, from: p.from, messageRu: `Референс «${p.id}» не в панели этого кадра.` });
    } else if (p.type === 'line') {
      const line = ctx.lines[p.id];
      if (line === undefined) {
        issues.push({ code: 'UNKNOWN_LINE', placeholder: p.raw, from: p.from, messageRu: `Нет реплики ${p.id}.` });
      } else {
        const language = ctx.pack.languageNames[ctx.language] ?? ctx.language;
        expansion = fill(ctx.pack.dialogueWrap[ctx.dialect.dialogueWrap].template, { LANG: language, TEXT: line.ru });
      }
    } else if (p.type === 'intro') {
      const entity = ctx.entities[p.id];
      if (entity === undefined) {
        issues.push({ code: 'UNKNOWN_ENTITY', placeholder: p.raw, from: p.from, messageRu: `Нет сущности «${p.id}».` });
      } else if (entity.refKey === undefined) {
        expansion = entity.name;
      } else {
        const token = refToken(ctx, entity.refKey);
        if (token === null) {
          issues.push({ code: 'REF_NOT_IN_PANEL', placeholder: p.raw, from: p.from, messageRu: `Референс сущности «${entity.name}» не добавлен в панель этого кадра.` });
        } else {
          const template = entity.kind === 'character' ? ctx.pack.intro.character : ctx.pack.intro.object;
          expansion = fill(template, { NAME: entity.name, REF: token });
          if (entity.studioBackdrop === true) expansion += fill(ctx.pack.intro.studioBackdropClause, { REF: token });
        }
      }
    } else {
      const state = ctx.states[p.id];
      if (state === undefined) issues.push({ code: 'UNKNOWN_STATE', placeholder: p.raw, from: p.from, messageRu: `Нет состояния ${p.id}.` });
      else expansion = state;
    }

    const text = expansion ?? p.raw;
    map.push({ type: p.type, id: p.id, source: [p.from, p.to], target: [out.length, out.length + text.length] });
    out += text;
  }
  out += source.slice(cursor);
  return { text: out, issues, map };
}
