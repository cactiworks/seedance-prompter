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
}

export interface ShotCompileInput {
  kit: Kit;
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
  code: 'UNKNOWN_DEFECT' | 'UNKNOWN_BEHAVIOR' | 'KIT_INCOMPLETE' | 'ROLE_SPLIT_REQUIRED' | 'EMPTY_SEGMENT';
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
      text: `${pack.format}, ${pack.handheld}, ${fill(pack.shotOn, { ANCHOR: kit.anchor })}, ${kit.look ?? ''}.${lensNote} ${tail}`,
    });
  } else {
    // Раскладка с разделением ролей: снимающая техника отделена от такой же техники-реквизита.
    if (input.roleSplit === undefined) {
      issues.push({ code: 'ROLE_SPLIT_REQUIRED', messageRu: `Комплект «${kit.id}» собирается с разделением ролей: укажи, кто держит камеру и объектив-реквизит.` });
    }
    const role = input.roleSplit;
    paragraphs.push({ kind: 'format', layers: [1, 2], origin: 'verbatim', text: `${pack.format}, ${pack.handheld}.` });
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
  paragraphs.push({
    kind: 'location',
    layers: [7],
    origin: 'template',
    text: [
      fill(pack.location.lead, { ...refs, PLACE: input.world.placeEn }),
      `${fill(pack.location.rule[input.locationRule], refs)}.`,
      fill(pack.location.useOnly, { LIST: input.world.useOnlyEn }),
      input.world.weatherEn,
    ].join(' '),
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
