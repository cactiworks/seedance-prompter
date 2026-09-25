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

export interface ShotCompileInput {
  kit: Kit;
  /** Длительность дубля, с. Формула формата в pack написана под 30 — при другой длительности меняется только число. */
  durationSec?: number;
  /** Формат словами: «Horizontal 16:9». Формула формата в pack написана под «Vertical 9:16» — меняется только эта пара слов. */
  aspectPhrase?: string;
  /** id элементов стека дефектов в порядке pack; по умолчанию — набор комплекта. */
  defects?: string[];
  behavior: string[];
  operatorRule: 'long' | 'short' | 'off';
  locationRule: 'long' | 'short';
  /** Ключи двух референсов локации (в панели кадра). */
  locationRefs: [string, string];
  world: { placeEn: string; useOnlyEn: string; weatherEn: string };
  languageName: string;
  /** Нужен, когда реквизит того же типа, что снимающая техника (приём 06). */
  roleSplit?: { cameraRef: string; lensRef: string; cameraHolder: string; lensHolder: string; propsEn: string };
  /** Сценарные абзацы в плейсхолдерной форме: абзац = отрезок времени. */
  segments: { id: string; en: string }[];
}

export type BlockKind = 'style' | 'format' | 'role-shooting' | 'role-props' | 'camera' | 'lens' | 'flare' | 'imperfections' | 'operator-rule' | 'location' | 'segment';

export interface CompiledParagraph {
  kind: BlockKind;
  /** Слои гайда (1–12), которые закрывает абзац. */
  layers: number[];
  origin: 'verbatim' | 'template' | 'textUnit';
  segmentId?: string;
  /** Текст в плейсхолдерной форме; номера ссылок появятся только после resolve(). */
  text: string;
}

export interface CompileIssue {
  code: 'UNKNOWN_DEFECT' | 'UNKNOWN_BEHAVIOR' | 'KIT_INCOMPLETE' | 'EMPTY_SEGMENT' | 'FORMAT_NO_DURATION' | 'FORMAT_NO_ASPECT';
  messageRu: string;
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

  // Дословная формула гайда написана под 30 секунд; при другой длительности в ней меняется только число.
  const PACK_DURATION = /\b30-second\b/;
  const duration = input.durationSec ?? 30;
  if (duration !== 30 && !PACK_DURATION.test(pack.format)) {
    issues.push({ code: 'FORMAT_NO_DURATION', messageRu: `В формуле формата нет «30-second» — длительность ${duration} с подставить некуда, промпт обещал бы другую.` });
  }
  const timed = duration === 30 ? pack.format : pack.format.replace(PACK_DURATION, `${duration}-second`);
  // То же с форматом кадра: в дословной формуле меняется только «Vertical 9:16».
  const PACK_ASPECT = 'Vertical 9:16';
  const aspect = input.aspectPhrase ?? PACK_ASPECT;
  if (aspect !== PACK_ASPECT && !timed.includes(PACK_ASPECT)) {
    issues.push({ code: 'FORMAT_NO_ASPECT', messageRu: `В формуле формата нет «${PACK_ASPECT}» — формат «${aspect}» подставить некуда, промпт обещал бы другой.` });
  }
  const format = aspect === PACK_ASPECT ? timed : timed.replace(PACK_ASPECT, aspect);

  const defects = pick(input.defects ?? kit.defaultDefects, pack.defects, 'UNKNOWN_DEFECT');
  const behavior = pick(input.behavior, pack.behavior, 'UNKNOWN_BEHAVIOR');
  const tail = `${[pack.exposureLead, ...defects].join(', ')}. ${behavior.join(', ')}. ${fill(pack.languageTail, { LANG: input.languageName })}`;

  if (kit.layout === 'compact') {
    if (kit.look === undefined) issues.push({ code: 'KIT_INCOMPLETE', messageRu: `У комплекта «${kit.id}» нет характера картинки.` });
    // В pack характер и примечание об оптике хранятся без финальной точки — её ставит сборка.
    const lensNote = kit.lensNote === undefined || kit.lensNote === null ? '' : ` ${kit.lensNote}.`;
    paragraphs.push({
      kind: 'style',
      layers: [1, 2, 3, 4, 5],
      origin: 'verbatim',
      text: `${format}, ${pack.handheld}, ${fill(pack.shotOn, { ANCHOR: kit.anchor })}, ${kit.look ?? ''}.${lensNote} ${tail}`,
    });
  } else {
    // Раскладка с отдельными абзацами камеры, объектива и блика. Разделение ролей нужно, только когда
    // в кадре есть такая же техника-реквизит (приём 06); без реквизита якорь техники стоит в первом абзаце.
    const role = input.roleSplit;
    paragraphs.push(
      role === undefined
        ? { kind: 'format', layers: [1, 2, 3], origin: 'verbatim', text: `${format}, ${pack.handheld}, ${fill(pack.shotOn, { ANCHOR: kit.anchor })}.` }
        : { kind: 'format', layers: [1, 2], origin: 'verbatim', text: `${format}, ${pack.handheld}.` },
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
    paragraphs.push({ kind: 'imperfections', layers: [5], origin: 'verbatim', text: tail });
  }

  if (input.operatorRule !== 'off') {
    paragraphs.push({ kind: 'operator-rule', layers: [6], origin: 'verbatim', text: pack.operatorRule[input.operatorRule] });
  }

  const refs = { REF1: placeholder('ref', input.locationRefs[0]), REF2: placeholder('ref', input.locationRefs[1]) };
  // Формула гайда написана под два референса локации. С одним — «exactly as in N and N» читается как опечатка; пара схлопывается.
  const single = input.locationRefs[0] === input.locationRefs[1] ? `${refs.REF1} and ${refs.REF1}` : null;
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

  for (const segment of input.segments) {
    if (segment.en.trim() === '') {
      issues.push({ code: 'EMPTY_SEGMENT', messageRu: `Сегмент ${segment.id} без текста.` });
      continue;
    }
    paragraphs.push({ kind: 'segment', layers: [8, 9, 10, 11, 12], origin: 'textUnit', segmentId: segment.id, text: segment.en });
  }

  return { paragraphs, issues };
}

/** Абзацы разделяются пустой строкой — как в гайде и в поле промпта Higgsfield. */
export function joinParagraphs(paragraphs: CompiledParagraph[]): string {
  return paragraphs.map((p) => p.text).join('\n\n');
}
