import { placeholder } from './placeholders.ts';

/** Дословная часть pack (packs/<id>/verbatim.json). Нарезана из гайда, защищена sha256. */
export interface VerbatimPack {
  format: string;
  handheld: string;
  shotOn: string;
  exposureLead: string;
  defects: Record<string, string>;
  behavior: Record<string, string>;
  languageTail: string;
  operatorRule: { long: string; short: string };
  location: { lead: string; rule: { long: string; short: string }; useOnly: string };
  roleSplit: { shooting: string; props: string };
  finaleTail: string;
  foregroundNoReact: string;
}

export interface Kit {
  id: string;
  titleRu: string;
  anchor: string;
  layout: 'compact' | 'split';
  /** compact */
  look?: string;
  lensNote?: string | null;
  /** split: у комплекта отдельные абзацы камеры, объектива и блика */
  cameraName?: string;
  cameraSpecs?: string;
  lensName?: string;
  lensSpecs?: string;
  flareParagraph?: string;
  effectsList?: string;
  defaultDefects: string[];
  signatureTerms: string[];
  /** guide — формулировки дословно из гайда; derived — собраны по свойствам техники, генерацией не проверены. */
  source?: 'guide' | 'derived' | 'custom';
  noteRu?: string;
}

/**
 * Режим съёмки (packs/<id>/shooting.json). Метод гайда (source: guide) берёт формулы дословно из verbatim:
 * у него operation, craft и правило оператора — null / false.
 */
export interface ShootingMode {
  id: string;
  titleRu: string;
  noteRu: string;
  source: 'guide' | 'derived' | 'custom';
  lead: 'doc' | 'film';
  /** Фраза стиль-блока вместо «unstabilized handheld camera, no stabilization whatsoever»; null — дословно из гайда. */
  operation: string | null;
  /** Вместо «Natural exposure shifts» и стека дефектов, когда defects = false. */
  craft: string | null;
  defects: boolean;
  /** true — правило про съёмочную группу из shooting.json вместо дословного правила оператора гайда. */
  crewRule: boolean;
  /** Язык камеры для писателя, планировщика и критика. */
  language: string;
}

export interface ShootingPack {
  leads: { doc: string; film: string };
  structure: { oneTake: string; cuts: string; shotLabel: string };
  frame: { takeOpens: string; arrives: string; shotOpens: string };
  locationNoRef: string;
  crewRule: { long: string; short: string };
  modes: ShootingMode[];
}

export interface ShotCompileInput {
  kit: Kit;
  /** Режим съёмки и монтаж. Нет — метод гайда, один дубль: сборка байт в байт как в удачных промптах гайда. */
  shooting?: { mode: ShootingMode; structure: 'one-take' | 'cuts'; pack: ShootingPack };
  /** Длительность дубля, с. Формула формата в pack написана под 30 — при другой длительности меняется только число. */
  durationSec?: number;
  /** Формат словами: «Horizontal 16:9». Формула формата в pack написана под «Vertical 9:16» — меняется только эта пара слов. */
  aspectPhrase?: string;
  /** id элементов стека дефектов в порядке pack; по умолчанию — набор комплекта. */
  defects?: string[];
  behavior: string[];
  operatorRule: 'long' | 'short' | 'off';
  locationRule: 'long' | 'short';
  /**
   * Ключи двух референсов локации (в панели кадра). null — референса локации нет: место только текстом.
   * В методе гайда так нельзя («текст не заменяет референс») — там вместо null идёт заглушка и блокер.
   */
  locationRefs: [string, string] | null;
  world: { placeEn: string; useOnlyEn: string; weatherEn: string };
  languageName: string;
  /** Нужен, когда реквизит того же типа, что снимающая техника (приём 06). */
  roleSplit?: { cameraRef: string; lensRef: string; cameraHolder: string; lensHolder: string; propsEn: string };
  /** Сценарные абзацы в плейсхолдерной форме: абзац = отрезок времени (в склейках — шот). frameRef — кадр раскадровки. */
  segments: { id: string; en: string; frameRef?: string | null }[];
}

export type BlockKind = 'style' | 'format' | 'role-shooting' | 'role-props' | 'camera' | 'lens' | 'flare' | 'imperfections' | 'operator-rule' | 'location' | 'segment';

export interface CompiledParagraph {
  kind: BlockKind;
  /** Слои гайда (1–12), которые закрывает абзац. */
  layers: number[];
  /** derived — формула режима съёмки не из гайда (shooting.json), генерацией не проверена. */
  origin: 'verbatim' | 'template' | 'textUnit' | 'derived';
  segmentId?: string;
  /** Текст в плейсхолдерной форме; номера ссылок появятся только после resolve(). */
  text: string;
}

export interface CompileIssue {
  code: 'UNKNOWN_DEFECT' | 'UNKNOWN_BEHAVIOR' | 'KIT_INCOMPLETE' | 'EMPTY_SEGMENT' | 'FORMAT_NO_DURATION' | 'FORMAT_NO_ASPECT' | 'FRAME_NO_PACK';
  messageRu: string;
}

/** Формат кадра не по формуле гайда: зачин режима + формат словами + один дубль или склейки. */
export function shootingFormat(pack: ShootingPack, mode: ShootingMode, structure: 'one-take' | 'cuts', durationSec: number, aspectPhrase: string, shots: number): string {
  const sentence = structure === 'cuts' ? fill(pack.structure.cuts, { D: String(durationSec), N: String(Math.max(1, shots)) }) : fill(pack.structure.oneTake, { D: String(durationSec) });
  return `${pack.leads[mode.lead]} ${aspectPhrase} aspect ratio. ${sentence}`;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Z0-9_]+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** Детерминированная сборка промпта: дословные блоки pack + комплект + мир + сценарные абзацы. */
export function compileShot(input: ShotCompileInput, pack: VerbatimPack): { paragraphs: CompiledParagraph[]; issues: CompileIssue[] } {
  const issues: CompileIssue[] = [];
  const paragraphs: CompiledParagraph[] = [];
  const { kit } = input;

  const pick = (ids: string[], catalog: Record<string, string>, code: 'UNKNOWN_DEFECT' | 'UNKNOWN_BEHAVIOR'): string[] =>
    ids.flatMap((id) => {
      const text = catalog[id];
      if (text === undefined) issues.push({ code, messageRu: `В pack нет элемента «${id}».` });
      return text === undefined ? [] : [text];
    });

  const shooting = input.shooting;
  const mode = shooting?.mode;
  const structure = shooting?.structure ?? 'one-take';
  // Метод гайда и один дубль — формула формата дословная. Иначе формат собирается из зачина режима и монтажа.
  const guideFormat = (mode === undefined || mode.source === 'guide') && structure === 'one-take';
  const derived = mode !== undefined && mode.source !== 'guide';
  const blockOrigin: CompiledParagraph['origin'] = derived ? 'derived' : 'verbatim';
  const duration = input.durationSec ?? 30;
  const PACK_ASPECT = 'Vertical 9:16';
  const aspect = input.aspectPhrase ?? PACK_ASPECT;
  const shots = input.segments.filter((segment) => segment.en.trim() !== '').length;

  let format: string;
  if (guideFormat || shooting === undefined) {
    // Дословная формула гайда написана под 30 секунд; при другой длительности в ней меняется только число.
    const PACK_DURATION = /\b30-second\b/;
    if (duration !== 30 && !PACK_DURATION.test(pack.format)) {
      issues.push({ code: 'FORMAT_NO_DURATION', messageRu: `В формуле формата нет «30-second» — длительность ${duration} с подставить некуда, промпт обещал бы другую.` });
    }
    const timed = duration === 30 ? pack.format : pack.format.replace(PACK_DURATION, `${duration}-second`);
    // То же с форматом кадра: в дословной формуле меняется только «Vertical 9:16».
    if (aspect !== PACK_ASPECT && !timed.includes(PACK_ASPECT)) {
      issues.push({ code: 'FORMAT_NO_ASPECT', messageRu: `В формуле формата нет «${PACK_ASPECT}» — формат «${aspect}» подставить некуда, промпт обещал бы другой.` });
    }
    format = aspect === PACK_ASPECT ? timed : timed.replace(PACK_ASPECT, aspect);
  } else {
    format = shootingFormat(shooting.pack, shooting.mode, structure, duration, aspect, shots);
  }

  // Как работает камера: дословный переключатель гайда или фраза режима.
  const operation = mode?.operation ?? pack.handheld;
  const defectsOn = mode === undefined || mode.defects;
  const defects = defectsOn ? pick(input.defects ?? kit.defaultDefects, pack.defects, 'UNKNOWN_DEFECT') : [];
  const behavior = pick(input.behavior, pack.behavior, 'UNKNOWN_BEHAVIOR');
  // Стек несовершенств — только у ручной документальной съёмки; у киношных режимов вместо него ремесло площадки.
  const lead = defectsOn ? [pack.exposureLead, ...defects].join(', ') : (mode?.craft ?? pack.exposureLead);
  const tail = `${lead}. ${behavior.join(', ')}. ${fill(pack.languageTail, { LANG: input.languageName })}`;

  if (kit.layout === 'compact') {
    if (kit.look === undefined) issues.push({ code: 'KIT_INCOMPLETE', messageRu: `У комплекта «${kit.id}» нет характера картинки.` });
    // В pack характер и примечание об оптике хранятся без финальной точки — её ставит сборка.
    const lensNote = kit.lensNote === undefined || kit.lensNote === null ? '' : ` ${kit.lensNote}.`;
    paragraphs.push({
      kind: 'style',
      layers: [1, 2, 3, 4, 5],
      origin: blockOrigin,
      text: `${format}, ${operation}, ${fill(pack.shotOn, { ANCHOR: kit.anchor })}, ${kit.look ?? ''}.${lensNote} ${tail}`,
    });
  } else {
    // Раскладка с отдельными абзацами камеры, объектива и блика. Разделение ролей нужно, только когда
    // в кадре есть такая же техника-реквизит (приём 06); без реквизита якорь техники стоит в первом абзаце.
    const role = input.roleSplit;
    paragraphs.push(
      role === undefined
        ? { kind: 'format', layers: [1, 2, 3], origin: blockOrigin, text: `${format}, ${operation}, ${fill(pack.shotOn, { ANCHOR: kit.anchor })}.` }
        : { kind: 'format', layers: [1, 2], origin: blockOrigin, text: `${format}, ${operation}.` },
    );
    if (role !== undefined) {
      paragraphs.push({
        kind: 'role-shooting',
        layers: [3],
        origin: 'template',
        text: fill(pack.roleSplit.shooting, {
          CAMERA: kit.cameraName ?? '',
          LENS: kit.lensName ?? '',
          REF1: placeholder('ref', role.cameraRef),
          REF2: placeholder('ref', role.lensRef),
          EFFECTS: kit.effectsList ?? '',
          CAMERA_HOLDER: role.cameraHolder,
          LENS_HOLDER: role.lensHolder,
        }),
      });
      paragraphs.push({ kind: 'role-props', layers: [3, 8], origin: 'template', text: fill(pack.roleSplit.props, { PROPS: role.propsEn }) });
    }
    for (const [kind, name, specs] of [['camera', kit.cameraName, kit.cameraSpecs], ['lens', kit.lensName, kit.lensSpecs]] as const) {
      if (name === undefined || specs === undefined) issues.push({ code: 'KIT_INCOMPLETE', messageRu: `У комплекта «${kit.id}» нет абзаца «${kind}».` });
      else paragraphs.push({ kind, layers: [3, 4], origin: 'verbatim', text: `${name}: ${specs}` });
    }
    if (kit.flareParagraph !== undefined) paragraphs.push({ kind: 'flare', layers: [4, 10], origin: 'verbatim', text: kit.flareParagraph });
    paragraphs.push({ kind: 'imperfections', layers: [5], origin: blockOrigin, text: tail });
  }

  if (input.operatorRule !== 'off') {
    // Не ручная документальная — правило про съёмочную группу: не видно ни оператора, ни рельсов, ни дрона.
    const rule = mode?.crewRule === true && shooting !== undefined ? shooting.pack.crewRule : pack.operatorRule;
    paragraphs.push({ kind: 'operator-rule', layers: [6], origin: mode?.crewRule === true ? 'derived' : 'verbatim', text: rule[input.operatorRule] });
  }

  const locationRefs = input.locationRefs;
  if (locationRefs === null) {
    // Референса локации нет — место только словами, без формулы «exactly as in …» и запрета брать людей с картинки.
    paragraphs.push({
      kind: 'location',
      layers: [7],
      origin: 'template',
      text: [fill(shooting?.pack.locationNoRef ?? 'Location: {PLACE}.', { PLACE: input.world.placeEn }), input.world.weatherEn].filter((part) => part !== '').join(' '),
    });
  } else {
    const refs = { REF1: placeholder('ref', locationRefs[0]), REF2: placeholder('ref', locationRefs[1]) };
    // Формула гайда написана под два референса локации. С одним — «exactly as in N and N» читается как опечатка; пара схлопывается.
    const single = locationRefs[0] === locationRefs[1] ? `${refs.REF1} and ${refs.REF1}` : null;
    const collapse = (text: string): string => (single === null ? text : text.replaceAll(single, refs.REF1));
    paragraphs.push({
      kind: 'location',
      layers: [7],
      origin: 'template',
      text: [
        collapse(fill(pack.location.lead, { ...refs, PLACE: input.world.placeEn })),
        `${collapse(fill(pack.location.rule[input.locationRule], refs))}.`,
        fill(pack.location.useOnly, { LIST: input.world.useOnlyEn }),
        input.world.weatherEn,
      ].filter((part) => part !== '').join(' '),
    });
  }

  // Абзац = отрезок времени; в склейках — шот с номером. Кадр раскадровки привязывается фразой компилятора:
  // шот открывается ровно на этом кадре, в одном дубле — дубль с него начинается или камера к нему приходит.
  let shot = 0;
  for (const segment of input.segments) {
    if (segment.en.trim() === '') {
      issues.push({ code: 'EMPTY_SEGMENT', messageRu: `Сегмент ${segment.id} без текста.` });
      continue;
    }
    shot += 1;
    const parts: string[] = [];
    if (structure === 'cuts' && shooting !== undefined) parts.push(fill(shooting.pack.structure.shotLabel, { I: String(shot) }));
    const frame = segment.frameRef;
    if (frame !== undefined && frame !== null && frame !== '') {
      if (shooting === undefined) issues.push({ code: 'FRAME_NO_PACK', messageRu: 'Кадр раскадровки задан, а формул привязки к кадру в pack нет (shooting.json).' });
      else {
        const { takeOpens, arrives, shotOpens } = shooting.pack.frame;
        parts.push(fill(structure === 'cuts' ? shotOpens : shot === 1 ? takeOpens : arrives, { REF: placeholder('ref', frame) }));
      }
    }
    parts.push(segment.en);
    paragraphs.push({ kind: 'segment', layers: [8, 9, 10, 11, 12], origin: 'textUnit', segmentId: segment.id, text: parts.join(' ') });
  }

  return { paragraphs, issues };
}

/** Абзацы разделяются пустой строкой — как в гайде и в поле промпта Higgsfield. */
export function joinParagraphs(paragraphs: CompiledParagraph[]): string {
  return paragraphs.map((p) => p.text).join('\n\n');
}
