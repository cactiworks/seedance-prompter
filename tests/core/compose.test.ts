import { describe, expect, it } from 'vitest';
import { applyFields, applyWrite, pendingLabels, staleFields, staleSegments, type FieldsOutput } from '../../src/core/compose.ts';
import { normalizeFields, validateFields } from '../../src/core/llm/buildFields.ts';
import { buildValidationContext, writableSegments } from '../../src/core/llm/buildWriter.ts';
import { validateWriterOutput } from '../../src/core/llm/validate.ts';
import { needsAgent, newProject, type Project, type Shot } from '../../src/core/model/project.ts';

const unit = (ru: string, en = '', enFor?: string) => ({ ru, en, source: en === '' ? ('empty' as const) : ('llm' as const), locked: false, ...(enFor === undefined ? {} : { enFor }) });
const segment = (id: string, beatsRu: string, en = '', enFor?: string) => ({ id, titleRu: '', beatsRu, text: unit('', en, enFor) });

function make(patch: Partial<Project> = {}, shotPatch: Partial<Shot> = {}): { project: Project; shot: Shot } {
  const base = newProject('demo', 'Демо');
  const first = base.shots[0];
  if (first === undefined) throw new Error('нет кадра');
  const shot: Shot = { ...first, segments: [segment('seg-1', 'Саша выходит из пикапа')], ...shotPatch };
  return { project: { ...base, world: { place: unit('Тихая набережная'), useOnlyEn: 'the space', weather: unit('') }, entities: [{ key: 'sasha', nameRu: 'Саша', name: '', kind: 'character', refKey: null }], ...patch, shots: [shot] }, shot };
}

describe('что устарело', () => {
  it('английский без отметки считается сделанным из текущего русского — у полей, где русский был и раньше', () => {
    expect(needsAgent('Набережная', 'the embankment', undefined)).toBe(false);
    expect(needsAgent('Набережная', '', undefined)).toBe(true);
    expect(needsAgent('', 'a quiet embankment', undefined)).toBe(false);
    expect(needsAgent('Набережная у МГУ', 'the embankment', 'Набережная')).toBe(true);
    // Русское поле появилось только сейчас: старый английский ни из чего не сделан.
    expect(needsAgent('Саша', 'Alexander', undefined, false)).toBe(true);
    expect(needsAgent('', 'Alexander', undefined, false)).toBe(false);
  });

  it('список для агента: место, герой, отрезок; очищенное поле тоже в списке — его просто сотрут', () => {
    const { project, shot } = make();
    expect(staleFields(project, shot).map((item) => item.id)).toEqual(['place', 'entity:sasha']);
    expect(staleSegments(shot)).toEqual(['seg-1']);
    expect(pendingLabels(project, shot)).toEqual(['место', '«Саша»', 'отрезок 1']);
    const cleared = { ...project, world: { ...project.world, weather: unit('', 'Wet asphalt.', 'Дождь') } };
    expect(staleFields(cleared, shot).find((item) => item.id === 'weather')?.ru).toBe('');
  });

  it('последствия этого кадра нужны следующим: кнопка их видит, блокер этого кадра — нет', () => {
    const { project, shot } = make({ states: [{ id: 'S1', titleRu: 'Синяк на правой щеке', en: '', originShotId: 'shot-1', resolvedInShotId: null }] });
    expect(staleFields(project, shot, 'shot').some((item) => item.id === 'state:S1')).toBe(false);
    expect(staleFields(project, shot, 'compose').some((item) => item.id === 'state:S1')).toBe(true);
  });
});

describe('ответы агентов → проект', () => {
  it('поля получают английский и отметку, из какого русского он сделан', () => {
    const { project, shot } = make();
    const items = staleFields(project, shot, 'compose');
    const output: FieldsOutput = { texts: [{ id: 'place', en: 'a quiet embankment' }, { id: 'entity:sasha', en: 'Sasha' }], kit: null, notesRu: '' };
    const next = applyFields(project, shot.id, items, output);
    expect(next.world.place).toMatchObject({ en: 'a quiet embankment', enFor: 'Тихая набережная', source: 'llm' });
    expect(next.entities[0]).toMatchObject({ name: 'Sasha', nameFor: 'Саша' });
    const after = next.shots[0];
    expect(after === undefined ? [] : staleFields(next, after)).toEqual([]);
  });

  it('владелец печатал, пока агент работал, — поле остаётся устаревшим', () => {
    const { project, shot } = make();
    const items = staleFields(project, shot, 'compose');
    const typedMeanwhile: Project = { ...project, world: { ...project.world, place: { ...project.world.place, ru: 'Тихая набережная у МГУ' } } };
    const next = applyFields(typedMeanwhile, shot.id, items, { texts: [{ id: 'place', en: 'a quiet embankment' }], kit: null, notesRu: '' });
    const after = next.shots[0];
    expect(after === undefined ? [] : staleFields(next, after).map((item) => item.id)).toContain('place');
  });

  it('сменилось имя героя — абзацы со старым именем помечаются к переписыванию во всех кадрах', () => {
    const written = segment('seg-1', 'Саша выходит', '{{intro:sasha}} steps out. Alexander looks around.', 'Саша выходит');
    const { project, shot } = make({ entities: [{ key: 'sasha', nameRu: 'Саша', name: 'Alexander', nameFor: 'Александр', kind: 'character', refKey: null }], world: { place: unit('Тихая набережная', 'a quiet embankment', 'Тихая набережная'), useOnlyEn: 'the space', weather: unit('') } }, { segments: [written] });
    expect(staleSegments(shot)).toEqual([]);
    const next = applyFields(project, shot.id, staleFields(project, shot, 'compose'), { texts: [{ id: 'entity:sasha', en: 'Sasha' }], kit: null, notesRu: '' });
    const after = next.shots[0];
    expect(after === undefined ? [] : staleSegments(after)).toEqual(['seg-1']);
  });

  it('своя камера: описание → якорь и характер; очищенное описание стирает английский без агента', () => {
    const ru = 'Fujifilm X100V, зерно, приглушённые цвета';
    const { project, shot } = make({}, { kitId: 'custom', customKit: { ru, camera: '', lens: '', look: '', lensNote: '' } });
    const items = staleFields(project, shot, 'compose');
    expect(items.some((item) => item.id === 'kit')).toBe(true);
    const next = applyFields(project, shot.id, items, { texts: [], kit: { camera: 'Fujifilm X100V', lens: 'its fixed 23mm f/2 lens', look: 'fine digital grain, muted colors', lensNote: '' }, notesRu: '' });
    expect(next.shots[0]?.customKit).toMatchObject({ camera: 'Fujifilm X100V', enFor: ru });
    const clearedShot = next.shots[0];
    if (clearedShot === undefined) throw new Error('нет кадра');
    const cleared = { ...next, shots: [{ ...clearedShot, customKit: { ...clearedShot.customKit, ru: '' } }] };
    const back = applyFields(cleared, shot.id, staleFields(cleared, cleared.shots[0] ?? clearedShot, 'compose'), null);
    expect(back.shots[0]?.customKit).toMatchObject({ camera: '', look: '', enFor: '' });
  });

  it('писатель: абзац получает отметку битов на момент запроса; отрезок с очищенными битами стирается', () => {
    const { shot } = make({}, { segments: [segment('seg-1', 'Саша выходит'), segment('seg-2', '', 'Old paragraph.', 'Старые биты')] });
    const next = applyWrite(shot, [{ segmentId: 'seg-1', en: '{{intro:sasha}} steps out.' }], { 'seg-1': 'Саша выходит' });
    expect(next.segments[0]?.text).toMatchObject({ en: '{{intro:sasha}} steps out.', enFor: 'Саша выходит', source: 'llm' });
    expect(next.segments[1]?.text.en).toBe('');
    expect(staleSegments(next)).toEqual([]);
  });
});

describe('агент полей: нормализация и проверка ответа', () => {
  const { project, shot } = make({}, { kitId: 'custom', customKit: { ru: 'Какая-то камера', camera: '', lens: '', look: '', lensNote: '' } });
  const items = staleFields(project, shot, 'compose');

  it('хвостовые точки там, где предложение продолжает компилятор, снимаются без агента', () => {
    const out = normalizeFields({ texts: [{ id: 'place', en: 'a quiet embankment.' }, { id: 'entity:sasha', en: 'Sasha.' }], kit: { camera: 'Fujifilm X100V', lens: '', look: 'fine grain, muted colors.', lensNote: 'Flares stay soft.' }, notesRu: '' }, items);
    expect(out.texts).toEqual([{ id: 'place', en: 'a quiet embankment' }, { id: 'entity:sasha', en: 'Sasha' }]);
    expect(out.kit).toEqual({ camera: 'Fujifilm X100V', lens: '', look: 'fine grain, muted colors', lensNote: 'Flares stay soft' });
  });

  it('ловит пропущенное поле, кириллицу, повтор имени и «кинокамеру» вместо модели', () => {
    const withAlex: Project = { ...project, entities: [...project.entities, { key: 'alex', name: 'Alexander', kind: 'character', refKey: null }] };
    const problems = validateFields({ texts: [{ id: 'entity:sasha', en: 'Alexander' }, { id: 'weather', en: 'Дождь' }], kit: { camera: 'cinematic camera', lens: '', look: 'soft', lensNote: '' }, notesRu: '' }, items, withAlex).join(' ');
    expect(problems).toContain('place must be returned exactly once');
    expect(problems).toContain('weather was not requested');
    expect(problems).toContain('already used by entity:alex');
    expect(problems).toContain('a real model name');
    expect(validateFields({ texts: [{ id: 'place', en: 'a quiet embankment' }, { id: 'entity:sasha', en: 'Sasha' }], kit: { camera: 'Fujifilm X100V', lens: '', look: 'fine grain', lensNote: '' }, notesRu: '' }, items, project)).toEqual([]);
  });
});

describe('писатель: что писать и что обязано стоять', () => {
  it('по умолчанию — только изменённые отрезки с битами; явный список — «переписать кадр»', () => {
    const { shot } = make({}, { segments: [segment('seg-1', 'Биты', 'Done.', 'Биты'), segment('seg-2', 'Новые биты'), segment('seg-3', '')] });
    expect(writableSegments(shot)).toEqual(['seg-2']);
    expect(writableSegments(shot, ['seg-1', 'seg-2', 'seg-3'])).toEqual(['seg-1', 'seg-2']);
  });

  it('последствие прошлого кадра писатель обязан вставить сам — кнопок для этого больше нет', () => {
    const base = make({ states: [{ id: 'S1', titleRu: 'Синяк', en: "Sasha's right cheek shows a light bruise only.", originShotId: 'shot-0', resolvedInShotId: null } ] });
    const shot0 = { ...base.shot, id: 'shot-0' };
    const project: Project = { ...base.project, shots: [shot0, base.shot] };
    const ctx = buildValidationContext(project, base.shot, ['seg-1']);
    const missing = validateWriterOutput({ blocks: [{ segmentId: 'seg-1', en: '{{intro:sasha}} steps out of the pickup.' }] }, ctx);
    expect(missing.map((v) => v.code)).toContain('STATE_MISSING');
    const placed = validateWriterOutput({ blocks: [{ segmentId: 'seg-1', en: '{{intro:sasha}} steps out of the pickup. {{state:S1}}' }] }, ctx);
    expect(placed.map((v) => v.code)).not.toContain('STATE_MISSING');
  });
});
