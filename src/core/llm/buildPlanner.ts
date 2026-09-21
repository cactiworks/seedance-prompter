import type { Project } from '../model/project.ts';

export const PLANNER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['segments', 'placeEn', 'weatherEn', 'notesRu'],
  properties: {
    segments: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['titleRu', 'beatsRu'], properties: { titleRu: { type: 'string' }, beatsRu: { type: 'string' } } },
    },
    placeEn: { type: 'string' },
    weatherEn: { type: 'string' },
    notesRu: { type: 'string' },
  },
} as const;

export interface PlannerOutput {
  segments: { titleRu: string; beatsRu: string }[];
  placeEn: string;
  weatherEn: string;
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

export function buildPlannerUser(project: Project, synopsis: string, lineIds: string[], translate: { place: boolean; weather: boolean }): string {
  const input = {
    durationSec: project.durationSec,
    synopsisRu: synopsis,
    lineIds,
    entities: project.entities.map((e) => ({ name: e.name, kind: e.kind })),
    translateWorld: { ...(translate.place ? { place: project.world.place.ru } : {}), ...(translate.weather ? { weather: project.world.weather.ru } : {}) },
  };
  return `Plan the timeline for this shot.\n\n\`\`\`json\n${JSON.stringify(input, null, 1)}\n\`\`\``;
}

/** Проверка плана: число отрезков, реплики по одному разу и в порядке, английский без кириллицы. */
export function validatePlan(plan: PlannerOutput, lineIds: string[]): string[] {
  const problems: string[] = [];
  if (plan.segments.length < 2 || plan.segments.length > 8) problems.push(`Segments: ${plan.segments.length}; expected 2–8.`);
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
  if (/[Ѐ-ӿ]/u.test(`${plan.placeEn}${plan.weatherEn}`)) problems.push('placeEn and weatherEn must be English.');
  return problems;
}
