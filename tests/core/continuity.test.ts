import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeStates, newProject, type Project } from '../../src/core/model/project.ts';
import { buildShot, type PackBundle } from '../../src/core/pipeline.ts';

const DIR = path.join(import.meta.dirname, '../../packs/cinema-doc');
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as T;
const kits: PackBundle['kits'] = {};
for (const file of readdirSync(path.join(DIR, 'kits'))) {
  const kit = read<PackBundle['kits'][string]>(`kits/${file}`);
  kits[kit.id] = kit;
}
const pack: PackBundle = { id: 'cinema-doc', verbatim: read('verbatim.json'), kits, dialects: read('dialects.json'), lexicon: read('lexicon.json'), lintParams: read('lint.json') };

const unit = (en: string) => ({ ru: '', en, source: 'manual' as const, locked: true });
const BRUISE = "Alexander's face shows a slight redness and a small scrape on the right side only — a mark from a recent hit, no blood, no cut, just a light bruise forming under the skin, like a fresh impact.";

/** Ролик гайда в миниатюре: в Кадре 2 Alexander получает удар, в Кадре 3 приходит с синяком. */
function project(bruiseEn: string, shot3Text: string): Project {
  const base = newProject('kamery', 'Три камеры');
  const shot = base.shots[0];
  if (shot === undefined) throw new Error('нет кадра');
  const make = (id: string, en: string) => ({ ...shot, id, panel: ['loc', 'hero'], locationRefs: ['loc'], segments: [{ id: `${id}-seg`, titleRu: '', beatsRu: '', text: unit(en) }] });
  return {
    ...base,
    world: { place: unit('a quiet embankment'), useOnlyEn: 'the space and sky', weather: unit('Wet asphalt, puddles reflecting the sky, a light wind.') },
    refs: [{ key: 'loc', label: 'Место', kind: 'location', file: null, flags: { hasPeople: false, hasText: false, studioBackdrop: false } }, { key: 'hero', label: 'Герой', kind: 'character', file: null, flags: { hasPeople: false, hasText: false, studioBackdrop: false } }],
    entities: [{ key: 'alex', name: 'Alexander', kind: 'character', refKey: 'hero' }],
    states: [{ id: 'S1', titleRu: 'Синяк на правой щеке', en: bruiseEn, originShotId: 'shot-2', resolvedInShotId: null }],
    shots: [make('shot-1', '{{intro:alex}} waves.'), make('shot-2', '{{intro:alex}} is kicked in the head.'), make('shot-3', shot3Text)],
  };
}

const continuity = (p: Project, shotId: string) => {
  const shot = p.shots.find((s) => s.id === shotId);
  if (shot === undefined) throw new Error('нет кадра');
  return buildShot(p, shot, pack).findings.filter((f) => f.family === 'continuity').map((f) => f.ruleId);
};

describe('память между кадрами (приём 11 гайда)', () => {
  it('последствие действует только в кадрах ПОСЛЕ того, где оно возникло', () => {
    const p = project(BRUISE, '{{intro:alex}} stands.');
    expect(activeStates(p, 'shot-1')).toEqual([]);
    expect(activeStates(p, 'shot-2')).toEqual([]);
    expect(activeStates(p, 'shot-3').map((s) => s.id)).toEqual(['S1']);
  });

  it('кадр, забывший синяк из прошлого кадра, получает ошибку — как К3·1 в гайде', () => {
    const p = project(BRUISE, '{{intro:alex}} stands near the pickup.');
    expect(continuity(p, 'shot-3')).toEqual(['CONT_STATE_PRESENT']);
    expect(continuity(p, 'shot-2')).toEqual([]);
  });

  it('вставленное последствие разворачивается буква в букву и снимает ошибку', () => {
    const p = project(BRUISE, '{{intro:alex}} stands near the pickup. {{state:S1}} He holds a bag of ice in his right hand.');
    const shot = p.shots[2];
    if (shot === undefined) throw new Error('нет кадра');
    const build = buildShot(p, shot, pack);
    expect(build.findings.filter((f) => f.family === 'continuity')).toEqual([]);
    expect(build.prompt).toContain('on the right side only — a mark from a recent hit, no blood, no cut');
  });

  it('последствие без стороны и ограничителя — предупреждение: модель нарисует разбитое лицо не с той стороны', () => {
    const p = project("Alexander's face shows a bruise.", '{{intro:alex}} stands. {{state:S1}}');
    expect(continuity(p, 'shot-3')).toEqual(['CONT_STATE_COMPLETE']);
  });

  it('снятое последствие больше не требуется', () => {
    const p = project(BRUISE, '{{intro:alex}} stands.');
    const healed: Project = { ...p, states: p.states.map((s) => ({ ...s, resolvedInShotId: 'shot-3' })) };
    expect(continuity(healed, 'shot-3')).toEqual([]);
  });
});
