import { buildValidationContext, buildWriterSystem, buildWriterUser, fixableSegments, writableSegments, WRITER_SCHEMA, type FewShot, type FixBrief } from '../../../core/llm/buildWriter.ts';
import { validateWriterOutput, type Violation, type WriterOutput } from '../../../core/llm/validate.ts';
import type { Project, Shot } from '../../../core/model/project.ts';
import { agentShooting, buildShot, kitOf, type PackBundle } from '../../../core/pipeline.ts';
import type { LlmRequest, LlmResult } from '../codexCli/provider.ts';

export type Runner = <T>(request: LlmRequest) => Promise<LlmResult<T>>;

export interface WriteShotInput {
  project: Project;
  shotId: string;
  pack: PackBundle;
  rules: string;
  fewshot: FewShot;
  run: Runner;
  model: string;
  signal?: AbortSignal;
  /** Режим починки после неудачной генерации: правятся все абзацы с текстом, результат — предложение. */
  fix?: FixBrief;
  /** Явный список отрезков («переписать кадр»); по умолчанию — те, чьи биты изменились. */
  segmentIds?: string[];
}

export interface WriteShotResult {
  blocks: { segmentId: string; en: string; notesRu: string }[];
  warningsRu: string[];
  /** Что осталось после ремонтного круга — показывается владельцу, текст всё равно отдаётся на ревью. */
  remaining: { violations: Violation[]; lintRu: string[] };
  rounds: number;
  meta: { durationMs: number; model: string | null; inputTokens: number; outputTokens: number };
}

/** Находки линтера, которые писатель обязан починить сам (то, что зависит от его абзацев). */
const WRITER_FAMILIES = new Set(['operator', 'showable', 'roles', 'hygiene', 'finale']);

function applyBlocks(shot: Shot, blocks: { segmentId: string; en: string }[]): Shot {
  const byId = new Map(blocks.map((b) => [b.segmentId, b.en]));
  return { ...shot, segments: shot.segments.map((s) => (byId.has(s.id) ? { ...s, text: { ...s.text, en: byId.get(s.id) ?? '', source: 'llm' as const } } : s)) };
}

/** Петля «агент пишет → валидатор и линтер проверяют → агент чинит» — до одного ремонтного круга. */
export async function writeShot(input: WriteShotInput): Promise<WriteShotResult> {
  const { project, pack } = input;
  const shot = project.shots.find((s) => s.id === input.shotId);
  if (shot === undefined) throw new Error(`Нет кадра ${input.shotId}`);
  const kit = kitOf(shot, pack);
  if (kit === undefined) throw new Error(`Нет комплекта ${shot.kitId}`);

  const writable = input.fix === undefined ? writableSegments(shot, input.segmentIds) : fixableSegments(shot);
  if (writable.length === 0) throw new Error(input.fix === undefined ? 'Нечего писать: ни один отрезок не менялся после прошлой сборки или у отрезков нет описания по-русски.' : 'Нечего чинить: в кадре нет ни одного абзаца с текстом.');

  const system = buildWriterSystem(input.rules, input.fewshot);
  const ctx = buildValidationContext(project, shot, writable, input.fix !== undefined);
  const totals = { durationMs: 0, inputTokens: 0, outputTokens: 0, model: null as string | null };

  const check = (output: WriterOutput): { violations: Violation[]; lintRu: string[] } => {
    const violations = validateWriterOutput(output, ctx);
    const valid = output.blocks.filter((b) => writable.includes(b.segmentId));
    const build = buildShot(project, applyBlocks(shot, valid), pack);
    const writtenParagraphs = new Set(build.paragraphs.flatMap((p, i) => (p.segmentId !== undefined && writable.includes(p.segmentId) ? [i] : [])));
    const lintRu = build.findings
      .filter((f) => f.severity !== 'info' && WRITER_FAMILIES.has(f.family) && f.paragraph !== null && writtenParagraphs.has(f.paragraph))
      .map((f) => `[${build.paragraphs[f.paragraph ?? 0]?.segmentId ?? '?'}] ${f.messageRu} → ${f.fixHintRu} («${f.evidence.slice(0, 90)}»)`);
    return { violations, lintRu };
  };

  const call = async (user: string): Promise<WriterOutput> => {
    const result = await input.run<WriterOutput>({ system, user, jsonSchema: WRITER_SCHEMA, model: input.model, effort: 'medium', timeoutMs: 240_000, signal: input.signal });
    totals.durationMs += result.meta.durationMs;
    totals.inputTokens += result.meta.inputTokens;
    totals.outputTokens += result.meta.outputTokens;
    totals.model = result.meta.model;
    return result.data;
  };

  const shooting = agentShooting(shot, pack);
  let output = await call(buildWriterUser(project, shot, kit, writable, undefined, input.fix, shooting));
  let problems = check(output);
  let rounds = 1;

  if (problems.violations.length > 0 || problems.lintRu.length > 0) {
    const repaired = await call(buildWriterUser(project, shot, kit, writable, { previous: output.blocks.map((b) => ({ segmentId: b.segmentId, en: b.en })), violations: problems.violations, lintFindings: problems.lintRu }, input.fix, shooting));
    const after = check(repaired);
    rounds = 2;
    // Ремонт принимается, только если стало не хуже.
    if (after.violations.length <= problems.violations.length) {
      output = repaired;
      problems = after;
    }
  }

  return {
    blocks: output.blocks.filter((b) => writable.includes(b.segmentId)).map((b) => ({ segmentId: b.segmentId, en: b.en, notesRu: b.notesRu ?? '' })),
    warningsRu: output.warningsRu ?? [],
    remaining: problems,
    rounds,
    meta: totals,
  };
}
