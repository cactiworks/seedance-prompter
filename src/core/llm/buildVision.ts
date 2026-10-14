import type { Ref } from '../model/project.ts';

export const VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['peopleCount', 'readableText', 'backdrop', 'summaryRu', 'risksRu'],
  properties: {
    peopleCount: { type: 'integer', minimum: 0 },
    readableText: { type: 'string' },
    backdrop: { type: 'string', enum: ['studio', 'real', 'unclear'] },
    clothingEn: { type: 'string' },
    extraObjectsRu: { type: 'array', items: { type: 'string' } },
    looksGenerated: { type: 'boolean' },
    summaryRu: { type: 'string' },
    risksRu: { type: 'array', items: { type: 'string' } },
  },
} as const;

export interface VisionOutput {
  peopleCount: number;
  readableText: string;
  backdrop: 'studio' | 'real' | 'unclear';
  clothingEn?: string;
  extraObjectsRu?: string[];
  looksGenerated?: boolean;
  summaryRu: string;
  risksRu: string[];
}

export const VISION_SYSTEM = `You inspect one reference image for a Seedance 2.5 video prompt. The model copies EVERYTHING from a
reference unless told otherwise, so your job is to list what could leak into the shot.

Report facts only, never guess identity, never name real people. Return only the JSON object matching the supplied output schema.

- peopleCount: humans visible (0 if none). For a character sheet count the character once.
- readableText: any legible text, captions, logos or spec tables, verbatim; "" if none. Text leaks into frames.
- backdrop: "studio" for a plain grey/white seamless or gradient backdrop (it leaks behind the character),
  "real" for a real place, "unclear" otherwise.
- clothingEn: for a person — clothing and build in one English phrase; "" otherwise.
- extraObjectsRu: notable things besides the declared subject, in Russian.
- looksGenerated: true if the image looks AI-generated from scratch rather than a real photo or film frame.
- summaryRu: one Russian sentence — what the reference actually gives the model.
- risksRu: Russian, concrete, each tied to a fix: «на референсе локации стоит человек в очках — без запрета он
  утечёт в кадр», «карточка со спецификациями: надписи могут попасть в кадр, надёжнее чистое фото»,
  «серый студийный задник — нужна клауза "do not take the background"», «герой в другой одежде, чем
  задумано — текстом это не чинится, нужна другая карта персонажа».`;

export function buildVisionUser(ref: Pick<Ref, 'label' | 'kind'>): string {
  return `Declared role of this reference: kind="${ref.kind}", label="${ref.label}". Inspect the attached image.`;
}

/** Флаги референса из отчёта: то, что кормит линтер и клаузу-исключение. */
export function flagsFromVision(report: VisionOutput, kind: Ref['kind']): Ref['flags'] {
  return {
    hasPeople: kind === 'character' ? report.peopleCount > 1 : report.peopleCount > 0,
    hasText: report.readableText.trim() !== '',
    studioBackdrop: report.backdrop === 'studio',
  };
}
