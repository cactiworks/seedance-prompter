import { SeriesFormSchema, type Project, type SeriesForm } from '../model/project.ts';
import { buildValidationContext } from '../llm/buildWriter.ts';
import { validateWriterOutput } from '../llm/validate.ts';
import { buildShot, type PackBundle } from '../pipeline.ts';

export function formOf(project: Project): SeriesForm {
  return SeriesFormSchema.parse({ world: project.world, entities: project.entities, states: project.states, shot: project.shots[0] });
}
const DERIVED = new Set(['en', 'enFor', 'name', 'nameFor', 'source', 'locked', 'camera', 'lens', 'look', 'lensNote', 'operation', 'language', 'propsEn', 'propsFor']);
/** Source fields only: translations may be regenerated, explicit Russian edits may not. */
export function sourceFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sourceFields);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !DERIVED.has(k)).map(([k,v]) => [k, sourceFields(v)]));
  return value;
}
export interface LockedField { path: string[]; value: unknown }
export function manualFields(current: SeriesForm, baseline: SeriesForm): LockedField[] {
  const walk = (a: unknown, b: unknown, path: string[]): LockedField[] => {
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) return Object.entries(a).flatMap(([k,v]) => walk(v, (b as Record<string, unknown>)[k], [...path,k]));
    return [{ path, value: a }];
  };
  return walk(sourceFields(current), sourceFields(baseline), []);
}
export function manualProblems(form: SeriesForm, locked: LockedField[]): string[] {
  const source = sourceFields(form);
  return locked.flatMap(({path,value}) => {
    let found: unknown = source;
    for (const key of path) found = found && typeof found === 'object' ? (found as Record<string, unknown>)[key] : undefined;
    return JSON.stringify(found) === JSON.stringify(value) ? [] : [`Сохранить ручное поле ${path.join('.')}: ${JSON.stringify(value)}`];
  });
}
export function applyForm(project: Project, raw: SeriesForm): Project {
  const form = SeriesFormSchema.parse(raw);
  const unit = (u: typeof form.world.place) => ({ ...u, enFor: u.ru, source: 'llm' as const });
  form.world.place = unit(form.world.place); form.world.weather = unit(form.world.weather);
  form.entities = form.entities.map(e => ({ ...e, nameFor: e.nameRu ?? '' }));
  form.states = form.states.map(s => ({ ...s, enFor: s.titleRu }));
  form.shot.customKit.enFor = form.shot.customKit.ru ?? '';
  if (form.shot.shooting) form.shot.shooting.enFor = form.shot.shooting.ru ?? '';
  if (form.shot.roleSplit) form.shot.roleSplit.propsFor = form.shot.roleSplit.propsRu ?? '';
  form.shot.segments = form.shot.segments.map(s => ({ ...s, text: { ...s.text, source: 'llm', enFor: s.beatsRu } }));
  return { ...project, world: form.world, entities: form.entities, states: form.states, shots: [{ ...project.shots[0]!, ...form.shot, critique: null }] };
}
export function formProblems(project: Project, pack: PackBundle): string[] {
  const shot = project.shots[0]!;
  const build = buildShot(project, shot, pack);
  const refs = new Set(shot.panel);
  return [
    ...(project.production && !shot.segments[0]?.frameRef ? ['Первый отрезок должен начинаться с принятого фото.'] : []),
    ...build.blockers.map(x => x.messageRu), ...build.findings.filter(f => f.severity === 'error').map(f => f.messageRu),
    ...project.entities.filter(e => e.refKey && !refs.has(e.refKey)).map(() => 'Персонаж или предмет ссылается на отсутствующий reference.'),
    ...shot.segments.filter(s => s.frameRef && !refs.has(s.frameRef)).map(() => 'Начальный кадр не подключён.'),
    ...validateWriterOutput({ blocks: shot.segments.map(s => ({ segmentId: s.id, en: s.text.en })) }, buildValidationContext(project, shot, shot.segments.map(s => s.id))).map(v => v.messageEn)];
}

/** Everything affecting interpretation, excluding the previous report and bookkeeping. */
export const seriesFormFingerprint = (p: Project) => ({ form: formOf(p), refs:p.refs, panel:p.shots[0]?.panel, language:p.language, lines:p.lines, aspect:p.aspectRatio, duration:p.durationSec });
export function invalidateSeriesCritique(before: Project, after: Project): Project {
  return before.production && JSON.stringify(seriesFormFingerprint(before)) !== JSON.stringify(seriesFormFingerprint(after)) ? { ...after, shots: after.shots.map(s => ({ ...s, critique:null })) } : after;
}
