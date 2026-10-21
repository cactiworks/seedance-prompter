import { compileShot, joinParagraphs, type CompiledParagraph, type CompileIssue, type Kit, type ShootingMode, type ShootingPack, type VerbatimPack } from './compile/compile.ts';
import { resolve, type DialectPack, type ResolveIssue } from './compile/dialect.ts';
import { pendingLabels, staleFields } from './compose.ts';
import type { AgentShooting } from './llm/buildWriter.ts';
import { lintText, type Finding, type Lexicon, type LintParams } from './lint/index.ts';
import { countWords } from './lint/tokenize.ts';
import { reviewBlockers, type BuildBlocker } from './review.ts';
import { activeStates, CUSTOM_SHOOTING, durationOf, GUIDE_SHOOTING, isObjectRef, shootingOf, type Project, type Shot, type Structure } from './model/project.ts';

/** Всё, что ядру нужно знать о режиме съёмки. Код правил гайда не знает — он исполняет pack. */
export interface PackBundle {
  id: string;
  verbatim: VerbatimPack;
  kits: Record<string, Kit>;
  dialects: DialectPack;
  lexicon: Lexicon;
  lintParams: LintParams;
  /** Режимы съёмки и монтаж (shooting.json). Нет — только метод гайда. */
  shooting?: ShootingPack;
}

export interface ShotShooting {
  /** undefined — режима нет в pack (тогда сборку держит блокер). */
  mode: ShootingMode | undefined;
  structure: Structure;
  /** Метод гайда: ручная документальная, дословные формулы. */
  guide: boolean;
}

/**
 * Режим съёмки кадра. У своей съёмки фраза стиль-блока и язык камеры — из ответа агента полей по описанию
 * владельца; остальное (зачин, ремесло, правило про группу) — из записи custom в pack.
 */
export function shootingModeOf(shot: Shot, pack: PackBundle): ShotShooting {
  const shooting = shootingOf(shot);
  const modes = pack.shooting?.modes ?? [];
  const found = modes.find((m) => m.id === shooting.mode);
  const mode = found !== undefined && found.source === 'custom' ? { ...found, operation: shooting.operation.trim().replace(/[.\s]+$/, ''), language: shooting.language.trim() } : found;
  return { mode, structure: shooting.structure, guide: shooting.mode === GUIDE_SHOOTING };
}

/** Режим съёмки для агентов (планировщик, писатель, критик): id, монтаж и язык камеры. */
export function agentShooting(shot: Shot, pack: PackBundle): AgentShooting {
  const resolved = shootingModeOf(shot, pack);
  return { mode: resolved.mode?.id ?? shootingOf(shot).mode, guide: resolved.guide, structure: resolved.structure, cameraLanguage: resolved.mode?.language ?? '' };
}

export interface ShotBuild {
  /** Абзацы в плейсхолдерной форме с происхождением. */
  paragraphs: CompiledParagraph[];
  /** Итоговый текст для вставки в Higgsfield. */
  prompt: string;
  /** Итог по абзацам — для предпросмотра и привязки находок. */
  resolvedParagraphs: string[];
  /** Блокирующие проблемы сборки: пока они есть, промпт копировать нельзя. */
  blockers: BuildBlocker[];
  findings: Finding[];
  metrics: { chars: number; words: number; speechWords: number; speechCapacity: number; refsInPanel: number; refsUsed: number };
}

export const CUSTOM_KIT = 'custom';
/** Список «что брать с референса локации» из удачных промптов гайда. */
export const DEFAULT_USE_ONLY = 'the space, architecture, ground, water, sky, and weather';
const CUSTOM_DEFECTS = ['ae-jumps', 'focus-hunting', 'af-breathes', 'horizon-slight', 'hand-repositioning', 'breathing'];

/** Своя камера собирается той же формулой стиль-блока, что комплекты гайда. */
function customKit(shot: Shot, blockers: ShotBuild['blockers'], pending: boolean): Kit {
  const clean = (text: string): string => text.trim().replace(/[.\s]+$/, '');
  const { camera, lens, look, lensNote } = shot.customKit;
  const described = (shot.customKit.ru ?? '').trim() !== '';
  // Пока агент не перевёл описание, о пустых английских полях говорит один блокер NEEDS_COMPOSE.
  if (!described && clean(camera) === '') blockers.push({ code: 'CUSTOM_KIT_EMPTY', messageRu: 'Своя камера: опиши технику и картинку в секции «Как снято» — модель камеры, объектив, какое зерно, цвет, блики.' });
  else if (!pending && clean(camera) === '') blockers.push({ code: 'CUSTOM_KIT_NO_CAMERA', messageRu: 'Своя камера: агент не понял, какая это модель. Приём 01 — реальное название техники, а не «кинокамера»: допиши модель в описание.' });
  else if (!pending && clean(look) === '') blockers.push({ code: 'CUSTOM_KIT_NO_LOOK', messageRu: 'Своя камера: нет характера картинки. Одного названия мало — допиши в описание зерно, цвет, контраст, блики.' });
  // Кириллицу в полях ловит линтер (HYG_CYRILLIC_OUTSIDE_QUOTES) — с абзацем и самим словом; второй раз не называем.
  return {
    id: CUSTOM_KIT,
    titleRu: 'Своя камера',
    anchor: clean(lens) === '' ? clean(camera) : `${clean(camera)} with ${clean(lens)}`,
    layout: 'compact',
    look: clean(look),
    lensNote: clean(lensNote) === '' ? null : clean(lensNote),
    defaultDefects: CUSTOM_DEFECTS,
    signatureTerms: [],
    source: 'custom',
  };
}

/** Комплект кадра — из pack или свой. Нужен и конвейеру, и агенту-писателю. */
export function kitOf(shot: Shot, pack: PackBundle): Kit | undefined {
  return shot.kitId === CUSTOM_KIT ? customKit(shot, [], true) : pack.kits[shot.kitId];
}

/** Кто держит технику-реквизит: имя героя по ключу; строка — из проектов до 25.09. */
export function holderName(project: Project, key: string | undefined, legacy: string): string {
  const entity = key === undefined || key === '' ? undefined : project.entities.find((e) => e.key === key);
  return entity === undefined ? legacy.trim() : entity.name.trim();
}

const blocker = (issue: CompileIssue | ResolveIssue): { code: string; messageRu: string } => ({ code: issue.code, messageRu: issue.messageRu });

/** Правила о сценарии: пока не написан ни один абзац, они срабатывают на пустоте и только шумят. */
const SCENARIO_RULES = new Set(['FINALE_PRESENT', 'FINALE_COMMAND', 'LIGHT_EVENT', 'SHOT_SIZE_KEY_MOMENTS', 'REF_UNUSED', 'CONT_STATE_PRESENT']);

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type StructuralDraft = Pick<Finding, 'ruleId' | 'severity' | 'family' | 'messageRu' | 'fixHintRu' | 'evidence'> & { id: string; paragraph?: number };

/** Проект + кадр → промпт, находки линтера, метрики. Чистая функция: работает в браузере на каждое нажатие. */
export function buildShot(project: Project, shot: Shot, pack: PackBundle): ShotBuild {
  const blockers: ShotBuild['blockers'] = [];
  // Всё, что владелец написал по-русски, а агенты ещё не перевели, — одним блокером: одна причина, одна кнопка.
  const pending = pendingLabels(project, shot);
  const fieldsPending = new Set(staleFields(project, shot).map((item) => item.id));
  if (pending.length > 0) blockers.push({ code: 'NEEDS_COMPOSE', messageRu: `Изменено после сборки: ${pending.join(', ')}. Нажми «Собрать промпт» — агент перепишет это в промпт.` });

  const kit = shot.kitId === CUSTOM_KIT ? customKit(shot, blockers, fieldsPending.has('kit')) : pack.kits[shot.kitId];
  if (kit === undefined) {
    return { paragraphs: [], prompt: '', resolvedParagraphs: [], blockers: [{ code: 'UNKNOWN_KIT', messageRu: `В pack нет комплекта «${shot.kitId}».` }], findings: [], metrics: { chars: 0, words: 0, speechWords: 0, speechCapacity: 0, refsInPanel: shot.panel.length, refsUsed: 0 } };
  }

  const shooting = shootingModeOf(shot, pack);
  const shootingRaw = shootingOf(shot);
  if (!shooting.guide && shooting.mode === undefined) blockers.push({ code: 'UNKNOWN_SHOOTING', messageRu: `В pack нет режима съёмки «${shootingRaw.mode}». Выбери режим в секции «Как снято».` });
  if (shootingRaw.mode === CUSTOM_SHOOTING) {
    const described = (shootingRaw.ru ?? '').trim() !== '';
    // Пока агент не перевёл описание, о пустых английских полях говорит один блокер NEEDS_COMPOSE.
    if (!described) blockers.push({ code: 'CUSTOM_SHOOTING_EMPTY', messageRu: 'Своя съёмка: опиши в секции «Как снято», как работает камера — на чём стоит, как двигается, как ведёт героя.' });
    else if (!fieldsPending.has('shooting') && shootingRaw.operation.trim() === '') blockers.push({ code: 'CUSTOM_SHOOTING_NOT_WRITTEN', messageRu: 'Своя съёмка: агент не написал, как работает камера. Допиши описание конкретнее и нажми «Собрать промпт».' });
  }

  const [ref1, ref2] = shot.locationRefs;
  // A connected Production start frame already supplies the whole scene. Keep it out of the
  // location-only template, whose verbatim instruction deliberately excludes people/poses.
  const productionFrame = !!project.production && shot.panel.some(key => project.refs.some(r => r.key === key && r.kind === 'frame' && r.file));
  // В методе гайда без референса локации промпт не собирается («текст не заменяет референс»); в других режимах место
  // можно задать только словами — например, предметка в студии, — но об этом стоит знать.
  if (ref1 === undefined && shooting.guide && !productionFrame) blockers.push({ code: 'NO_LOCATION_REF', messageRu: 'Не выбран референс локации. Гайд: «текст не заменяет референс».' });
  if (project.world.place.ru.trim() === '' && project.world.place.en.trim() === '') blockers.push({ code: 'NO_PLACE', messageRu: 'Не описано место: заполни «Место» в секции «Локация и погода».' });
  for (const entity of project.entities) {
    if ((entity.nameRu ?? '').trim() === '' && entity.name.trim() === '') blockers.push({ code: 'ENTITY_NO_NAME', messageRu: `В «Герои и предметы» есть ${entity.kind === 'character' ? 'герой' : 'предмет'} без имени — назови или удали.` });
  }

  // Разделение ролей идёт в промпт шаблоном: пустое поле даст «This is not the camera held by .»
  const role = kit.layout === 'split' ? shot.roleSplit : null;
  const cameraHolder = role === null ? '' : holderName(project, role.cameraHolderKey, role.cameraHolder);
  const lensHolder = role === null ? '' : holderName(project, role.lensHolderKey, role.lensHolder);
  if (role !== null) {
    const propsDescribed = (role.propsRu ?? '').trim() !== '' || role.propsEn.trim() !== '';
    const missing = [cameraHolder === '' && 'кто держит камеру', lensHolder === '' && 'кто показывает объектив', !propsDescribed && 'что за реквизит'].filter(Boolean);
    if (missing.length > 0) blockers.push({ code: 'ROLE_SPLIT_INCOMPLETE', messageRu: `Разделение ролей включено, но не заполнено: ${missing.join(', ')}. Заполни в секции «Как снято» или выключи переключатель.` });
  }

  const hasScenario = shot.segments.some((segment) => segment.text.en.trim() !== '');
  const described = shot.segments.some((segment) => segment.beatsRu.trim() !== '');
  if (!hasScenario && !described) {
    blockers.push({ code: 'NO_SCENARIO', messageRu: 'Сценария нет: в промпте пока только «как снято» и локация. Опиши кадр своими словами и нажми «Разложить по отрезкам» или впиши, что происходит, прямо в отрезок.' });
  }

  const durationSec = durationOf(project, shot);
  const compiled = compileShot(
    {
      kit,
      shooting: shooting.mode === undefined || pack.shooting === undefined ? undefined : { mode: shooting.mode, structure: shooting.structure, pack: pack.shooting },
      durationSec,
      aspectPhrase: pack.dialects.aspect?.phrases[project.aspectRatio],
      defects: shot.defects ?? undefined,
      behavior: shot.behavior,
      operatorRule: shot.operatorRule,
      locationRule: shot.locationRule,
      // Без картинки нельзя создавать фиктивную ссылку. Требование гайда остаётся
      // отдельным блокером NO_LOCATION_REF, который владелец может осознанно снять.
      locationRefs: ref1 === undefined ? null : [ref1, ref2 ?? ref1],
      // «Что брать с референса» — формула гайда; в интерфейсе её нет, поэтому пустое значение не ломает промпт.
      world: { placeEn: project.world.place.en.trim(), useOnlyEn: project.world.useOnlyEn.trim() === '' ? DEFAULT_USE_ONLY : project.world.useOnlyEn, weatherEn: project.world.weather.en.trim() },
      languageName: pack.dialects.languageNames[project.language] ?? project.language,
      roleSplit: role === null ? undefined : { cameraRef: role.cameraRef, lensRef: role.lensRef, cameraHolder, lensHolder, propsEn: role.propsEn.trim().replace(/[.\s]+$/, '') },
      segments: shot.segments.map((segment) => ({ id: segment.id, en: segment.text.en, frameRef: segment.frameRef ?? null })),
    },
    pack.verbatim,
  );
  blockers.push(...compiled.issues.filter((issue) => issue.code !== 'EMPTY_SEGMENT').map(blocker));

  const ctx = {
    panel: shot.panel,
    lines: Object.fromEntries(project.lines.map((line) => [line.id, { ru: line.ru }])),
    entities: Object.fromEntries(project.entities.map((e) => [e.key, { name: e.name, kind: e.kind, refKey: e.refKey ?? undefined, studioBackdrop: project.refs.find((r) => r.key === e.refKey)?.flags.studioBackdrop }])),
    states: Object.fromEntries(project.states.map((state) => [state.id, state.en])),
    dialect: project.dialect,
    language: project.language,
    pack: pack.dialects,
  };

  const segmentNumber = new Map(shot.segments.map((segment, index) => [segment.id, index + 1]));
  const resolvedParagraphs: string[] = [];
  const unresolved = new Set<string>();
  for (const paragraph of compiled.paragraphs) {
    const out = resolve(paragraph.text, ctx);
    const where = paragraph.segmentId === undefined ? '' : `Отрезок ${segmentNumber.get(paragraph.segmentId) ?? '?'}: `;
    for (const issue of out.issues) {
      unresolved.add(issue.placeholder);
      const messageRu = `${where}${issue.messageRu}`;
      if (!blockers.some((b) => b.messageRu === messageRu)) blockers.push({ code: issue.code, messageRu });
    }
    resolvedParagraphs.push(out.text);
  }
  const prompt = resolvedParagraphs.join('\n\n');
  const paragraphOfSegment = new Map(compiled.paragraphs.flatMap((p, i) => (p.segmentId === undefined ? [] : [[p.segmentId, i] as const])));

  const suppressed = new Set(shot.suppressed.map((s) => s.fingerprint));
  const refByNumber = (n: number): string => project.refs.find((r) => r.key === shot.panel[n - 1])?.label ?? '';
  const findings = lintText(prompt, {
    lexicon: pack.lexicon,
    params: pack.lintParams,
    refSyntax: project.dialect.refSyntax,
    dialogueWrap: project.dialect.dialogueWrap,
    panelSize: shot.panel.length,
    durationSec,
    suppressed,
    // Правила ручной документальной съёмки молчат в других режимах, правило «один дубль» — в склейках.
    shooting: { handheld: shooting.mode === undefined || shooting.mode.source === 'guide', defectStack: shooting.mode === undefined || shooting.mode.defects, oneTake: shooting.structure === 'one-take' },
  })
    // Пока сценария нет, правила о сценарии молчат: об этом уже сказал блокер NO_SCENARIO.
    .filter((f) => hasScenario || !SCENARIO_RULES.has(f.ruleId))
    // Неразвёрнутый плейсхолдер уже стоит в блокерах с адресом и причиной.
    .filter((f) => !(f.ruleId === 'HYG_PLACEHOLDER_LEFT' && unresolved.has(f.evidence)))
    .map((f) => {
      if (f.ruleId !== 'REF_UNUSED') return f;
      const n = Number(f.messageRu.match(/№(\d+)/)?.[1]);
      const label = refByNumber(n);
      return label === '' ? f : { ...f, messageRu: `Картинка №${n} «${label}» в панели есть, а в тексте не вызвана.`, evidence: label };
    });

  const source = joinParagraphs(compiled.paragraphs);
  const scenario = compiled.paragraphs.filter((p) => p.kind === 'segment');
  const structural: StructuralDraft[] = [];

  // Непрерывность: текста мало, нужно знать, что было в прошлых кадрах.
  for (const state of activeStates(project, shot.id)) {
    const label = state.titleRu.trim() === '' ? state.id : `${state.id} «${state.titleRu}»`;
    if (hasScenario && !source.includes(`{{state:${state.id}}}`)) {
      structural.push({ id: state.id, ruleId: 'CONT_STATE_PRESENT', family: 'continuity', severity: 'error', evidence: state.en.slice(0, 80), messageRu: `Последствие прошлого кадра ${label} не попало в этот кадр.`, fixHintRu: `Приём 11 «память между кадрами»: вставь ${state.id} кнопкой там, где герой или предмет впервые виден.` });
    }
    const hasSide = /\b(left|right|front|rear|back|both)\b/i.test(state.en);
    const hasLimiter = /\b(no|only|just|slight|light|small|faint)\b/i.test(state.en);
    if (!hasSide || !hasLimiter) {
      structural.push({ id: state.id, ruleId: 'CONT_STATE_COMPLETE', family: 'continuity', severity: 'warning', evidence: state.en.slice(0, 80), messageRu: `У последствия ${label} нет ${[!hasSide && 'стороны', !hasLimiter && 'степени или ограничителя'].filter(Boolean).join(' и ')}.`, fixHintRu: 'Гайд, Кадр 3: «right side only… no blood, no cut, just a light bruise» — иначе модель нарисует разбитое лицо не с той стороны.' });
    }
  }

  // Вне метода гайда место можно задать только словами — но картинка надёжнее текста.
  if (ref1 === undefined && !shooting.guide && !productionFrame) {
    structural.push({ id: 'location', ruleId: 'NO_LOCATION_REF', family: 'refs', severity: 'warning', evidence: '', messageRu: 'Референса локации нет — место модель нарисует по словам, и в каждом прогоне оно будет другим.', fixHintRu: 'Гайд: «текст не заменяет референс». Добавь в панель картинку места с типом «Локация» — или подави находку, если место условное (студия, фон).' });
  }
  // Склейки с одним шотом — это тот же дубль, только с обещанием монтажа, которого не будет.
  const writtenShots = shot.segments.filter((s) => s.text.en.trim() !== '').length;
  if (shooting.structure === 'cuts' && hasScenario && writtenShots < 2) {
    structural.push({ id: 'cuts', ruleId: 'CUTS_SINGLE_SHOT', family: 'budget', severity: 'warning', evidence: '', messageRu: 'Монтаж «шоты со склейками», а шот один — формат обещает склейки, которых в тексте нет.', fixHintRu: 'Добавь отрезки — каждый станет шотом — или переключи монтаж на «один дубль».' });
  }

  // Риски референсов — по флагам, которые ставит владелец или vision-анализ.
  for (const refKey of shot.panel) {
    const ref = project.refs.find((r) => r.key === refKey);
    if (ref === undefined) continue;
    if (ref.flags.hasText) structural.push({ id: ref.key, ruleId: 'REF_TEXT_ON_REF', family: 'refs', severity: 'warning', evidence: ref.label, messageRu: `На референсе «${ref.label}» есть читаемый текст — надписи могут просочиться в кадр.`, fixHintRu: 'Гайд, панель Кадра 1: карточка со спецификациями ненадёжна, чистое фото предмета лучше.' });
    if (ref.flags.hasPeople && isObjectRef(ref)) structural.push({ id: ref.key, ruleId: 'REF_PEOPLE_ON_OBJECT_REF', family: 'refs', severity: 'warning', evidence: ref.label, messageRu: `На референсе предмета «${ref.label}» есть человек — модель может забрать и его.`, fixHintRu: 'Гайд: у пикапа рядом стоял человек — нужна оговорка «only the vehicle» или картинка без людей.' });
    if (ref.flags.studioBackdrop && !project.entities.some((e) => e.refKey === ref.key)) structural.push({ id: ref.key, ruleId: 'REF_STUDIO_BACKDROP', family: 'refs', severity: 'warning', evidence: ref.label, messageRu: `У «${ref.label}» студийный задник, а сущности с этим референсом нет — клаузу «do not take the background» поставить некуда.`, fixHintRu: 'Привяжи референс к герою в секции «Герои и предметы» и вводи его кнопкой-плейсхолдером.' });
  }

  // Герой с референсом назван в сценарии по имени, но к картинке не привязан: модель нарисует случайного человека.
  for (const entity of project.entities) {
    if (entity.refKey === null || !shot.panel.includes(entity.refKey) || entity.name.trim() === '') continue;
    if (source.includes(`{{intro:${entity.key}}}`)) continue;
    const name = new RegExp(`(?<![\\p{L}\\d])${escapeRe(entity.name.trim())}(?![\\p{L}\\d])`, 'u');
    const first = scenario.find((p) => name.test(p.text));
    if (first === undefined) continue;
    structural.push({ id: entity.key, ruleId: 'ENTITY_NOT_INTRODUCED', family: 'refs', severity: 'error', evidence: entity.name, paragraph: compiled.paragraphs.indexOf(first), messageRu: `«${entity.name}» действует в сценарии, но к своему референсу не привязан.`, fixHintRu: `При первом появлении вставь его кнопкой «${entity.name}» под абзацем — получится «${entity.name}, matching №…». Без привязки внешность будет случайной.` });
  }

  // Реплики: что стоит в этом кадре, что пусто, что повторено, что потерялось.
  const placed = new Map<string, number>();
  for (const match of scenario.map((p) => p.text).join('\n').matchAll(/\{\{line:(L\d+)\}\}/g)) placed.set(match[1] ?? '', (placed.get(match[1] ?? '') ?? 0) + 1);
  const placedAnywhere = new Set(project.shots.flatMap((s) => s.segments.flatMap((segment) => [...segment.text.en.matchAll(/\{\{line:(L\d+)\}\}/g)].map((m) => m[1] ?? ''))));
  for (const line of project.lines) {
    const count = placed.get(line.id) ?? 0;
    const where = shot.segments.find((segment) => segment.text.en.includes(`{{line:${line.id}}}`));
    const paragraph = where === undefined ? undefined : paragraphOfSegment.get(where.id);
    if (count > 0 && line.ru.trim() === '') blockers.push({ code: 'LINE_EMPTY', messageRu: `Реплика ${line.id} стоит в сценарии, а текста у неё нет — в промпт уйдут пустые кавычки.` });
    else if (count > 0 && !line.proofread) blockers.push({ code: 'LINE_NOT_PROOFREAD', messageRu: `Реплика ${line.id} не вычитана: «${line.ru.slice(0, 60)}${line.ru.length > 60 ? '…' : ''}». Озвучка произнесёт её буква в букву — проверь и отметь «вычитана».` });
    if (count > 1) structural.push({ id: line.id, ruleId: 'LINE_REPEATED', family: 'lines', severity: 'warning', evidence: line.ru.slice(0, 80), paragraph, messageRu: `Реплика ${line.id} вставлена ${count} раза — герой произнесёт её дважды.`, fixHintRu: 'Оставить одну вставку.' });
    if (count > 0 && /\d/.test(line.ru)) structural.push({ id: line.id, ruleId: 'LINE_DIGITS', family: 'lines', severity: 'warning', evidence: line.ru.slice(0, 80), paragraph, messageRu: `В реплике ${line.id} цифры — как их прочитает озвучка, заранее неизвестно.`, fixHintRu: 'Гайд пишет числа словами: «светосила ноль девяносто пять».' });
    if (hasScenario && !placedAnywhere.has(line.id) && line.ru.trim() !== '') structural.push({ id: line.id, ruleId: 'LINE_UNUSED', family: 'lines', severity: 'warning', evidence: line.ru.slice(0, 80), messageRu: `Реплика ${line.id} не стоит ни в одном кадре — в озвучку она не попадёт.`, fixHintRu: `Вставь её кнопкой ${line.id} в нужный абзац или удали из списка реплик.` });
  }

  // Погода описана по-русски, но ещё не переведена — об этом уже говорит NEEDS_COMPOSE.
  if (project.world.weather.en.trim() === '' && project.world.weather.ru.trim() === '') {
    structural.push({ id: 'weather', ruleId: 'NO_WEATHER', family: 'light', severity: 'warning', evidence: '', messageRu: 'Погода и базовый свет не описаны — модель выберет их сама, обычно ровный полдень без физики.', fixHintRu: 'Секция «Локация и погода», тезисно: мокрый асфальт, лужи, пар, ветер; какое солнце. Свет — событие, а не состояние.' });
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  const drop = project.world.weather.en.trim() === '' ? new Set(['WEATHER_PHYSICS']) : new Set<string>();
  // Своя камера ещё не собрана — стиль-блок заведомо с дырой («shot on , .»), и блокер уже назвал причину.
  const styleIndex = compiled.paragraphs.findIndex((p) => p.kind === 'style' || p.kind === 'format');
  const kitHole = shot.kitId === CUSTOM_KIT && shot.customKit.camera.trim() === '';
  const all = [
    ...findings.filter((f) => !drop.has(f.ruleId) && !(kitHole && f.paragraph === styleIndex)),
    ...structural
      .map(({ id, paragraph, ...draft }): Finding => ({ ...draft, paragraph: paragraph ?? null, range: null, fingerprint: `${draft.ruleId}:${id}` }))
      .filter((f) => !suppressed.has(f.fingerprint)),
  ].sort((a, b) => order[a.severity] - order[b.severity]);

  // Какие картинки панели реально вызваны: {{ref:key}} напрямую, {{intro:key}} — через референс сущности.
  const used = new Set<string>();
  for (const match of source.matchAll(/\{\{(ref|intro):([^}]+)\}\}/g)) {
    const refKey = match[1] === 'ref' ? match[2] : project.entities.find((e) => e.key === match[2])?.refKey;
    if (refKey !== undefined && refKey !== null && shot.panel.includes(refKey)) used.add(refKey);
  }
  // Речь считается по вставленным репликам, а не по кавычкам в тексте: от диалекта не зависит.
  const speechWords = project.lines.reduce((n, line) => n + (placed.get(line.id) ?? 0) * countWords(line.ru), 0);
  const { wordsPerSecond, speakingShare } = pack.lintParams.speech;

  return {
    paragraphs: compiled.paragraphs,
    prompt,
    resolvedParagraphs,
    blockers: reviewBlockers(blockers, project, shot, prompt),
    findings: all,
    metrics: { chars: prompt.length, words: countWords(prompt), speechWords, speechCapacity: Math.round(durationSec * speakingShare * wordsPerSecond), refsInPanel: shot.panel.length, refsUsed: used.size },
  };
}
