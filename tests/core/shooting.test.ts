import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shootingFormat, type ShootingPack, type VerbatimPack } from '../../src/core/compile/compile.ts';
import { applyFields, staleFields, type FieldsOutput } from '../../src/core/compose.ts';
import { normalizeFields, validateFields } from '../../src/core/llm/buildFields.ts';
import { buildCriticUser } from '../../src/core/llm/buildCritic.ts';
import { buildPlannerUser, validatePlan, type PlannerOutput } from '../../src/core/llm/buildPlanner.ts';
import { buildWriterUser } from '../../src/core/llm/buildWriter.ts';
import { lintText } from '../../src/core/lint/index.ts';
import { newProject, storyboardFrames, syncPanel, type Project, type Shot } from '../../src/core/model/project.ts';
import { agentShooting, buildShot, kitOf, type PackBundle } from '../../src/core/pipeline.ts';

/**
 * Решение 37: режимы съёмки и склейки. Метод гайда обязан собираться байт в байт как раньше (это держит и golden),
 * остальные режимы — своими формулами, а правила ручной камеры в них молчат.
 */
const DIR = path.join(import.meta.dirname, '../../packs/cinema-doc');
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as T;
const kits: PackBundle['kits'] = {};
for (const file of readdirSync(path.join(DIR, 'kits'))) {
  const kit = read<PackBundle['kits'][string]>(`kits/${file}`);
  kits[kit.id] = kit;
}
const shootingPack = read<ShootingPack>('shooting.json');
const base: PackBundle = { id: 'cinema-doc', verbatim: read<VerbatimPack>('verbatim.json'), kits, dialects: read('dialects.json'), lexicon: read('lexicon.json'), lintParams: read('lint.json') };
const pack: PackBundle = { ...base, shooting: shootingPack };

const unit = (en: string) => ({ ru: '', en, source: 'manual' as const, locked: true });
const flags = { hasPeople: false, hasText: false, studioBackdrop: false };
const CLEAN = [
  '{{intro:alex}} stands near the pickup in a medium shot, looks into the lens and {{line:L1}}',
  'A cloud passes, the light shifts for two seconds, then returns. Alexander nods and walks out of frame. A second of silence, just the wind. Someone laughs off-screen. The camera slowly lowers, as if the arms holding it are finally tired.',
];

function make(shotPatch: Partial<Shot> = {}, patch: Partial<Project> = {}, segments: string[] = CLEAN): { project: Project; shot: Shot } {
  const project0 = newProject('demo', 'Демо');
  const first = project0.shots[0];
  if (first === undefined) throw new Error('нет кадра');
  const shot: Shot = { ...first, panel: ['loc', 'hero', 'f1', 'f2'], locationRefs: ['loc'], segments: segments.map((en, i) => ({ id: `seg-${i + 1}`, titleRu: '', beatsRu: '', text: unit(en) })), ...shotPatch };
  const project: Project = {
    ...project0,
    world: { place: unit('a quiet embankment'), useOnlyEn: 'the space and sky', weather: unit('Wet asphalt, puddles reflecting the sky, steam rising, a light wind in the clothes.') },
    refs: [
      { key: 'loc', label: 'Набережная', kind: 'location', file: null, flags },
      { key: 'hero', label: 'Герой', kind: 'character', file: null, flags },
      { key: 'f1', label: 'Кадр 1', kind: 'frame', file: null, flags, note: 'A man in a grey hoodie by a white pickup at dawn.' },
      { key: 'f2', label: 'Кадр 2', kind: 'frame', file: null, flags },
    ],
    entities: [{ key: 'alex', name: 'Alexander', kind: 'character', refKey: 'hero' }],
    lines: [{ id: 'L1', speakerKey: 'alex', ru: 'Привет, это проверка.', proofread: true }],
    ...patch,
  };
  return { project: { ...project, shots: [shot] }, shot };
}
const build = (shotPatch: Partial<Shot> = {}, patch: Partial<Project> = {}, segments?: string[], bundle = pack) => {
  const { project, shot } = make(shotPatch, patch, segments);
  return buildShot(project, shot, bundle);
};
const rules = (b: ReturnType<typeof buildShot>): string[] => b.findings.map((f) => f.ruleId);
const codes = (b: ReturnType<typeof buildShot>): string[] => b.blockers.map((x) => x.code);
const mode = (id: string) => {
  const found = shootingPack.modes.find((m) => m.id === id);
  if (found === undefined) throw new Error(`нет режима ${id}`);
  return found;
};

describe('режимы съёмки: метод гайда не меняется', () => {
  it('зачин документалки + формат + один дубль = дословная формула гайда', () => {
    expect(shootingFormat(shootingPack, mode('handheld-doc'), 'one-take', 30, 'Vertical 9:16', 1)).toBe(base.verbatim.format);
  });

  it('с файлом режимов и без него промпт метода гайда одинаков байт в байт', () => {
    const withModes = build();
    const without = build({}, {}, undefined, base);
    expect(withModes.prompt).toBe(without.prompt);
    expect(withModes.prompt).toContain('unstabilized handheld camera, no stabilization whatsoever');
  });

  it('кадр без поля shooting — метод гайда, один дубль', () => {
    const { shot } = make();
    expect(shot.shooting).toBeUndefined();
    expect(agentShooting(shot, pack)).toEqual({ mode: 'handheld-doc', guide: true, structure: 'one-take', cameraLanguage: mode('handheld-doc').language });
  });
});

describe('режимы съёмки: кино, стедикам, дрон', () => {
  it('тележка и кран: своя фраза работы камеры, ремесло вместо стека дефектов, правило про группу', () => {
    const b = build({ shooting: { mode: 'rig', structure: 'one-take', operation: '', language: '' } });
    expect(b.prompt).toContain('Hyperrealistic cinematic film footage');
    expect(b.prompt).toContain(mode('rig').operation ?? '');
    expect(b.prompt).toContain(mode('rig').craft ?? '');
    expect(b.prompt).not.toContain('unstabilized handheld');
    expect(b.prompt).not.toContain('auto-exposure jumps');
    expect(b.prompt).toContain('The camera crew is never visible in frame');
    expect(b.paragraphs.filter((p) => p.origin === 'derived').map((p) => p.kind)).toEqual(['style', 'operator-rule']);
    expect(codes(b)).toEqual([]);
    // Правила ручной камеры здесь не имеют смысла.
    expect(rules(b)).not.toContain('STYLE_HANDHELD_SWITCH');
    expect(rules(b)).not.toContain('STYLE_DEFECT_STACK');
  });

  it('каждый режим не из гайда на чистом кадре — без ошибок и предупреждений, на каждом комплекте', () => {
    for (const m of shootingPack.modes.filter((x) => x.source === 'derived')) {
      for (const kitId of Object.keys(kits)) {
        const b = build({ kitId, panel: ['loc', 'hero'], shooting: { mode: m.id, structure: 'one-take', operation: '', language: '' } });
        const loud = b.findings.filter((f) => f.severity !== 'info').map((f) => f.ruleId);
        expect([m.id, kitId, codes(b), loud]).toEqual([m.id, kitId, [], []]);
      }
    }
  });

  it('режима нет в pack — блокер, а не тихий откат на метод гайда', () => {
    expect(codes(build({ shooting: { mode: 'crane-xl', structure: 'one-take', operation: '', language: '' } }))).toContain('UNKNOWN_SHOOTING');
  });
});

describe('своя съёмка', () => {
  const custom = (patch: Partial<NonNullable<Shot['shooting']>> = {}): Partial<Shot> => ({ shooting: { mode: 'custom', structure: 'one-take', operation: '', language: '', ...patch } });

  it('пусто — блокер с подсказкой; описано, но не собрано — одна кнопка «Собрать промпт»', () => {
    expect(codes(build(custom()))).toContain('CUSTOM_SHOOTING_EMPTY');
    const pending = build(custom({ ru: 'Камера на скейте у самого асфальта' }));
    expect(codes(pending)).toContain('NEEDS_COMPOSE');
    expect(pending.blockers.find((x) => x.code === 'NEEDS_COMPOSE')?.messageRu).toContain('своя съёмка');
  });

  it('собрано — фраза агента в стиль-блоке, язык камеры уходит агентам', () => {
    const ru = 'Камера на скейте у самого асфальта';
    const shotPatch = custom({ ru, enFor: ru, operation: 'camera on a skateboard dolly gliding a few centimeters above the asphalt.', language: 'The camera rides low and fast.' });
    const b = build(shotPatch);
    expect(codes(b)).toEqual([]);
    expect(b.prompt).toContain('camera on a skateboard dolly gliding a few centimeters above the asphalt, shot on');
    const { shot } = make(shotPatch);
    expect(agentShooting(shot, pack)).toMatchObject({ mode: 'custom', guide: false, cameraLanguage: 'The camera rides low and fast.' });
  });

  it('агент полей: слот shooting просится, проверяется и ложится в кадр с отметкой', () => {
    const ru = 'Камера на скейте у самого асфальта';
    const { project, shot } = make(custom({ ru }));
    const items = staleFields(project, shot);
    expect(items.find((item) => item.id === 'shooting')).toMatchObject({ kind: 'shooting', ru });
    const raw: FieldsOutput = { texts: [], kit: null, shooting: { operation: 'camera on a skateboard dolly, fast and smooth.', language: 'Rides low.' }, notesRu: '' };
    const output = normalizeFields(raw, items);
    expect(output.shooting).toEqual({ operation: 'camera on a skateboard dolly, fast and smooth', language: 'Rides low.' });
    expect(validateFields(output, items, project)).toEqual([]);
    expect(validateFields({ ...output, shooting: { operation: 'эпичная камера', language: '' } }, items, project).join(' ')).toContain('Cyrillic');
    const next = applyFields(project, shot.id, items, output);
    expect(next.shots[0]?.shooting).toMatchObject({ operation: 'camera on a skateboard dolly, fast and smooth', language: 'Rides low.', enFor: ru });
  });
});

describe('склейки: несколько шотов в одной генерации', () => {
  const cuts = { shooting: { mode: 'steadicam', structure: 'cuts' as const, operation: '', language: '' } };

  it('формат обещает число шотов, абзацы получают «Shot N.»; «cut to» больше не ошибка', () => {
    const b = build(cuts, {}, [...CLEAN.slice(0, 1), 'Cut to a wide shot: Alexander walks away. A second of silence, just the wind. The camera holds on the empty embankment.']);
    expect(b.prompt).toContain('One 30-second edited sequence of 2 shots joined by hard cuts');
    const scenario = b.paragraphs.filter((p) => p.kind === 'segment').map((p) => p.text);
    expect(scenario[0]?.startsWith('Shot 1. ')).toBe(true);
    expect(scenario[1]?.startsWith('Shot 2. ')).toBe(true);
    expect(rules(b)).not.toContain('ONE_TAKE_CONTRADICTION');
  });

  it('метод гайда со склейками — формат собирается заново, ручная камера остаётся', () => {
    const b = build({ shooting: { mode: 'handheld-doc', structure: 'cuts', operation: '', language: '' } });
    expect(b.prompt).toContain('Hyperrealistic cinematic documentary, indistinguishable from real footage. Vertical 9:16 aspect ratio. One 30-second edited sequence of 2 shots');
    expect(b.prompt).toContain('unstabilized handheld camera');
    expect(b.prompt).not.toContain('no cuts, no edits');
  });

  it('склейки с одним шотом — предупреждение', () => {
    expect(rules(build(cuts, {}, CLEAN.slice(1)))).toContain('CUTS_SINGLE_SHOT');
  });
});

describe('кадры раскадровки', () => {
  it('фразу-привязку пишет компилятор: в склейках шот открывается на кадре, номер — по панели', () => {
    const { project, shot } = make({ shooting: { mode: 'rig', structure: 'cuts', operation: '', language: '' } });
    const framed = { ...shot, segments: shot.segments.map((s, i) => ({ ...s, frameRef: i === 0 ? 'f1' : 'f2' })) };
    const b = buildShot(project, framed, pack);
    const scenario = b.resolvedParagraphs.filter((_, i) => b.paragraphs[i]?.kind === 'segment');
    expect(scenario[0]).toContain('Shot 1. The shot opens exactly on the frame of <<<image_3>>>');
    expect(scenario[1]).toContain('Shot 2. The shot opens exactly on the frame of <<<image_4>>>');
    expect(rules(b)).not.toContain('REF_UNUSED');
  });

  it('в одном дубле: первый отрезок — дубль открывается на кадре, следующие — камера к нему приходит', () => {
    const { project, shot } = make();
    const framed = { ...shot, segments: shot.segments.map((s, i) => ({ ...s, frameRef: i === 0 ? 'f1' : 'f2' })) };
    const text = buildShot(project, framed, pack).prompt;
    expect(text).toContain('The take opens exactly on the frame of <<<image_3>>>');
    expect(text).toContain('The camera arrives at the exact framing of <<<image_4>>>');
  });

  it('картинка ушла из панели или перестала быть кадром — привязка снимается', () => {
    const { project, shot } = make();
    const framed = { ...shot, segments: shot.segments.map((s, i) => ({ ...s, frameRef: i === 0 ? 'f1' : 'f2' })) };
    expect(syncPanel(project, { ...framed, panel: ['loc', 'hero', 'f2'] }).segments.map((s) => s.frameRef)).toEqual([null, 'f2']);
    const asLocation = { ...project, refs: project.refs.map((r) => (r.key === 'f2' ? { ...r, kind: 'location' as const } : r)) };
    const synced = syncPanel(asLocation, framed);
    expect(synced.segments.map((s) => s.frameRef)).toEqual(['f1', null]);
    expect(synced.locationRefs).toEqual(['loc', 'f2']);
    expect(storyboardFrames(project, shot).map((r) => r.key)).toEqual(['f1', 'f2']);
  });
});

describe('локация без референса', () => {
  it('метод гайда — блокер, как раньше; другой режим — место словами и предупреждение', () => {
    expect(codes(build({ panel: ['hero'], locationRefs: [] }))).toContain('NO_LOCATION_REF');
    const b = build({ panel: ['hero'], locationRefs: [], shooting: { mode: 'rig', structure: 'one-take', operation: '', language: '' } });
    expect(codes(b)).toEqual([]);
    expect(rules(b)).toContain('NO_LOCATION_REF');
    expect(b.prompt).toContain('Location: a quiet embankment. Wet asphalt');
    expect(b.prompt).not.toContain('exactly as in');
  });
});

describe('агенты знают режим', () => {
  it('писатель: язык камеры и склейки, кадр раскадровки с тем, что на нём; в методе гайда вход прежний', () => {
    const { project, shot } = make({ shooting: { mode: 'rig', structure: 'cuts', operation: '', language: '' } });
    const framed = { ...shot, segments: shot.segments.map((s, i) => ({ ...s, beatsRu: 'идёт', frameRef: i === 0 ? 'f1' : null })) };
    const kit = kitOf(framed, pack);
    if (kit === undefined) throw new Error('нет комплекта');
    const user = buildWriterUser(project, framed, kit, ['seg-1'], undefined, undefined, agentShooting(framed, pack));
    expect(user).toContain('"singleContinuousTake": false');
    expect(user).toContain(mode('rig').language);
    expect(user).toContain('"whatIsInIt": "A man in a grey hoodie by a white pickup at dawn."');
    const guide = make();
    const guideKit = kitOf(guide.shot, pack);
    if (guideKit === undefined) throw new Error('нет комплекта');
    const guideUser = buildWriterUser(guide.project, guide.shot, guideKit, ['seg-1'], undefined, undefined, agentShooting(guide.shot, pack));
    expect(guideUser).toContain('camera verbs only; the operator is never an actor');
    expect(guideUser).not.toContain('cameraLanguage');
  });

  it('планировщик: при кадрах раскадровки отрезков ровно столько же', () => {
    const { project, shot } = make();
    const frames = storyboardFrames(project, shot).map((r) => ({ label: r.label }));
    const user = buildPlannerUser(project, 'Герой идёт к пикапу.', [], 15, { ...agentShooting(shot, pack), frames });
    expect(user).toMatch(/"segments": \{\s+"min": 2,\s+"max": 2\s+\}/);
    expect(user).toContain('storyboardFrames');
    const plan = (n: number): PlannerOutput => ({ segments: Array.from({ length: n }, (_, i) => ({ titleRu: `${i}`, beatsRu: 'идёт' })), notesRu: '' });
    expect(validatePlan(plan(3), [], 15, 2).join(' ')).toContain('expected 2');
    expect(validatePlan(plan(2), [], 15, 2)).toEqual([]);
  });

  it('критик: склейки — не ошибка, формулы режима помечены как непроверенные', () => {
    const { project, shot } = make({ shooting: { mode: 'drone', structure: 'cuts', operation: '', language: '' } });
    const b = buildShot(project, shot, pack);
    const user = buildCriticUser({ project, shot, paragraphs: b.paragraphs, resolvedParagraphs: b.resolvedParagraphs, durationSec: 30, findings: b.findings, shooting: agentShooting(shot, pack) });
    expect(user).toContain('"singleContinuousTake": false');
    expect(user).toContain('not from the guide, unproven');
    expect(user).toContain(mode('drone').language);
  });
});

describe('линтер: правила ручной камеры выключаются режимом', () => {
  it('без флагов — как раньше; флаги снимают свои правила и только их', () => {
    const text = 'Hyperrealistic cinematic film footage, shot on ARRI Alexa 35. Real human behavior.\n\nLocation: a street.\n\nHe walks. Cut to a wide shot.';
    const options = { lexicon: pack.lexicon, params: pack.lintParams };
    const all = lintText(text, options).map((f) => f.ruleId);
    expect(all).toEqual(expect.arrayContaining(['STYLE_HANDHELD_SWITCH', 'STYLE_DEFECT_STACK', 'ONE_TAKE_CONTRADICTION']));
    const off = lintText(text, { ...options, shooting: { handheld: false, defectStack: false, oneTake: false } }).map((f) => f.ruleId);
    expect(off).not.toEqual(expect.arrayContaining(['STYLE_HANDHELD_SWITCH']));
    expect(off.filter((id) => ['STYLE_HANDHELD_SWITCH', 'STYLE_DEFECT_STACK', 'ONE_TAKE_CONTRADICTION'].includes(id))).toEqual([]);
    expect(all.filter((id) => !['STYLE_HANDHELD_SWITCH', 'STYLE_DEFECT_STACK', 'ONE_TAKE_CONTRADICTION'].includes(id))).toEqual(off);
  });
});
