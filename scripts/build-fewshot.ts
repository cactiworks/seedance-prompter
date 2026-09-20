/**
 * Пример для писателя: Кадр 2 гайда (вошёл в монтаж без правок) в плейсхолдерной форме + русские биты.
 * Английский текст не перепечатывается: он берётся из фикстуры, первые упоминания сущностей
 * сворачиваются в {{intro:key}}, и скрипт проверяет, что обратная развёртка даёт оригинал байт в байт.
 *
 * Запуск: node scripts/build-fewshot.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve, type DialectPack, type ResolveEntity } from '../src/core/compile/dialect.ts';
import { parsePrompt } from '../src/core/import/parsePrompt.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as T;
const dialects = read<DialectPack>('packs/cinema-doc/dialects.json');
const fixture = read<{ raw: string; panelSize: number }>('tests/fixtures/guide/k2.json');
const GUIDE = { refSyntax: 'higgsfield-chip', dialogueWrap: 'guillemets' } as const;

const parsed = parsePrompt(fixture.raw, { panelSize: fixture.panelSize, dialect: GUIDE, language: 'ru', pack: dialects });
const DETERMINISTIC = 3;

const entities: Record<string, ResolveEntity> = {
  alexander: { name: 'Alexander', kind: 'character', refKey: 'r5' },
  john: { name: 'John', kind: 'character', refKey: 'r6' },
  pickup: { name: 'the main pickup', kind: 'object', refKey: 'r7' },
  sony: { name: 'the Sony VENICE 2', kind: 'object', refKey: 'r3' },
  zeiss: { name: 'the ZEISS Supreme Prime lenses', kind: 'object', refKey: 'r4' },
};

// Русские биты написаны один раз руками: так владелец описывал бы этот кадр в форме.
const BEATS_RU = [
  'Alexander стоит у пикапа с Sony в руках, John рядом держит открытый кейс с линзами ZEISS. На борту видна вмятина от прошлого удара, мокрые отпечатки ладоней. Alexander говорит в камеру L1, спокойно и уверенно. Ветер, блик от лужи на лице.',
  'Договорив, Alexander небрежно бросает камеру за кадр. За кадром её еле ловит рыжий ассистент в очках — камера на нём не задерживается. John ставит кейс на мокрый асфальт.',
  'Без предупреждения John встаёт в стойку Брюса Ли, Alexander — в стойку ММА. Спарринг на мокром асфальте: скользят, часть ударов мимо, клинч, расходятся. У Alexander красное пятно на скуле, у John разбита губа. Ветер шевелит мокрые волосы и одежду.',
  'Alexander пытается объяснять прямо в драке, слова рвутся между ударами: L2, блокирует удар; L3, уходит от удара ногой, оступается; L4.',
  'Камера живая: бегает вокруг, приседает, снимает снизу, заваливает горизонт. Когда удар пролетает слишком близко — отдёргивается, теряет фокус. Спотыкается о бордюр. На мокром борту пикапа на долю секунды мелькает отражение оператора.',
  'John влетает спиной в борт пикапа, появляется небольшая вмятина, камера вздрагивает; John с ухмылкой извиняется в объектив. Фон: прохожий снимает на телефон, охранник тянется к рации и передумывает, машина сигналит и уезжает, голуби, собака на поводке, дворник, студент в наушниках.',
  'Свет как событие: солнце из-за спин бойцов, мягкий контролируемый блик без засветки, облако на две секунды, тень пикапа двигается, блик от асфальта слепит объектив.',
  'Драка замедляется. Alexander подходит к камере, тяжело дыша: L5. Он не успевает договорить — John с разворота бьёт ногой в голову, Alexander вылетает из кадра. Кадр держится на пустом месте. John впервые смотрит в камеру, уставший и ошарашенный. Финал: лужа, мокрый асфальт, John на заднем плане, тишина, смех за кадром, камера опускается.',
];

const segments = parsed.paragraphs.slice(DETERMINISTIC).map((text, index) => {
  let en = text;
  for (const [key, entity] of Object.entries(entities)) {
    const ref = `{{ref:${entity.refKey ?? ''}}}`;
    const expanded = entity.kind === 'character' ? `${entity.name}, matching ${ref}` : `${entity.name} from ${ref}`;
    en = en.replace(expanded, `{{intro:${key}}}`);
  }
  return { id: `seg-${index + 1}`, beatsRu: BEATS_RU[index] ?? '', en };
});

if (segments.length !== BEATS_RU.length) throw new Error(`абзацев ${segments.length}, битов ${BEATS_RU.length}`);
const leftoverRefs = segments.flatMap((s) => s.en.match(/\{\{ref:[^}]+\}\}/g) ?? []);
if (leftoverRefs.length > 0) throw new Error(`не свёрнуты в intro: ${leftoverRefs.join(', ')}`);

// Обратная развёртка обязана вернуть текст гайда байт в байт.
const back = resolve(segments.map((s) => s.en).join('\n\n'), { panel: parsed.panel, lines: parsed.lines, entities, states: {}, dialect: GUIDE, language: 'ru', pack: dialects }).text;
const original = fixture.raw.split(/\n+/).map((p) => p.trim()).filter(Boolean).slice(DETERMINISTIC).join('\n\n');
if (back !== original) throw new Error('плейсхолдерная форма не разворачивается в оригинал гайда');

const out = {
  $source: 'Кадр 2 гайда Cinema Ai Tech — единственная генерация, вошла в монтаж без правок. Сгенерировано scripts/build-fewshot.ts.',
  kitId: 'sony-venice2-zeiss-supreme',
  entities: Object.entries(entities).map(([key, e]) => ({ key, name: e.name, kind: e.kind })),
  lines: Object.entries(parsed.lines).map(([id, line]) => ({ id, ru: line.ru })),
  segments,
};
mkdirSync(path.join(ROOT, 'packs/cinema-doc/prompts/fewshot'), { recursive: true });
writeFileSync(path.join(ROOT, 'packs/cinema-doc/prompts/fewshot/k2.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`fewshot k2: ${segments.length} отрезков, intro: ${segments.reduce((n, s) => n + (s.en.match(/\{\{intro:/g) ?? []).length, 0)}, реплик: ${out.lines.length} — развёртка совпала с гайдом байт в байт`);
