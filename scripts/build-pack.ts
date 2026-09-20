/**
 * Собирает дословную часть pack из удачных промптов гайда — нарезкой по якорям, без перепечатки.
 *   packs/cinema-doc/verbatim.json       формулировки со слотами {REF1}, {LANG}, …
 *   packs/cinema-doc/kits/*.json         комплекты «камера + объектив»
 *   packs/cinema-doc/verbatim.lock.json  sha256 каждой формулировки — защита от «улучшений»
 *
 * Каждая короткая формулировка, набранная здесь руками, проверяется: она обязана дословно
 * встречаться в промпте гайда, иначе скрипт падает.
 *
 * Запуск: node scripts/build-pack.ts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK = path.join(ROOT, 'packs/cinema-doc');

function paragraphs(id: string): string[] {
  const fixture = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/guide', `${id}.json`), 'utf8')) as { raw: string };
  return fixture.raw.split(/\n+/).map((p) => p.trim()).filter(Boolean);
}

const k1 = paragraphs('k1a3');
const k2 = paragraphs('k2');
const k3 = paragraphs('k3a2');
const ALL = [...k1, ...k2, ...k3].join('\n');

function must(match: RegExpMatchArray | null, what: string): Record<string, string> {
  if (match?.groups === undefined) throw new Error(`якорь не найден: ${what}`);
  return match.groups;
}

/** Набранное руками обязано дословно стоять в гайде. */
function verbatim(text: string): string {
  if (!ALL.includes(text)) throw new Error(`нет в гайде дословно: «${text.slice(0, 60)}…»`);
  return text;
}

// ---------- стиль-блок (компактная раскладка: К1, К2) ----------
const STYLE = /^(?<format>.*?no edits), (?<handheld>unstabilized handheld camera, no stabilization whatsoever), shot on (?<anchor>[^,]+), (?<rest>.*)$/s;
const TAIL = /^(?<look>.*?)\. (?<lead>Natural exposure shifts), (?<defects>.*?)\. (?<behavior>Real human behavior.*?)\. (?<language>All dialogue.*)$/s;

const k1Style = must(k1[0]?.match(STYLE) ?? null, 'К1 стиль');
const k1Tail = must(k1Style.rest?.match(TAIL) ?? null, 'К1 хвост');
const k2Style = must(k2[0]?.match(STYLE) ?? null, 'К2 стиль');
const k2Tail = must(k2Style.rest?.match(TAIL) ?? null, 'К2 хвост');
const k2Look = must(k2Tail.look?.match(/^(?<look>.*?soft highlight roll-off)\. (?<lensNote>The lens coating.*)$/s) ?? null, 'К2 покрытие линз');

const DEFECTS: Record<string, string> = {
  'ae-jumps': verbatim('auto-exposure jumps when the camera turns from bright sky to darker ground'),
  'focus-hunting': verbatim('brief focus hunting during fast movements'),
  'af-breathes': verbatim('manual autofocus that breathes and occasionally misses, then catches up'),
  'zoom-jerks': verbatim('mechanical zoom that jerks slightly when used'),
  'horizon-slight': verbatim('horizon slightly tilted'),
  'horizon-strong': verbatim('horizon tilted'),
  'hand-repositioning': verbatim('camera hand repositioning'),
  'dips-listening': verbatim('camera dips when the operator listens'),
  breathing: verbatim('breathing audible and visible in the frame rhythm'),
};
const BEHAVIOR: Record<string, string> = {
  'real-human': verbatim('Real human behavior'),
  'no-staged': verbatim('no staged acting'),
  'no-theatrical': verbatim('no theatrical gestures'),
  'micro-expressions': verbatim('natural micro-expressions'),
  'subtle-movement': verbatim('constant subtle movement'),
};

// ---------- правило про оператора и локация ----------
const operatorLong = verbatim(k2[1] ?? '');
const operatorShort = verbatim(k3[7] ?? '');

const LOC = /^Location: exactly as in <<<image_\d+>>> and <<<image_\d+>>> — (?<place>.*?)\. (?<rule>Take only the location itself.*?)\. Use only (?<useOnly>.*?)\. (?<weather>.*)$/s;
const k1Loc = must(k1[1]?.match(LOC) ?? null, 'К1 локация');
const k2Loc = must(k2[2]?.match(LOC) ?? null, 'К2 локация');
const slotRefs = (text: string): string => {
  let n = 0;
  return text.replace(/<<<image_\d+>>>/g, () => `{REF${(n++ % 2) + 1}}`);
};

// ---------- раскладка с разделением ролей (К3) ----------
const k3Camera = must(k3[3]?.match(/^(?<name>[^:]+): (?<specs>.*)$/s) ?? null, 'К3 камера');
const k3Lens = must(k3[4]?.match(/^(?<name>[^:]+): (?<specs>.*)$/s) ?? null, 'К3 объектив');
const k3Tail = must(k3[6]?.match(/^(?<lead>Natural exposure shifts), (?<defects>.*?)\. (?<behavior>Real human behavior.*?)\. (?<language>All dialogue.*)$/s) ?? null, 'К3 хвост');
const k3Format = must(k3[0]?.match(/^(?<format>.*?no edits), (?<handheld>.*)\.$/s) ?? null, 'К3 формат');


/** Абзацы разделения ролей К3·2 → шаблоны со слотами; обратная подстановка обязана вернуть оригинал. */
function roleSplit(): { shooting: string; props: string } {
  const slots: Record<string, string> = {
    '{CAMERA}': 'RED V-RAPTOR 8K VV',
    '{LENS}': 'Laowa Proteus 2x Anamorphic lens',
    '{EFFECTS}': 'the anamorphic flares, the horizontal streaks of light, the oval bokeh, the edge distortion',
    '{CAMERA_HOLDER}': 'Alexander',
    '{LENS_HOLDER}': 'John',
    '{PROPS}': 'Alexander holds a RED V-RAPTOR in his hands, and John holds an open case with Laowa Proteus lenses',
  };
  const toTemplate = (text: string): string => {
    let out = slotRefs(text);
    for (const [slot, value] of Object.entries(slots)) {
      if (slot === '{CAMERA_HOLDER}') out = out.replace(`held by ${value}`, `held by ${slot}`);
      else if (slot === '{LENS_HOLDER}') out = out.replace(`shown by ${value}`, `shown by ${slot}`);
      else out = out.replace(value, slot);
    }
    return out;
  };
  const shooting = toTemplate(k3[1] ?? '');
  const props = toTemplate(k3[2] ?? '');
  for (const slot of ['{REF1}', '{REF2}', '{CAMERA}', '{LENS}', '{EFFECTS}', '{CAMERA_HOLDER}', '{LENS_HOLDER}']) {
    if (!shooting.includes(slot)) throw new Error(`в шаблоне shooting нет слота ${slot}`);
  }
  if (!props.includes('{PROPS}')) throw new Error('в шаблоне props нет слота {PROPS}');
  return { shooting, props };
}

const language = (k2Tail.language ?? '').replaceAll('Russian', '{LANG}');

const verbatimPack = {
  $source: 'Нарезано scripts/build-pack.ts из удачных промптов гайда (К1·3, К2, К3·2). Руками не править: sha256 в verbatim.lock.json.',
  format: k2Style.format,
  handheld: k2Style.handheld,
  shotOn: 'shot on {ANCHOR}',
  exposureLead: k2Tail.lead,
  defects: DEFECTS,
  behavior: BEHAVIOR,
  languageTail: language,
  operatorRule: { long: operatorLong, short: operatorShort },
  location: {
    lead: 'Location: exactly as in {REF1} and {REF2} — {PLACE}.',
    rule: { long: slotRefs(k1Loc.rule ?? ''), short: k2Loc.rule },
    useOnly: 'Use only {LIST}.',
  },
  roleSplit: roleSplit(),
  finaleTail: verbatim('A second of silence, just the wind and the water. Someone laughs quietly off-screen. The camera slowly lowers, as if the arms holding it are finally tired.'),
  foregroundNoReact: verbatim('No one in the foreground reacts.'),
};

const kits = {
  'arri-alexa35-cooke-s4i': {
    titleRu: 'ARRI Alexa 35 + Cooke S4/i — плёнка, тёплый цвет, круглое боке',
    anchor: k1Style.anchor,
    look: k1Tail.look,
    lensNote: null,
    layout: 'compact',
    defaultDefects: ['ae-jumps', 'focus-hunting', 'af-breathes', 'zoom-jerks', 'horizon-slight', 'hand-repositioning', 'dips-listening', 'breathing'],
    signatureTerms: ['ARRI', 'Alexa 35', 'Cooke', 'Kodak', 'teal-and-orange'],
  },
  'sony-venice2-zeiss-supreme': {
    titleRu: 'Sony VENICE 2 + ZEISS Supreme Prime — чистая холодная цифра, сдержанные блики',
    anchor: k2Style.anchor,
    look: k2Look.look,
    lensNote: k2Look.lensNote,
    layout: 'compact',
    defaultDefects: ['ae-jumps', 'focus-hunting', 'af-breathes', 'horizon-slight', 'hand-repositioning', 'breathing'],
    signatureTerms: ['Sony', 'VENICE', 'ZEISS', 'Supreme Prime', 'lens coating'],
  },
  'red-vraptor-laowa-proteus': {
    titleRu: 'RED V-RAPTOR 8K VV + Laowa Proteus 2x — анаморфот: овальное боке, горизонтальный блик',
    anchor: 'RED V-RAPTOR 8K VV with Laowa Proteus 2x Anamorphic lenses',
    cameraName: k3Camera.name,
    cameraSpecs: k3Camera.specs,
    lensName: k3Lens.name,
    lensSpecs: k3Lens.specs,
    flareParagraph: k3[5],
    effectsList: 'the anamorphic flares, the horizontal streaks of light, the oval bokeh, the edge distortion',
    layout: 'split',
    defaultDefects: ['focus-hunting', 'horizon-strong', 'hand-repositioning', 'breathing'],
    signatureTerms: ['RED', 'V-RAPTOR', 'Laowa', 'Proteus', 'anamorphic', 'global shutter'],
  },
};

// Самопроверка нарезки: хвосты К1 и К3 собираются из каталога побайтно.
const join = (ids: string[], catalog: Record<string, string>): string => ids.map((id) => catalog[id]).join(', ');
const checkTail = (label: string, expected: string | undefined, ids: string[]): void => {
  if (join(ids, DEFECTS) !== expected) throw new Error(`дефекты ${label} не собираются из каталога:\n  ждали: ${expected}\n  вышло: ${join(ids, DEFECTS)}`);
};
checkTail('К1', k1Tail.defects, kits['arri-alexa35-cooke-s4i'].defaultDefects);
checkTail('К2', k2Tail.defects, kits['sony-venice2-zeiss-supreme'].defaultDefects);
checkTail('К3', k3Tail.defects, kits['red-vraptor-laowa-proteus'].defaultDefects);
if (k3Format.handheld !== k2Style.handheld || k3Format.format !== k2Style.format) throw new Error('формат К3 отличается от К2');

mkdirSync(path.join(PACK, 'kits'), { recursive: true });
writeFileSync(path.join(PACK, 'verbatim.json'), `${JSON.stringify(verbatimPack, null, 1)}\n`);
for (const [id, kit] of Object.entries(kits)) writeFileSync(path.join(PACK, 'kits', `${id}.json`), `${JSON.stringify({ id, ...kit }, null, 1)}\n`);

const lock: Record<string, string> = {};
const hashAll = (prefix: string, value: unknown): void => {
  if (typeof value === 'string') lock[prefix] = createHash('sha256').update(value).digest('hex').slice(0, 16);
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) hashAll(`${prefix}.${k}`, v);
};
hashAll('verbatim', verbatimPack);
hashAll('kits', kits);
writeFileSync(path.join(PACK, 'verbatim.lock.json'), `${JSON.stringify(lock, null, 1)}\n`);

console.log(`verbatim.json, kits: ${Object.keys(kits).length}, lock: ${Object.keys(lock).length} записей`);
console.log(`behavior К1: ${k1Tail.behavior}\nbehavior К2: ${k2Tail.behavior}\nПлейс К2: ${k2Loc.place}\nuseOnly К1: ${k1Loc.useOnly}\nuseOnly К2: ${k2Loc.useOnly}`);
