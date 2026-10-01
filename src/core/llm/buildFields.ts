import type { FieldItem, FieldsOutput } from '../compose.ts';
import type { Project } from '../model/project.ts';

const TEXT = { type: 'string' } as const;

export const FIELDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['texts', 'kit', 'shooting', 'notesRu'],
  properties: {
    texts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'en'], properties: { id: TEXT, en: TEXT } } },
    kit: { type: 'object', additionalProperties: false, required: ['camera', 'lens', 'look', 'lensNote'], properties: { camera: TEXT, lens: TEXT, look: TEXT, lensNote: TEXT } },
    shooting: { type: 'object', additionalProperties: false, required: ['operation', 'language'], properties: { operation: TEXT, language: TEXT } },
    notesRu: TEXT,
  },
} as const;

/** Что агент полей получает на вход: только поля с русским текстом плюс имена сущностей для последствий. */
export function buildFieldsUser(project: Project, items: FieldItem[]): string {
  const input = {
    write: items.filter((item) => item.ru !== '').map((item) => ({ id: item.id, slot: item.kind, ru: item.ru })),
    context: {
      entities: project.entities.map((e) => ({ id: `entity:${e.key}`, kind: e.kind, ru: e.nameRu ?? '', currentName: e.name })),
      dialogueLanguage: project.language,
    },
  };
  return `Write the English fragments for these fields.\n\n\`\`\`json\n${JSON.stringify(input, null, 1)}\n\`\`\``;
}

const noTail = (text: string): string => text.trim().replace(/[.\s]+$/, '');
/** Предложение без хвостовой точки: её ставит компилятор. */
const sentence = (text: string): string => noTail(text.trim().replace(/\s+/g, ' '));

/** Слоты, которые компилятор продолжает сам: хвостовая точка у них — опечатка, снимается без агента. */
export function normalizeFields(output: FieldsOutput, items: FieldItem[]): FieldsOutput {
  const kind = new Map(items.map((item) => [item.id, item.kind]));
  const texts = output.texts.map((t) => {
    const k = kind.get(t.id);
    const en = k === 'place' || k === 'props' || k === 'character' || k === 'object' ? sentence(t.en) : t.en.trim().replace(/\s+/g, ' ');
    return { id: t.id, en };
  });
  const asked = items.some((item) => item.kind === 'camera' && item.ru !== '');
  const kit = output.kit === null || !asked ? null : { camera: sentence(output.kit.camera), lens: sentence(output.kit.lens), look: sentence(output.kit.look), lensNote: sentence(output.kit.lensNote) };
  const shootingAsked = items.some((item) => item.kind === 'shooting' && item.ru !== '');
  const shooting = output.shooting == null || !shootingAsked ? null : { operation: sentence(output.shooting.operation), language: output.shooting.language.trim().replace(/\s+/g, ' ') };
  return { texts, kit, shooting, notesRu: output.notesRu.trim() };
}

const CYRILLIC = /[Ѐ-ӿ]/u;

/** Проверка ответа: все поля на месте, английский, имена героев не пустые и не повторяются. */
export function validateFields(output: FieldsOutput, items: FieldItem[], project: Project): string[] {
  const problems: string[] = [];
  const wanted = items.filter((item) => item.ru !== '' && item.kind !== 'camera' && item.kind !== 'shooting');
  const ids = output.texts.map((t) => t.id);
  for (const item of wanted) {
    const count = ids.filter((id) => id === item.id).length;
    if (count !== 1) problems.push(`${item.id} must be returned exactly once in texts (found ${count}).`);
  }
  for (const id of new Set(ids)) if (!wanted.some((item) => item.id === id)) problems.push(`${id} was not requested.`);
  for (const t of output.texts) if (CYRILLIC.test(t.en)) problems.push(`${t.id}: English only, no Cyrillic.`);

  const names = new Map(project.entities.map((e) => [`entity:${e.key}`, e.name.trim()]));
  for (const t of output.texts) if (names.has(t.id)) names.set(t.id, t.en.trim());
  for (const t of output.texts) {
    if (!t.id.startsWith('entity:')) continue;
    if (t.en.trim() === '') problems.push(`${t.id}: the name cannot be empty.`);
    else if (t.en.split(/\s+/).length > 5) problems.push(`${t.id}: a name is 1–4 words, not a description.`);
    const same = [...names.entries()].filter(([id, name]) => id !== t.id && name.toLowerCase() === t.en.trim().toLowerCase());
    if (same.length > 0 && t.en.trim() !== '') problems.push(`${t.id}: "${t.en.trim()}" is already used by ${same[0]?.[0]}; names must be unique.`);
  }

  if (items.some((item) => item.kind === 'camera' && item.ru !== '')) {
    const kit = output.kit;
    if (kit === null) problems.push('kit: the camera was requested.');
    else {
      if (Object.values(kit).some((value) => CYRILLIC.test(value))) problems.push('kit: English only, no Cyrillic.');
      if (/^(a |the )?(cinematic|film|movie|professional|digital) camera$/i.test(kit.camera.trim())) problems.push('kit.camera: a real model name, not a generic camera.');
      if (kit.camera.trim() !== '' && kit.look.trim() === '') problems.push('kit.look: describe the picture of this gear.');
    }
  }

  if (items.some((item) => item.kind === 'shooting' && item.ru !== '')) {
    const shooting = output.shooting;
    if (shooting == null) problems.push('shooting: the custom shooting was requested.');
    else {
      if (CYRILLIC.test(shooting.operation) || CYRILLIC.test(shooting.language)) problems.push('shooting: English only, no Cyrillic.');
      if (shooting.operation.trim() === '') problems.push('shooting.operation: say how the camera is operated (support and movement).');
      if (shooting.language.trim() === '') problems.push('shooting.language: describe the camera behaviour for the scenario writer.');
      if (/\b(cinematic|stunning|epic|beautiful|breathtaking)\b/i.test(shooting.operation)) problems.push('shooting.operation: no "cinematic", "stunning", "epic" — physical camera behaviour only.');
    }
  }
  return problems;
}
