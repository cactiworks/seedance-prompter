/**
 * Перевод инструкции точечной правки (решение 32): владелец пишет по-русски «убери кружку», модель получает
 * английское «remove the mug». Seedream через KIE официально понимает английский и китайский; английский в
 * интерфейсе владелец не пишет (правило 7).
 */

export const EDIT_INSTRUCTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['instructionEn'],
  properties: { instructionEn: { type: 'string' } },
} as const;

export interface EditInstructionOutput {
  instructionEn: string;
}

export const EDIT_INSTRUCTION_SYSTEM = `You translate an image-edit instruction from Russian into English for an image model (Seedream 5 Pro).
The owner has marked one or more areas of the image with a brush; the instruction says what to do with the marked area(s).

Rules:
- One short imperative sentence or two, the way an editor would ask: "Replace the mug with a glass of orange juice", "Remove the person", "Make the jacket dark green".
- Translate faithfully. Do not add objects, styles or details the owner did not ask for. You may make an implicit object explicit only when the Russian names it.
- Refer to the place as "the marked area" (or "the marked areas"), never with coordinates.
- Text that must appear in the image stays in its original language, letter for letter, inside double quotes.
- No other Cyrillic. Output only the JSON object.`;

export const buildEditInstructionUser = (instructionRu: string, regions: number): string =>
  `Marked areas: ${regions}.\nOwner's instruction in Russian:\n${instructionRu.trim()}`;

const CYRILLIC = /[Ѐ-ӿ]/u;
const QUOTED = /"[^"]*"|«[^»]*»|“[^”]*”/g;

/** Нужен ли перевод: владелец мог написать и по-английски. */
export const needsTranslation = (instruction: string): boolean => CYRILLIC.test(instruction.replace(QUOTED, ''));

export function validateEditInstruction(output: EditInstructionOutput): string[] {
  const text = output.instructionEn.trim();
  const problems: string[] = [];
  if (text === '') problems.push('instructionEn is empty.');
  if (CYRILLIC.test(text.replace(QUOTED, ''))) problems.push('instructionEn: English only; Russian is allowed only for text that must appear in the image, inside double quotes.');
  if (/<bbox>|<point>|\d{2,3}\s+\d{2,3}\s+\d{2,3}/.test(text)) problems.push('instructionEn: no coordinates — say "the marked area".');
  return problems;
}
