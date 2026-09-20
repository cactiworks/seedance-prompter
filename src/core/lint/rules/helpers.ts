import type { Finding, Paragraph, Severity } from '../types.ts';

export type Draft = Omit<Finding, 'fingerprint' | 'family'>;

export function at(
  ruleId: string,
  severity: Severity,
  paragraph: Paragraph | null,
  match: { index: number; text: string } | null,
  messageRu: string,
  fixHintRu: string,
): Draft {
  return {
    ruleId,
    severity,
    messageRu,
    fixHintRu,
    paragraph: paragraph?.index ?? null,
    range: match === null ? null : { from: match.index, to: match.index + match.text.length },
    evidence: match?.text ?? '',
  };
}

/** Все совпадения регулярки в замаскированном тексте абзаца. */
export function matches(paragraph: Paragraph, re: RegExp): { index: number; text: string }[] {
  const global = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  return [...paragraph.masked.matchAll(global)].map((m) => ({ index: m.index ?? 0, text: m[0] }));
}
