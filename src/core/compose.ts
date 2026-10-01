import { activeStates, CUSTOM_SHOOTING, needsAgent, segmentNeedsWriter, shootingOf, type Project, type Shot, type TextUnit } from './model/project.ts';

/**
 * «Собрать промпт»: владелец заполняет поля тезисно по-русски, агенты пишут английский. Здесь —
 * чистая часть этого цикла: что устарело, что уходит агенту полей, как применить ответы.
 */

export type FieldKind = 'place' | 'weather' | 'character' | 'object' | 'state' | 'camera' | 'props' | 'shooting';

export interface FieldItem {
  /** 'place' | 'weather' | 'entity:<key>' | 'state:<id>' | 'kit' | 'props' | 'shooting' */
  id: string;
  kind: FieldKind;
  /** Русский ввод; пусто — поле очищено, английский просто стирается без агента. */
  ru: string;
  /** Как назвать поле в сообщении владельцу. */
  labelRu: string;
}

export interface FieldsOutput {
  texts: { id: string; en: string }[];
  /** Своя камера — если её просили. */
  kit: { camera: string; lens: string; look: string; lensNote: string } | null;
  /** Своя съёмка — если её просили: фраза стиль-блока и язык камеры для писателя. */
  shooting?: { operation: string; language: string } | null;
  notesRu: string;
}

const trimmed = (text: string | undefined): string => (text ?? '').trim();

/**
 * Поля, чей английский разошёлся с русским. `compose` — всё, что стоит перевести за одну кнопку (плюс
 * последствия для следующих кадров); `shot` — только то, что попадает в промпт этого кадра.
 */
export function staleFields(project: Project, shot: Shot, scope: 'shot' | 'compose' = 'shot'): FieldItem[] {
  const items: FieldItem[] = [];
  const { place, weather } = project.world;
  if (needsAgent(place.ru, place.en, place.enFor)) items.push({ id: 'place', kind: 'place', ru: place.ru.trim(), labelRu: 'место' });
  if (needsAgent(weather.ru, weather.en, weather.enFor)) items.push({ id: 'weather', kind: 'weather', ru: weather.ru.trim(), labelRu: 'погода и свет' });
  for (const entity of project.entities) {
    const ru = trimmed(entity.nameRu);
    if (needsAgent(ru, entity.name, entity.nameFor, false)) items.push({ id: `entity:${entity.key}`, kind: entity.kind, ru, labelRu: ru === '' ? entity.name : `«${ru}»` });
  }
  const states = scope === 'compose' ? project.states : activeStates(project, shot.id);
  for (const state of states) {
    if (needsAgent(state.titleRu, state.en, state.enFor)) items.push({ id: `state:${state.id}`, kind: 'state', ru: state.titleRu.trim(), labelRu: `последствие ${state.id}` });
  }
  if (shot.kitId === 'custom') {
    const kit = shot.customKit;
    const ru = trimmed(kit.ru);
    if (needsAgent(ru, kit.camera, kit.enFor, false)) items.push({ id: 'kit', kind: 'camera', ru, labelRu: 'своя камера' });
  }
  if (shot.roleSplit !== null) {
    const ru = trimmed(shot.roleSplit.propsRu);
    if (needsAgent(ru, shot.roleSplit.propsEn, shot.roleSplit.propsFor, false)) items.push({ id: 'props', kind: 'props', ru, labelRu: 'реквизит' });
  }
  const shooting = shootingOf(shot);
  if (shooting.mode === CUSTOM_SHOOTING) {
    const ru = trimmed(shooting.ru);
    if (needsAgent(ru, shooting.operation, shooting.enFor, false)) items.push({ id: 'shooting', kind: 'shooting', ru, labelRu: 'своя съёмка' });
  }
  return items;
}

/** Отрезки, которым нужен писатель: биты изменились или абзаца нет. С пустыми битами абзац просто стирается. */
export const staleSegments = (shot: Shot): string[] => shot.segments.filter(segmentNeedsWriter).map((s) => s.id);

/** Что осталось сделать агентам — одной строкой: `shot` для блокера кадра, `compose` для кнопки. */
export function pendingLabels(project: Project, shot: Shot, scope: 'shot' | 'compose' = 'shot'): string[] {
  const fields = staleFields(project, shot, scope).map((item) => item.labelRu);
  const segments = shot.segments.flatMap((segment, i) => (segmentNeedsWriter(segment) ? [`отрезок ${i + 1}`] : []));
  return [...fields, ...segments];
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ответ агента полей → проект. `enFor` — русский на момент запроса: если владелец печатал, пока агент
 * работал, поле останется устаревшим и уйдёт в следующую сборку. Очищенные поля стираются без агента.
 * Сменилось имя героя — абзацы, где стоит старое имя, помечаются к переписыванию во всех кадрах.
 */
export function applyFields(project: Project, shotId: string, requested: FieldItem[], output: FieldsOutput | null): Project {
  const byId = new Map((output?.texts ?? []).map((t) => [t.id, t.en.trim()]));
  const got = (item: FieldItem): string | undefined => (item.ru === '' ? '' : byId.get(item.id));
  const asked = new Map(requested.map((item) => [item.id, item]));
  const renamed: string[] = [];

  /** Английский от агента и русский, из которого он сделан; undefined — поле не просили или агент его пропустил. */
  const answer = (id: string): { en: string; enFor: string } | undefined => {
    const item = asked.get(id);
    const en = item === undefined ? undefined : got(item);
    return item === undefined || en === undefined ? undefined : { en, enFor: item.ru };
  };
  const unit = (value: TextUnit, id: string): TextUnit => {
    const a = answer(id);
    return a === undefined ? value : { ...value, ...a, source: a.en === '' ? 'empty' : 'llm', locked: false };
  };

  let next: Project = {
    ...project,
    world: { ...project.world, place: unit(project.world.place, 'place'), weather: unit(project.world.weather, 'weather') },
    entities: project.entities.map((entity) => {
      const item = asked.get(`entity:${entity.key}`);
      const name = item === undefined ? undefined : got(item);
      if (item === undefined || name === undefined) return entity;
      if (entity.name.trim() !== '' && entity.name.trim() !== name) renamed.push(entity.name.trim());
      return { ...entity, name, nameFor: item.ru };
    }),
    states: project.states.map((state) => ({ ...state, ...answer(`state:${state.id}`) })),
    shots: project.shots.map((shot) => {
      if (shot.id !== shotId) return shot;
      const kitItem = asked.get('kit');
      const propsItem = asked.get('props');
      let out = shot;
      if (kitItem !== undefined && (kitItem.ru === '' || output?.kit != null)) {
        const kit = kitItem.ru === '' ? { camera: '', lens: '', look: '', lensNote: '' } : (output?.kit ?? { camera: '', lens: '', look: '', lensNote: '' });
        out = { ...out, customKit: { ...out.customKit, camera: kit.camera.trim(), lens: kit.lens.trim(), look: kit.look.trim(), lensNote: kit.lensNote.trim(), enFor: kitItem.ru } };
      }
      const props = propsItem === undefined ? undefined : got(propsItem);
      if (propsItem !== undefined && props !== undefined && out.roleSplit !== null) out = { ...out, roleSplit: { ...out.roleSplit, propsEn: props, propsFor: propsItem.ru } };
      const shootingItem = asked.get('shooting');
      if (shootingItem !== undefined && (shootingItem.ru === '' || output?.shooting != null)) {
        const written = shootingItem.ru === '' ? { operation: '', language: '' } : (output?.shooting ?? { operation: '', language: '' });
        out = { ...out, shooting: { ...shootingOf(out), operation: written.operation.trim(), language: written.language.trim(), enFor: shootingItem.ru } };
      }
      return out;
    }),
  };

  if (renamed.length > 0) {
    const old = new RegExp(`(?<![\\p{L}\\d])(${renamed.map(escapeRe).join('|')})(?![\\p{L}\\d])`, 'u');
    next = { ...next, shots: next.shots.map((shot) => ({ ...shot, segments: shot.segments.map((s) => (s.beatsRu.trim() !== '' && old.test(s.text.en) ? { ...s, text: { ...s.text, enFor: '' } } : s)) })) };
  }
  return next;
}

/**
 * Абзацы писателя → кадр. `beats` — биты на момент запроса (по ним стоит `enFor`); отрезки с
 * очищенными битами стираются.
 */
export function applyWrite(shot: Shot, blocks: { segmentId: string; en: string }[], beats: Record<string, string>): Shot {
  const byId = new Map(blocks.map((b) => [b.segmentId, b.en]));
  return {
    ...shot,
    segments: shot.segments.map((s) => {
      const en = byId.get(s.id);
      if (en !== undefined) return { ...s, text: { ...s.text, en, enFor: beats[s.id] ?? s.beatsRu, source: 'llm', locked: false } };
      if (segmentNeedsWriter(s) && s.beatsRu.trim() === '') return { ...s, text: { ...s.text, en: '', enFor: '', source: 'empty', locked: false } };
      return s;
    }),
  };
}
