import type { Kit } from '../compile/compile.ts';
import type { Project, Shot } from '../model/project.ts';
import type { ValidationContext, Violation } from './validate.ts';

export interface FewShot {
  kitId: string;
  entities: { key: string; name: string; kind: string }[];
  lines: { id: string; ru: string }[];
  segments: { id: string; beatsRu: string; en: string }[];
}

export const WRITER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['blocks'],
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['segmentId', 'en'],
        properties: { segmentId: { type: 'string' }, en: { type: 'string' }, notesRu: { type: 'string' } },
      },
    },
    warningsRu: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** Стабильная часть: правила + пример. Байт в байт одинакова между вызовами → попадает в prompt cache. */
export function buildWriterSystem(rules: string, fewshot: FewShot): string {
  const example = {
    input: { entities: fewshot.entities.map((e) => ({ placeholder: `{{intro:${e.key}}}`, laterName: e.name })), lines: fewshot.lines.map((l) => ({ placeholder: `{{line:${l.id}}}`, ru: l.ru })), segments: fewshot.segments.map((s) => ({ id: s.id, beatsRu: s.beatsRu })) },
    output: { blocks: fewshot.segments.map((s) => ({ segmentId: s.id, en: s.en })) },
  };
  return `${rules.trim()}\n\n# Worked example\n\nA shot that went into the final edit with no fixes (Sony VENICE 2 + ZEISS Supreme Prime). Study how the Russian beats became paragraphs: camera verbs, cause and effect, light as an event, background seasoning, the ending.\n\n\`\`\`json\n${JSON.stringify(example, null, 1)}\n\`\`\`\n`;
}

/** Реплики, упомянутые в битах отрезка как L1, L2…, обязаны стоять в его абзаце — в этом порядке. */
export function linesInBeats(beatsRu: string, known: string[]): string[] {
  const out: string[] = [];
  for (const match of beatsRu.matchAll(/\bL\d+\b/g)) if (known.includes(match[0]) && !out.includes(match[0])) out.push(match[0]);
  return out;
}

export function writableSegments(shot: Shot): string[] {
  return shot.segments.filter((s) => !s.text.locked && s.beatsRu.trim() !== '').map((s) => s.id);
}

export function buildValidationContext(project: Project, shot: Shot, writable: string[], fixing = false): ValidationContext {
  const lineIds = project.lines.map((l) => l.id);
  const lockedText = shot.segments.filter((s) => !writable.includes(s.id)).map((s) => s.text.en).join('\n');
  // При починке реплики обязаны остаться там же, где стояли в текущем тексте.
  const required = (s: Shot['segments'][number]): string[] => (fixing ? [...s.text.en.matchAll(/\{\{line:(L\d+)\}\}/g)].map((m) => m[1] ?? '') : linesInBeats(s.beatsRu, lineIds));
  return {
    writable,
    requiredLines: Object.fromEntries(shot.segments.filter((s) => writable.includes(s.id)).map((s) => [s.id, required(s)])),
    known: { intro: project.entities.map((e) => e.key), ref: shot.panel, line: lineIds, state: project.states.map((s) => s.id) },
    alreadyIntroduced: [...lockedText.matchAll(/\{\{intro:([^}]+)\}\}/g)].map((m) => m[1] ?? ''),
  };
}

/** Починка после неудачной генерации: симптомы из таблицы ошибок + наблюдения владельца. */
export interface FixBrief {
  symptoms: { titleRu: string; fixEn: string }[];
  workedRu: string;
  failedRu: string;
}

/** В режиме починки агент правит все абзацы с текстом — результат идёт владельцу как предложение, не применяется сам. */
export function fixableSegments(shot: Shot): string[] {
  return shot.segments.filter((s) => s.text.en.trim() !== '').map((s) => s.id);
}

/** Динамическая часть запроса — только в user message. */
export function buildWriterUser(project: Project, shot: Shot, kit: Kit, writable: string[], repair?: { previous: { segmentId: string; en: string }[]; violations: Violation[]; lintFindings: string[] }, fix?: FixBrief): string {
  const lineIds = project.lines.map((l) => l.id);
  const input = {
    format: { durationSec: project.durationSec, aspect: '9:16', singleContinuousTake: true },
    kit: { shootingGear: kit.anchor, look: kit.source === 'custom' ? (kit.look ?? '') : kit.titleRu, flarePolicy: kit.lensNote ?? kit.flareParagraph ?? 'flares follow the look of this lens', doNotMention: 'other camera or lens brands' },
    camera: { operatorRuleInPrompt: shot.operatorRule !== 'off', reminder: 'camera verbs only; the operator is never an actor' },
    world: { place: project.world.place.en, weatherAndBaseLight: project.world.weather.en },
    entities: project.entities.map((e) => ({ firstMention: `{{intro:${e.key}}}`, laterName: e.name, kind: e.kind, hasReference: e.refKey !== null })),
    lines: project.lines.map((l) => ({ placeholder: `{{line:${l.id}}}`, speaker: project.entities.find((e) => e.key === l.speakerKey)?.name ?? null, ru: l.ru })),
    states: project.states.map((s) => ({ placeholder: `{{state:${s.id}}}`, meaning: s.en })),
    segments: shot.segments.map((s) => ({
      id: s.id,
      beatsRu: s.beatsRu,
      requiredLinesInOrder: fix === undefined ? linesInBeats(s.beatsRu, lineIds) : [...s.text.en.matchAll(/\{\{line:(L\d+)\}\}/g)].map((m) => m[1] ?? ''),
      ...(writable.includes(s.id) ? (fix === undefined ? {} : { currentText: s.text.en }) : { lockedText: s.text.en }),
    })),
    write: writable,
    appendFinaleTail: false,
  };
  const task =
    fix === undefined
      ? 'Write the scenario paragraphs for this shot.'
      : [
          'This shot was already generated in Seedance and the result had problems. Edit the existing paragraphs (`currentText`) to fix ONLY the symptoms below.',
          'Change as little as possible: the owner compares attempts paragraph by paragraph, so every untouched sentence must stay byte-identical. Keep every placeholder that is already there. Return all requested segments, including unchanged ones.',
          `What worked (do not break it): ${fix.workedRu.trim() || '—'}`,
          `What failed, in the owner's words: ${fix.failedRu.trim() || '—'}`,
          `Symptoms and how to fix them:\n${fix.symptoms.map((s) => `- ${s.titleRu}: ${s.fixEn}`).join('\n')}`,
          'In notesRu say which symptom each change addresses; for unchanged paragraphs write «без изменений».',
        ].join('\n\n');
  const parts = [`${task}\n\n\`\`\`json\n${JSON.stringify(input, null, 1)}\n\`\`\``];
  if (repair !== undefined) {
    parts.push(
      `Your previous answer was rejected. Fix ONLY the problems listed and return all requested segments again. Keep notesRu about your decisions and risks for the owner — not about what you changed in this fix.\n\nPrevious answer:\n\`\`\`json\n${JSON.stringify(repair.previous, null, 1)}\n\`\`\`\n\nContract violations:\n${repair.violations.map((v) => `- [${v.segmentId}] ${v.messageEn}`).join('\n') || '- none'}\n\nLinter findings on the assembled prompt (Russian, from the guide's rules):\n${repair.lintFindings.map((f) => `- ${f}`).join('\n') || '- none'}`,
    );
  }
  return parts.join('\n\n');
}
