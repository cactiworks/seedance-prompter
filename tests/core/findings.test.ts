import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newProject, type Project, type Shot } from '../../src/core/model/project.ts';
import { buildShot, CUSTOM_KIT, type PackBundle } from '../../src/core/pipeline.ts';

const DIR = path.join(import.meta.dirname, '../../packs/cinema-doc');
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as T;
const kits: PackBundle['kits'] = {};
for (const file of readdirSync(path.join(DIR, 'kits'))) {
  const kit = read<PackBundle['kits'][string]>(`kits/${file}`);
  kits[kit.id] = kit;
}
const pack: PackBundle = { id: 'cinema-doc', verbatim: read('verbatim.json'), kits, dialects: read('dialects.json'), lexicon: read('lexicon.json'), lintParams: read('lint.json') };

const unit = (en: string) => ({ ru: '', en, source: 'manual' as const, locked: true });
const flags = { hasPeople: false, hasText: false, studioBackdrop: false };

/** Кадр, к которому у линтера не должно быть претензий: на нём проверяется тишина. */
const CLEAN = [
  '{{intro:alex}} stands near the pickup in a medium shot, looks into the lens and {{line:L1}}',
  'A cloud passes, the light shifts for two seconds, then returns. Alexander nods and walks out of frame. A second of silence, just the wind. Someone laughs off-screen. The camera slowly lowers, as if the arms holding it are finally tired.',
];

function make(segments: string[], patch: Partial<Project> = {}, shotPatch: Partial<Shot> = {}): { project: Project; shot: Shot } {
  const base = newProject('demo', 'Демо');
  const first = base.shots[0];
  if (first === undefined) throw new Error('нет кадра');
  const shot: Shot = { ...first, panel: ['loc', 'hero'], locationRefs: ['loc'], segments: segments.map((en, i) => ({ id: `seg-${i + 1}`, titleRu: '', beatsRu: '', text: unit(en) })), ...shotPatch };
  const project: Project = {
    ...base,
    world: { place: unit('a quiet embankment'), useOnlyEn: 'the space and sky', weather: unit('Wet asphalt, puddles reflecting the sky, steam rising, a light wind in the clothes.') },
    refs: [{ key: 'loc', label: 'Набережная', kind: 'location', file: null, flags }, { key: 'hero', label: 'Герой', kind: 'character', file: null, flags }],
    entities: [{ key: 'alex', name: 'Alexander', kind: 'character', refKey: 'hero' }],
    lines: [{ id: 'L1', speakerKey: 'alex', ru: 'Привет, это проверка.', proofread: true }],
    ...patch,
    shots: [shot],
  };
  return { project, shot };
}

const run = (segments: string[], patch: Partial<Project> = {}, shotPatch: Partial<Shot> = {}) => {
  const { project, shot } = make(segments, patch, shotPatch);
  return buildShot(project, shot, pack);
};
const codes = (build: ReturnType<typeof buildShot>): string[] => build.blockers.map((b) => b.code);
const rules = (build: ReturnType<typeof buildShot>, severity?: string): string[] => build.findings.filter((f) => severity === undefined || f.severity === severity).map((f) => f.ruleId);

describe('окно проверки молчит, когда повода нет', () => {
  it('чистый кадр: ни блокеров, ни ошибок, ни предупреждений', () => {
    const build = run(CLEAN);
    expect(codes(build)).toEqual([]);
    expect(rules(build, 'error')).toEqual([]);
    expect(rules(build, 'warning')).toEqual([]);
  });

  it('чистый кадр остаётся чистым на каждом комплекте, включая телефон, компакт и свою камеру', () => {
    for (const kitId of Object.keys(pack.kits)) {
      const build = run(CLEAN, {}, { kitId });
      expect([kitId, codes(build), rules(build, 'error'), rules(build, 'warning')]).toEqual([kitId, [], [], []]);
    }
    const custom = run(CLEAN, {}, { kitId: CUSTOM_KIT, customKit: { camera: 'Fujifilm X100V', lens: 'its fixed 23mm f/2 lens', look: 'fine digital grain, slightly muted colors, gentle contrast', lensNote: '' } });
    expect([codes(custom), rules(custom, 'error'), rules(custom, 'warning')]).toEqual([[], [], []]);
    expect(custom.prompt).toContain('shot on Fujifilm X100V with its fixed 23mm f/2 lens, fine digital grain, slightly muted colors, gentle contrast.');
  });

  it('диалект ByteDance: реплика в {скобках} — не кириллица вне реплики и не потерянная языковая фраза', () => {
    const build = run(CLEAN, { dialect: { refSyntax: 'at-image', dialogueWrap: 'braces' } });
    expect(build.prompt).toContain('says naturally in Russian: {Привет, это проверка.}');
    expect(build.prompt).toContain('@Image 2');
    expect([codes(build), rules(build, 'error'), rules(build, 'warning')]).toEqual([[], [], []]);
    expect(build.metrics.speechWords).toBe(3);
  });

  it('пока сценарий не написан — один блокер по существу, без россыпи «нет финала / нет света / картинка не вызвана»', () => {
    const build = run(['']);
    expect(codes(build)).toEqual(['NO_SCENARIO']);
    expect(rules(build)).not.toEqual(expect.arrayContaining(['FINALE_PRESENT']));
    for (const noisy of ['FINALE_PRESENT', 'LIGHT_EVENT', 'SHOT_SIZE_KEY_MOMENTS', 'REF_UNUSED', 'LINE_UNUSED']) expect(rules(build)).not.toContain(noisy);
  });

  it('RED без реквизита собирается сам: разделение ролей не требуется', () => {
    const build = run(CLEAN, {}, { kitId: 'red-vraptor-laowa-proteus' });
    expect(codes(build)).toEqual([]);
    expect(build.prompt).toContain('shot on RED V-RAPTOR 8K VV with Laowa Proteus 2x Anamorphic lenses.');
  });
});

describe('окно проверки срабатывает, когда генерация была бы потрачена зря', () => {
  it('герой назван по имени, но не привязан к референсу — ошибка с адресом абзаца', () => {
    const build = run(['Alexander stands near the pickup in a medium shot and {{line:L1}}', CLEAN[1] ?? '']);
    const finding = build.findings.find((f) => f.ruleId === 'ENTITY_NOT_INTRODUCED');
    expect(finding?.severity).toBe('error');
    expect(finding?.paragraph).toBe(build.paragraphs.findIndex((p) => p.kind === 'segment'));
    // Имя внутри другого слова — не упоминание героя.
    const other = run(['{{ref:hero}} shows the Alexanderplatz sign in a medium shot.', CLEAN[1] ?? ''], { entities: [{ key: 'alex', name: 'Alex', kind: 'character', refKey: 'hero' }] });
    expect(rules(other)).not.toContain('ENTITY_NOT_INTRODUCED');
  });

  it('отрезок описан по-русски, но агент его ещё не написал — блокер: кусок сцены молча выпал бы из промпта', () => {
    const { project, shot } = make(CLEAN);
    const withGap: Shot = { ...shot, segments: [...shot.segments, { id: 'seg-3', titleRu: '', beatsRu: 'Герой садится в машину', text: { ru: '', en: '', source: 'empty', locked: false } }] };
    const build = buildShot(project, withGap, pack);
    expect(codes(build)).toEqual(['NEEDS_COMPOSE']);
    expect(build.blockers[0]?.messageRu).toContain('отрезок 3');
    // Биты поменялись после того, как агент написал абзац, — тот же блокер: промпт уже не про то.
    const edited: Shot = { ...shot, segments: shot.segments.map((s, i) => (i === 0 ? { ...s, beatsRu: 'Саша у пикапа, говорит L1', text: { ...s.text, enFor: 'Саша у пикапа' } } : s)) };
    expect(buildShot(project, edited, pack).blockers.map((b) => b.messageRu)).toEqual([expect.stringContaining('отрезок 1')]);
    // Пустой отрезок без описания — просто заготовка, не повод блокировать.
    const blank: Shot = { ...shot, segments: [...shot.segments, { id: 'seg-3', titleRu: '', beatsRu: '', text: { ru: '', en: '', source: 'empty', locked: false } }] };
    expect(codes(buildShot(project, blank, pack))).toEqual([]);
  });

  it('реплики: не вычитана, пустая, повторена, с цифрами, потеряна', () => {
    const line = (id: string, ru: string, proofread = true) => ({ id, speakerKey: null, ru, proofread });
    expect(codes(run(CLEAN, { lines: [line('L1', 'Привет.', false)] }))).toEqual(['LINE_NOT_PROOFREAD']);
    expect(codes(run(CLEAN, { lines: [line('L1', '  ')] }))).toEqual(['LINE_EMPTY']);
    expect(rules(run([`${CLEAN[0]} Then again {{line:L1}}`, CLEAN[1] ?? '']), 'warning')).toContain('LINE_REPEATED');
    expect(rules(run(CLEAN, { lines: [line('L1', 'Светосила 0.95.')] }), 'warning')).toContain('LINE_DIGITS');
    const lost = run(CLEAN, { lines: [line('L1', 'Привет.'), line('L2', 'Эта реплика никуда не вставлена.')] });
    expect(lost.findings.find((f) => f.ruleId === 'LINE_UNUSED')?.messageRu).toContain('L2');
    // Невычитанная реплика, которой в кадре нет, копирование не блокирует.
    expect(codes(run(CLEAN, { lines: [line('L1', 'Привет.'), line('L2', 'Черновик.', false)] }))).toEqual([]);
  });

  it('неразвёрнутый плейсхолдер называется один раз — блокером с номером отрезка, без дубля в находках', () => {
    const build = run([`${CLEAN[0]} He points at {{ref:pickup}}.`, CLEAN[1] ?? '']);
    expect(build.blockers).toEqual([{ code: 'REF_NOT_IN_PANEL', messageRu: 'Отрезок 1: Референс «pickup» не в панели этого кадра.' }]);
    expect(rules(build)).not.toContain('HYG_PLACEHOLDER_LEFT');
  });

  it('невызванная картинка названа по имени, а не только номером', () => {
    const { project, shot } = make(CLEAN);
    const extra: Project = { ...project, refs: [...project.refs, { key: 'pickup', label: 'Пикап', kind: 'object', file: null, flags }] };
    const build = buildShot(extra, { ...shot, panel: ['loc', 'hero', 'pickup'] }, pack);
    expect(build.findings.find((f) => f.ruleId === 'REF_UNUSED')?.messageRu).toBe('Картинка №3 «Пикап» в панели есть, а в тексте не вызвана.');
  });

  it('своя камера: не описана — один блокер; описана, но не переведена — «собери»; без характера — блокер; кириллица — одна ошибка', () => {
    expect(codes(run(CLEAN, {}, { kitId: CUSTOM_KIT }))).toEqual(['CUSTOM_KIT_EMPTY']);
    // Дыра в стиль-блоке («shot on , .») названа блокером — пунктуацией второй раз не называется.
    expect(rules(run(CLEAN, {}, { kitId: CUSTOM_KIT }))).toEqual([]);
    const ru = 'Fujifilm X100V, мелкое зерно, приглушённые цвета';
    const described = run(CLEAN, {}, { kitId: CUSTOM_KIT, customKit: { ru, camera: '', lens: '', look: '', lensNote: '' } });
    expect(codes(described)).toEqual(['NEEDS_COMPOSE']);
    expect(described.blockers[0]?.messageRu).toContain('своя камера');
    expect(codes(run(CLEAN, {}, { kitId: CUSTOM_KIT, customKit: { ru, enFor: ru, camera: 'Fujifilm X100V', lens: '', look: '', lensNote: '' } }))).toEqual(['CUSTOM_KIT_NO_LOOK']);
    const cyrillic = run(CLEAN, {}, { kitId: CUSTOM_KIT, customKit: { camera: 'Кэнон', lens: '', look: 'soft grain', lensNote: '' } });
    expect(codes(cyrillic)).toEqual([]);
    expect(cyrillic.findings.filter((f) => f.severity === 'error').map((f) => [f.ruleId, f.evidence])).toEqual([['HYG_CYRILLIC_OUTSIDE_QUOTES', 'Кэнон']]);
    // «cinematic camera» вместо модели — не якорь (приём 01).
    const generic = run(CLEAN, {}, { kitId: CUSTOM_KIT, customKit: { camera: 'cinematic camera', lens: '', look: 'soft grain', lensNote: '' } });
    expect(rules(generic, 'warning')).toContain('STYLE_REAL_GEAR');
  });

  it('разделение ролей включено, но не заполнено — блокер вместо «This is not the camera held by .»', () => {
    const roleSplit = { cameraRef: 'hero', lensRef: 'hero', cameraHolder: '', lensHolder: 'John', propsEn: '' };
    expect(codes(run(CLEAN, {}, { kitId: 'red-vraptor-laowa-proteus', roleSplit }))).toEqual(['ROLE_SPLIT_INCOMPLETE']);
    // На комплекте без отдельных абзацев техники разделение не действует и ничего не требует.
    expect(codes(run(CLEAN, {}, { roleSplit }))).toEqual([]);
  });

  it('разделение ролей: держатели — герои из списка, реквизит по-русски; имена в шаблон берутся из сущностей', () => {
    const { project } = make(CLEAN);
    const withJohn: Partial<Project> = { entities: [...project.entities, { key: 'john', name: 'John', kind: 'character', refKey: null }] };
    const roleSplit = { cameraRef: 'hero', lensRef: 'hero', cameraHolderKey: 'alex', lensHolderKey: 'john', cameraHolder: '', lensHolder: '', propsRu: 'Саша держит RED, Женя — кейс', propsFor: 'Саша держит RED, Женя — кейс', propsEn: 'Alexander holds a RED V-RAPTOR, and John holds a lens case.' };
    const build = run(CLEAN, withJohn, { kitId: 'red-vraptor-laowa-proteus', roleSplit });
    expect(codes(build)).toEqual([]);
    expect(build.prompt).toContain('This is not the camera held by Alexander. This is not the lens shown by John.');
    // Хвостовую точку реквизита ставит шаблон — двух точек не будет.
    expect(build.prompt).toContain('Separately, Alexander holds a RED V-RAPTOR, and John holds a lens case. These are props');
    // Реквизит описан, но ещё не переведён — «собери», а не «не заполнено».
    expect(codes(run(CLEAN, withJohn, { kitId: 'red-vraptor-laowa-proteus', roleSplit: { ...roleSplit, propsFor: undefined, propsEn: '' } }))).toEqual(['NEEDS_COMPOSE']);
  });

  it('поля по-русски: описано, но не переведено — один блокер «собери» со списком; ничего не описано — свой блокер', () => {
    const { project, shot } = make(CLEAN);
    const typed: Project = { ...project, world: { ...project.world, place: { ru: 'Тихая набережная', en: '', source: 'empty', locked: false }, weather: { ru: 'Дождь закончился', en: '', source: 'empty', locked: false } } };
    const build = buildShot(typed, shot, pack);
    expect(codes(build)).toEqual(['NEEDS_COMPOSE']);
    expect(build.blockers[0]?.messageRu).toContain('место, погода и свет');
    // Погода описана по-русски — предупреждения «погода не описана» нет: об этом уже сказал блокер.
    expect(rules(build)).not.toContain('NO_WEATHER');
    const empty: Project = { ...project, world: { ...project.world, place: { ru: '', en: '', source: 'empty', locked: false } } };
    expect(codes(buildShot(empty, shot, pack))).toEqual(['NO_PLACE']);
    // Переведено агентом — блокера нет; русский поменяли потом — снова «собери».
    const done: Project = { ...typed, world: { ...typed.world, place: { ...typed.world.place, en: 'a quiet embankment', enFor: 'Тихая набережная' }, weather: { ...typed.world.weather, en: 'Wet asphalt, puddles reflecting the sky, steam rising, a light wind in the clothes.', enFor: 'Дождь закончился' } } };
    expect(codes(buildShot(done, shot, pack))).toEqual([]);
    const changed: Project = { ...done, world: { ...done.world, place: { ...done.world.place, ru: 'Набережная у МГУ' } } };
    expect(buildShot(changed, shot, pack).blockers.map((b) => b.messageRu)).toEqual([expect.stringContaining('место')]);
  });

  it('герой: русское имя без перевода — «собери»; без имени вовсе — свой блокер; сценарий только по-русски — не «сценария нет»', () => {
    const { project, shot } = make(CLEAN);
    expect(codes(buildShot({ ...project, entities: [...project.entities, { key: 'sasha', nameRu: 'Саша', name: '', kind: 'character', refKey: null }] }, shot, pack))).toEqual(['NEEDS_COMPOSE']);
    expect(codes(buildShot({ ...project, entities: [...project.entities, { key: 'x', nameRu: '', name: '', kind: 'object', refKey: null }] }, shot, pack))).toEqual(['ENTITY_NO_NAME']);
    // В старом проекте вписали русское имя к английскому — это изменение, а не «уже переведено».
    expect(codes(buildShot({ ...project, entities: [{ key: 'alex', nameRu: 'Саша', name: 'Alexander', kind: 'character', refKey: 'hero' }] }, shot, pack))).toEqual(['NEEDS_COMPOSE']);
    const onlyBeats: Shot = { ...shot, segments: [{ id: 'seg-1', titleRu: '', beatsRu: 'Саша у пикапа', text: { ru: '', en: '', source: 'empty', locked: false } }] };
    expect(codes(buildShot(project, onlyBeats, pack))).toEqual(['NEEDS_COMPOSE']);
  });

  it('погода не описана — одно предупреждение по существу вместо общего «мало физики»', () => {
    const { project, shot } = make(CLEAN);
    const build = buildShot({ ...project, world: { ...project.world, weather: unit('') } }, shot, pack);
    expect(rules(build, 'warning')).toContain('NO_WEATHER');
    expect(rules(build)).not.toContain('WEATHER_PHYSICS');
    expect(build.prompt).not.toMatch(/ \n/);
  });
});

describe('осознанное исключение', () => {
  it('подавленная находка исчезает, остальные остаются; отпечаток структурных находок стабилен', () => {
    const { project, shot } = make(CLEAN, { lines: [{ id: 'L1', speakerKey: null, ru: 'Привет.', proofread: true }, { id: 'L2', speakerKey: null, ru: 'Запасная реплика.', proofread: true }] });
    const before = buildShot(project, shot, pack);
    const target = before.findings.find((f) => f.ruleId === 'LINE_UNUSED');
    expect(target?.fingerprint).toBe('LINE_UNUSED:L2');
    const after = buildShot(project, { ...shot, suppressed: [{ fingerprint: 'LINE_UNUSED:L2', reasonRu: 'Реплика для следующего кадра' }] }, pack);
    expect(rules(after)).not.toContain('LINE_UNUSED');
    expect(after.findings.length).toBe(before.findings.length - 1);
  });
});

describe('формат кадра — параметр ролика, а не константа гайда', () => {
  it('9:16 — формула гайда байт в байт; другой формат меняет в ней только «Vertical 9:16»', () => {
    const vertical = run(CLEAN);
    expect(vertical.prompt).toContain(pack.verbatim.format);
    const wide = run(CLEAN, { aspectRatio: '16:9' });
    expect(wide.prompt).toContain('Horizontal 16:9 aspect ratio. One continuous 30-second take');
    expect(wide.prompt).not.toContain('9:16');
    expect(wide.prompt.replace('Horizontal 16:9', 'Vertical 9:16')).toBe(vertical.prompt);
    // У каждого формата из списка есть формулировка, и чистый кадр на нём остаётся чистым.
    for (const aspectRatio of ['9:16', '3:4', '1:1', '4:3', '16:9', '21:9'] as const) {
      const build = run(CLEAN, { aspectRatio });
      expect([aspectRatio, codes(build), rules(build, 'error'), rules(build, 'warning')]).toEqual([aspectRatio, [], [], []]);
      expect(build.prompt).toContain(`${pack.dialects.aspect?.phrases[aspectRatio]} aspect ratio.`);
    }
    // RED собирается отдельным абзацем формата — формат меняется и там, вместе с длительностью.
    expect(run(CLEAN, { aspectRatio: '1:1' }, { durationSec: 12, kitId: 'red-vraptor-laowa-proteus' }).prompt).toContain('Square 1:1 aspect ratio. One continuous 12-second take');
  });
});

describe('длительность кадра — параметр, а не константа гайда', () => {
  it('30 секунд: формула гайда байт в байт; другая длительность меняет в ней только число', () => {
    expect(run(CLEAN).prompt).toContain(pack.verbatim.format);
    const short = run(CLEAN, {}, { durationSec: 15 });
    expect(short.prompt).toContain('One continuous 15-second take, one uninterrupted shot');
    expect(short.prompt).not.toContain('30-second');
    expect(short.prompt.replace('15-second', '30-second')).toBe(run(CLEAN).prompt);
    // RED собирается отдельным абзацем формата — число меняется и там.
    expect(run(CLEAN, {}, { durationSec: 12, kitId: 'red-vraptor-laowa-proteus' }).prompt).toContain('One continuous 12-second take');
  });

  it('длительность кадра главнее длительности ролика; ёмкость речи считается от неё', () => {
    const { wordsPerSecond, speakingShare } = pack.lintParams.speech;
    expect(run(CLEAN, { durationSec: 20 }).prompt).toContain('20-second take');
    const own = run(CLEAN, { durationSec: 20 }, { durationSec: 10 });
    expect(own.prompt).toContain('10-second take');
    expect(own.metrics.speechCapacity).toBe(Math.round(10 * speakingShare * wordsPerSecond));
  });

  it('реплики, которые влезали в 30 секунд, в 5 секунд не влезают — предупреждение SPEECH_BUDGET', () => {
    const long = { lines: [{ id: 'L1', speakerKey: null, ru: 'Сейчас мы снимаем на другую камеру, и у каждой камеры свой характер, смотрите сами, как меняется картинка.', proofread: true }] };
    expect(rules(run(CLEAN, long), 'warning')).not.toContain('SPEECH_BUDGET');
    expect(rules(run(CLEAN, long, { durationSec: 5 }), 'warning')).toContain('SPEECH_BUDGET');
  });

  it('число секунд, вписанное в абзац руками, сверяется с длительностью кадра', () => {
    const typed = ['{{intro:alex}} stands in a medium shot for the whole 30-second take and {{line:L1}}', CLEAN[1] ?? ''];
    expect(rules(run(typed))).not.toContain('DURATION_MISMATCH');
    const finding = run(typed, {}, { durationSec: 15 }).findings.find((f) => f.ruleId === 'DURATION_MISMATCH');
    expect([finding?.severity, finding?.evidence]).toEqual(['warning', '30-second take']);
    // «shifts for two seconds» — тайминг внутри сцены, а не длительность дубля.
    expect(rules(run(CLEAN, {}, { durationSec: 15 }))).not.toContain('DURATION_MISMATCH');
  });
});
