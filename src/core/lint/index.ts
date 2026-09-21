import type { Finding, Lexicon, LintParams, RefSyntax, TextLintContext, TextRule } from './types.ts';
import { extractLines, toParagraphs, type DialogueWrap } from './tokenize.ts';
import * as hygiene from './rules/hygiene.ts';
import * as refs from './rules/refs.ts';
import * as operator from './rules/operator.ts';
import * as content from './rules/content.ts';

export type { Finding, Lexicon, LintParams, RefSyntax, Severity, RuleFamily } from './types.ts';

export const TEXT_RULES: TextRule[] = [
  ...Object.values(hygiene),
  ...Object.values(refs),
  ...Object.values(operator),
  ...Object.values(content),
];

export interface LintTextOptions {
  lexicon: Lexicon;
  params: LintParams;
  refSyntax?: RefSyntax;
  /** Как в тексте оформлены реплики: от этого зависит, что линтер считает русской речью, а что мусором. */
  dialogueWrap?: DialogueWrap;
  panelSize?: number | null;
  durationSec?: number;
  /** Отпечатки подавленных находок («осознанное исключение»). */
  suppressed?: Iterable<string>;
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

function fingerprint(ruleId: string, evidence: string): string {
  return `${ruleId}:${evidence.toLowerCase().replace(/<<<image_\d+>>>/g, '<ref>').replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}

/** Линт готового текста промпта — для вставленных промптов и golden-тестов на промптах гайда. */
export function lintText(raw: string, options: LintTextOptions): Finding[] {
  const wrap = options.dialogueWrap ?? 'guillemets';
  const paragraphs = toParagraphs(raw, wrap);
  const boundary = paragraphs.findIndex((p) => /^(?:Location:|The camera is handheld)/u.test(p.text));
  const styleZone = paragraphs.slice(0, boundary === -1 ? 1 : Math.max(1, boundary));

  const ctx: TextLintContext = {
    raw: paragraphs.map((p) => p.masked).join('\n'),
    paragraphs,
    styleZone,
    lines: extractLines(paragraphs, wrap),
    refSyntax: options.refSyntax ?? 'higgsfield-chip',
    panelSize: options.panelSize ?? null,
    durationSec: options.durationSec ?? options.params.duration.defaultSec,
    lexicon: options.lexicon,
    params: options.params,
  };

  const suppressed = new Set(options.suppressed ?? []);
  const findings: Finding[] = [];
  for (const rule of TEXT_RULES) {
    for (const draft of rule.run(ctx)) {
      const finding: Finding = { ...draft, family: rule.family, fingerprint: fingerprint(draft.ruleId, draft.evidence) };
      if (!suppressed.has(finding.fingerprint)) findings.push(finding);
    }
  }
  return findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.paragraph ?? -1) - (b.paragraph ?? -1) || (a.range?.from ?? 0) - (b.range?.from ?? 0),
  );
}
