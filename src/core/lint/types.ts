export type Severity = 'error' | 'warning' | 'info';

export type RuleFamily =
  | 'style'
  | 'operator'
  | 'refs'
  | 'budget'
  | 'lines'
  | 'hygiene'
  | 'showable'
  | 'light'
  | 'finale'
  | 'continuity'
  | 'roles'
  | 'risk'
  | 'platform';

export type RefSyntax = 'higgsfield-chip' | 'at-image';

export interface Finding {
  ruleId: string;
  family: RuleFamily;
  severity: Severity;
  messageRu: string;
  /** Индекс абзаца в промпте (0-based). Абзац = отрезок времени. */
  paragraph: number | null;
  /** Диапазон внутри текста абзаца. */
  range: { from: number; to: number } | null;
  /** Фрагмент текста, на котором сработало правило. */
  evidence: string;
  /** Что сделать; ссылка на приём гайда, если есть. */
  fixHintRu: string;
  /** Стабильный отпечаток для suppress: переживает сдвиги текста. */
  fingerprint: string;
}

export type Lexicon = Record<string, string[]>;

export interface LintParams {
  speech: { wordsPerSecond: number; speakingShare: number; infoAt: number; warnAt: number; maxLineWords: number };
  microActions: { maxGesturesPerParagraph: number };
  length: { infoAboveChars: number };
  refs: { softLimit: number; hardLimit: number };
  duration: { min: number; max: number; defaultSec: number };
  defectStack: { minItems: number };
  finale: { minSignals: number };
}

export interface Paragraph {
  index: number;
  text: string;
  /** Текст с репликами «…», заменёнными заглушкой той же длины: позиции совпадают с `text`. */
  masked: string;
  sentences: { text: string; from: number; to: number }[];
}

export interface TextLintContext {
  raw: string;
  paragraphs: Paragraph[];
  /** Абзацы «как снято»: всё до первого абзаца локации или правила про оператора. */
  styleZone: Paragraph[];
  lines: { text: string; paragraph: number; from: number }[];
  refSyntax: RefSyntax;
  panelSize: number | null;
  durationSec: number;
  lexicon: Lexicon;
  params: LintParams;
}

export interface TextRule {
  id: string;
  family: RuleFamily;
  run(ctx: TextLintContext): Omit<Finding, 'fingerprint' | 'family'>[];
}
