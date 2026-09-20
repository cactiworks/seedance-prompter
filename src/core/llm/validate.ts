import { findMalformed, findPlaceholders } from '../compile/placeholders.ts';

export interface WriterBlock {
  segmentId: string;
  en: string;
  notesRu?: string;
}

export interface WriterOutput {
  blocks: WriterBlock[];
  warningsRu?: string[];
}

export interface ValidationContext {
  /** Сегменты, которые писателю разрешено писать. */
  writable: string[];
  /** Для каждого сегмента — реплики, обязанные стоять в нём ровно раз и в этом порядке. */
  requiredLines: Record<string, string[]>;
  known: { intro: string[]; ref: string[]; line: string[]; state: string[] };
  /** Сущности, уже представленные в заблокированных сегментах: повторный intro запрещён. */
  alreadyIntroduced: string[];
}

export interface Violation {
  segmentId: string;
  code: 'UNKNOWN_SEGMENT' | 'MISSING_SEGMENT' | 'EMPTY' | 'MALFORMED_PLACEHOLDER' | 'UNKNOWN_ID' | 'RAW_REF' | 'RAW_LINE' | 'CYRILLIC' | 'LINE_MISSING' | 'LINE_DUPLICATED' | 'LINE_ORDER' | 'INTRO_DUPLICATED';
  messageEn: string;
}

/**
 * Детерминированная проверка ответа писателя. LLM не пишет ни номеров, ни реплик, ни русского текста —
 * только ставит плейсхолдеры. Всё, что нарушает это, возвращается модели в одном ремонтном вызове.
 */
export function validateWriterOutput(output: WriterOutput, ctx: ValidationContext): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const introduced = new Set(ctx.alreadyIntroduced);

  for (const block of output.blocks) {
    const id = block.segmentId;
    if (!ctx.writable.includes(id)) {
      violations.push({ segmentId: id, code: 'UNKNOWN_SEGMENT', messageEn: `Segment "${id}" was not requested. Write only: ${ctx.writable.join(', ')}.` });
      continue;
    }
    seen.add(id);
    const text = block.en;
    if (text.trim() === '') violations.push({ segmentId: id, code: 'EMPTY', messageEn: 'The paragraph is empty.' });

    for (const bad of findMalformed(text)) {
      violations.push({ segmentId: id, code: 'MALFORMED_PLACEHOLDER', messageEn: `"${bad.raw}" is not a valid placeholder. Allowed forms: {{intro:key}}, {{ref:key}}, {{line:Ln}}, {{state:Sn}}.` });
    }
    const placeholders = findPlaceholders(text);
    for (const p of placeholders) {
      if (!ctx.known[p.type].includes(p.id)) {
        violations.push({ segmentId: id, code: 'UNKNOWN_ID', messageEn: `${p.raw}: unknown id. Known ${p.type} ids: ${ctx.known[p.type].join(', ') || '(none)'}.` });
      }
    }

    if (/<<<\s*image|@image\s?\d|\bimage[_ ]?\d+\b/i.test(text)) {
      violations.push({ segmentId: id, code: 'RAW_REF', messageEn: 'Never write reference numbers. Use {{intro:key}} for the first mention and the plain name afterwards.' });
    }
    if (/[«»]|\bsays\b[^.]{0,80}:\s*["“]/.test(text)) {
      violations.push({ segmentId: id, code: 'RAW_LINE', messageEn: 'Never write dialogue text or quotes. Put {{line:Ln}} where the character speaks: "He turns to the camera and {{line:L1}}".' });
    }
    if (/[Ѐ-ӿ]/u.test(text)) violations.push({ segmentId: id, code: 'CYRILLIC', messageEn: 'No Cyrillic in the paragraph. Dialogue goes in only through {{line:Ln}} placeholders.' });

    const lineIds = placeholders.filter((p) => p.type === 'line').map((p) => p.id);
    const required = ctx.requiredLines[id] ?? [];
    for (const lineId of required) {
      const count = lineIds.filter((x) => x === lineId).length;
      if (count === 0) violations.push({ segmentId: id, code: 'LINE_MISSING', messageEn: `{{line:${lineId}}} must appear in this paragraph exactly once.` });
      if (count > 1) violations.push({ segmentId: id, code: 'LINE_DUPLICATED', messageEn: `{{line:${lineId}}} appears ${count} times; it must appear exactly once.` });
    }
    const orderSeen = lineIds.filter((x) => required.includes(x));
    if (orderSeen.join() !== required.filter((x) => orderSeen.includes(x)).join()) {
      violations.push({ segmentId: id, code: 'LINE_ORDER', messageEn: `Lines must follow the order of the beats: ${required.join(', ')}. Paragraph order is time order.` });
    }

    for (const p of placeholders.filter((x) => x.type === 'intro')) {
      if (introduced.has(p.id)) violations.push({ segmentId: id, code: 'INTRO_DUPLICATED', messageEn: `{{intro:${p.id}}} was already used. After the first mention write the plain name.` });
      introduced.add(p.id);
    }
  }

  for (const id of ctx.writable) {
    if (!seen.has(id)) violations.push({ segmentId: id, code: 'MISSING_SEGMENT', messageEn: `Segment "${id}" is missing from the answer.` });
  }
  return violations;
}
