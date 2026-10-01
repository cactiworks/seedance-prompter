import { eventBudget, type Project } from '../model/project.ts';

export const PLANNER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['segments', 'notesRu'],
  properties: {
    segments: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['titleRu', 'beatsRu'], properties: { titleRu: { type: 'string' }, beatsRu: { type: 'string' } } },
    },
    notesRu: { type: 'string' },
  },
} as const;

/** Планировщик только раскладывает кадр по времени; место и погоду переводит агент полей. */
export interface PlannerOutput {
  segments: { titleRu: string; beatsRu: string }[];
  notesRu: string;
}

export interface ExtractedSynopsis {
  /** Синопсис, где реплики заменены на их id. */
  text: string;
  /** Новые реплики, вынутые из «ёлочек» синопсиса, — буква в букву. */
  newLines: { id: string; ru: string }[];
}

/**
 * Реплики в «ёлочках» вынимаются из синопсиса детерминированно и заменяются на L-id: агент-планировщик
 * текста реплик не видит и не может его исказить. Уже существующая реплика переиспользуется.
 */
export function extractLines(synopsisRu: string, existing: { id: string; ru: string }[]): ExtractedSynopsis {
  let next = Math.max(0, ...existing.map((l) => Number(l.id.slice(1)))) + 1;
  const newLines: { id: string; ru: string }[] = [];
  const text = synopsisRu.replace(/«([^»]+)»/g, (_whole, ru: string) => {
    const clean = ru.trim();
    const known = [...existing, ...newLines].find((l) => l.ru.trim() === clean);
    if (known !== undefined) return known.id;
    const id = `L${next}`;
    next += 1;
    newLines.push({ id, ru: clean });
    return id;
  });
  return { text, newLines };
}

/** Сколько отрезков уместно при такой длительности: 2–8 на 30 секунд, один — для совсем короткого кадра. */
export function segmentRange(durationSec: number): { min: number; max: number } {
  return { min: durationSec <= 8 ? 1 : 2, max: Math.max(2, Math.round((8 * durationSec) / 30)) };
}

/**
 * Как снято — для планировщика. frames — кадры раскадровки панели по порядку: тогда отрезков ровно столько же,
 * отрезок N открывается на кадре N (привязку ставит код, не агент).
 */
export interface PlannerShooting {
  mode: string;
  guide: boolean;
  structure: 'one-take' | 'cuts';
  cameraLanguage: string;
  frames: { label: string; whatIsInIt?: string }[];
}

export function buildPlannerUser(project: Project, synopsis: string, lineIds: string[], durationSec: number = project.durationSec, shooting?: PlannerShooting): string {
  const frames = shooting?.frames ?? [];
  const input = {
    durationSec,
    majorEvents: eventBudget(durationSec),
    segments: frames.length > 0 ? { min: frames.length, max: frames.length } : segmentRange(durationSec),
    synopsisRu: synopsis,
    lineIds,
    entities: project.entities.map((e) => ({ name: (e.nameRu ?? '').trim() === '' ? e.name : e.nameRu, kind: e.kind })),
    world: { placeRu: project.world.place.ru, weatherRu: project.world.weather.ru },
    ...(shooting === undefined || shooting.guide ? {} : { camera: { mode: shooting.mode, cameraLanguage: shooting.cameraLanguage } }),
    ...(shooting?.structure === 'cuts' ? { editedSequence: 'Every segment is one shot of an edited sequence; hard cuts between segments.' } : {}),
    ...(frames.length > 0 ? { storyboardFrames: frames.map((f, i) => ({ segment: i + 1, image: f.label, ...(f.whatIsInIt !== undefined ? { whatIsInIt: f.whatIsInIt } : {}) })) } : {}),
  };
  return `Plan the timeline for this shot.\n\n\`\`\`json\n${JSON.stringify(input, null, 1)}\n\`\`\``;
}

/** Проверка плана: число отрезков, реплики по одному разу и в порядке, английский без кириллицы. exact — по числу кадров раскадровки. */
export function validatePlan(plan: PlannerOutput, lineIds: string[], durationSec = 30, exact?: number): string[] {
  const problems: string[] = [];
  const range = exact !== undefined && exact > 0 ? { min: exact, max: exact } : segmentRange(durationSec);
  if (plan.segments.length < range.min || plan.segments.length > range.max) problems.push(`Segments: ${plan.segments.length}; expected ${range.min === range.max ? range.min : `${range.min}–${range.max}`}.`);
  if (plan.segments.some((s) => s.beatsRu.trim() === '')) problems.push('Every segment needs Russian beats.');
  const seen = plan.segments.flatMap((s) => s.beatsRu.match(/\bL\d+\b/g) ?? []);
  for (const id of lineIds) {
    const count = seen.filter((x) => x === id).length;
    if (count !== 1) problems.push(`${id} must be placed in exactly one segment (found ${count}).`);
  }
  for (const id of new Set(seen)) if (!lineIds.includes(id)) problems.push(`${id} is not a known line id.`);
  const order = seen.filter((id, i) => seen.indexOf(id) === i && lineIds.includes(id));
  if (order.join() !== lineIds.filter((id) => order.includes(id)).join()) problems.push(`Lines must keep the spoken order: ${lineIds.join(', ')}.`);
  if (/[«»]/.test(plan.segments.map((s) => s.beatsRu).join(' '))) problems.push('Do not write line text; reference lines by id only.');
  return problems;
}
