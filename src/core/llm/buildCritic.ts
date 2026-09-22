import type { Finding } from '../lint/index.ts';
import type { Project, Shot } from '../model/project.ts';
import type { CompiledParagraph } from '../compile/compile.ts';

/** Таблица симптомов pack — критик получает её как рамку: «какие из известных провалов рискует повторить этот промпт». */
export interface SymptomCatalog {
  groups: Record<string, string>;
  symptoms: { id: string; group: string; titleRu: string; causeRu: string; checkRu: string; guide?: string }[];
}

export type CriticSeverity = 'critical' | 'warning' | 'note';
export type CriticVerdict = 'ready' | 'risky' | 'not-ready';

export interface CriticFinding {
  severity: CriticSeverity;
  /** Короткая категория латиницей: physics, causality, roles, refs, operator, budget, light, finale, speech, continuity, ambiguity, other. */
  category: string;
  /** Дословная цитата из абзаца (≤ 120 знаков): по ней находка проверяется и привязывается к месту. */
  quote: string;
  /** Номер абзаца, 1-based — как в присланном тексте. */
  paragraph: number;
  problemRu: string;
  fixRu: string;
  symptomId?: string;
}

export interface CriticOutput {
  /** Пересказ «что увидит зритель» по абзацам сценария: главный инструмент проверки без генерации. */
  readback: { paragraph: number; seesRu: string; unsureRu?: string }[];
  findings: CriticFinding[];
  verdict: CriticVerdict;
  summaryRu: string;
}

export const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readback', 'findings', 'verdict', 'summaryRu'],
  properties: {
    readback: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['paragraph', 'seesRu'],
        properties: { paragraph: { type: 'integer' }, seesRu: { type: 'string' }, unsureRu: { type: 'string' } },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'quote', 'paragraph', 'problemRu', 'fixRu'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'note'] },
          category: { type: 'string' },
          quote: { type: 'string' },
          paragraph: { type: 'integer' },
          problemRu: { type: 'string' },
          fixRu: { type: 'string' },
          symptomId: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['ready', 'risky', 'not-ready'] },
    summaryRu: { type: 'string' },
  },
} as const;

/** Стабильная часть: метод критика + таблица симптомов pack. Байт в байт одинакова между вызовами → prompt cache. */
export function buildCriticSystem(rules: string, catalog: SymptomCatalog): string {
  const symptoms = catalog.symptoms.map((s) => ({ id: s.id, group: catalog.groups[s.group] ?? s.group, symptomRu: s.titleRu, causeRu: s.causeRu }));
  return `${rules.trim()}\n\n# Known failures (the guide's symptom table)\n\nWhen a finding matches one of these, put its id into \`symptomId\`.\n\n\`\`\`json\n${JSON.stringify(symptoms, null, 1)}\n\`\`\`\n`;
}

const KIND_EN: Record<string, string> = { style: 'style block (verbatim from the guide)', format: 'format (verbatim)', 'role-shooting': 'shooting gear role (template)', 'role-props': 'props role (template)', camera: 'camera (verbatim)', lens: 'lens (verbatim)', flare: 'flare behaviour (verbatim)', imperfections: 'imperfection stack (verbatim)', 'operator-rule': 'operator rule (verbatim)', location: 'location and weather (template + owner text)', segment: 'scenario paragraph (owner / writer text)' };

export interface CriticInput {
  project: Project;
  shot: Shot;
  paragraphs: CompiledParagraph[];
  resolvedParagraphs: string[];
  durationSec: number;
  /** Что линтер уже нашёл — критик это не повторяет. */
  findings: Finding[];
  /** Vision-сводки референсов, если владелец их запускал. */
  visionSummaries?: Record<string, string>;
}

/** Переменная часть: промпт как его увидит модель, панель с ролями, что уже известно. */
export function buildCriticUser(input: CriticInput): string {
  const { project, shot } = input;
  const refs = new Map(project.refs.map((r) => [r.key, r]));
  const entities = project.entities.filter((e) => e.refKey !== null && shot.panel.includes(e.refKey));
  const payload = {
    format: { durationSec: input.durationSec, aspect: '9:16', singleContinuousTake: true, dialect: project.dialect },
    panel: shot.panel.map((key, i) => {
      const ref = refs.get(key);
      const bound = entities.filter((e) => e.refKey === key).map((e) => e.name);
      return { n: i + 1, label: ref?.label ?? key, kind: ref?.kind ?? 'other', boundTo: bound, flags: ref?.flags ?? {}, ...(input.visionSummaries?.[key] !== undefined ? { vision: input.visionSummaries[key] } : {}) };
    }),
    lines: project.lines.filter((l) => shot.segments.some((s) => s.text.en.includes(`{{line:${l.id}}}`))).map((l) => ({ id: l.id, ru: l.ru })),
    statesFromPreviousShots: project.states.filter((s) => shot.segments.some((seg) => seg.text.en.includes(`{{state:${s.id}}}`))).map((s) => s.en),
    alreadyFoundByLinter: input.findings.filter((f) => f.severity !== 'info').map((f) => `${f.ruleId}: ${f.messageRu}`),
    consciousExceptions: shot.suppressed.map((s) => s.reasonRu),
    paragraphs: input.resolvedParagraphs.map((text, i) => ({ p: i + 1, kind: KIND_EN[input.paragraphs[i]?.kind ?? ''] ?? input.paragraphs[i]?.kind ?? 'paragraph', text })),
  };
  return `Review this prompt exactly as the video model will read it.\n\n\`\`\`json\n${JSON.stringify(payload, null, 1)}\n\`\`\``;
}

const norm = (text: string): string => text.toLowerCase().replace(/[«»"“”'’]/g, '').replace(/\s+/g, ' ').trim();
/** Модель иногда дописывает к полю XML-подобный хвост («…дубль.</summaryRu>») — владельцу он не нужен. */
const clean = (text: string): string => text.replace(/<\/?[a-zA-Z][\w-]*>/g, '').trim();

export interface VerifiedCritique {
  critique: CriticOutput;
  /** Находки без опоры в тексте — выброшены, чтобы не спорить с галлюцинацией. */
  droppedRu: string[];
}

/**
 * Ответ критика проверяется детерминированно: цитата обязана быть в тексте промпта. Найдена в другом
 * абзаце — номер исправляется; не найдена нигде — находка выбрасывается. Так критик не может
 * указать на то, чего в промпте нет.
 */
export function verifyCritique(output: CriticOutput, resolvedParagraphs: string[]): VerifiedCritique {
  const normalized = resolvedParagraphs.map(norm);
  const droppedRu: string[] = [];
  const findings: CriticFinding[] = [];
  for (const finding of output.findings) {
    const quote = norm(finding.quote);
    if (quote.length < 4) {
      droppedRu.push(`${finding.problemRu} — без цитаты.`);
      continue;
    }
    const claimed = finding.paragraph - 1;
    const at = normalized[claimed]?.includes(quote) === true ? claimed : normalized.findIndex((p) => p.includes(quote));
    if (at === -1) {
      droppedRu.push(`${finding.problemRu} — цитаты «${finding.quote.slice(0, 60)}» в промпте нет.`);
      continue;
    }
    findings.push({ ...finding, paragraph: at + 1, quote: finding.quote.trim().slice(0, 160), problemRu: clean(finding.problemRu), fixRu: clean(finding.fixRu), category: clean(finding.category) });
  }
  const order: Record<CriticSeverity, number> = { critical: 0, warning: 1, note: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.paragraph - b.paragraph);
  const readback = output.readback
    .filter((r) => r.paragraph >= 1 && r.paragraph <= resolvedParagraphs.length && r.seesRu.trim() !== '')
    .sort((a, b) => a.paragraph - b.paragraph)
    .map((r) => ({ ...r, seesRu: clean(r.seesRu), ...(r.unsureRu !== undefined ? { unsureRu: clean(r.unsureRu) } : {}) }));
  // Вердикт не может быть мягче найденного: critical → not-ready, warning → хотя бы risky.
  const worst = findings[0]?.severity;
  const verdict: CriticVerdict = worst === 'critical' ? 'not-ready' : worst === 'warning' && output.verdict === 'ready' ? 'risky' : output.verdict;
  return { critique: { readback, findings, verdict, summaryRu: clean(output.summaryRu) }, droppedRu };
}
