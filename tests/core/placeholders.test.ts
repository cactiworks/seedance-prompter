import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolve, type DialectPack, type ResolveContext } from '../../src/core/compile/dialect.ts';
import { findMalformed, findPlaceholders } from '../../src/core/compile/placeholders.ts';
import { parsePrompt } from '../../src/core/import/parsePrompt.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const pack = JSON.parse(readFileSync(path.join(ROOT, 'packs/cinema-doc/dialects.json'), 'utf8')) as DialectPack;
const GUIDE = { refSyntax: 'higgsfield-chip', dialogueWrap: 'guillemets' } as const;

function fixture(id: string): { raw: string; panelSize: number; lines: string[] } {
  return JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/guide', `${id}.json`), 'utf8')) as { raw: string; panelSize: number; lines: string[] };
}

function context(overrides: Partial<ResolveContext>): ResolveContext {
  return { panel: [], lines: {}, entities: {}, states: {}, dialect: GUIDE, language: 'ru', pack, ...overrides };
}

const normalize = (raw: string) => raw.replace(/\r\n/g, '\n').split(/\n+/).map((p) => p.trim()).filter(Boolean).join('\n\n');

describe('обратимость на промптах гайда: текст → плейсхолдеры → текст, байт в байт', () => {
  for (const id of ['k1a1', 'k1a2', 'k1a3', 'k2', 'k3a1', 'k3a2']) {
    it(id, () => {
      const { raw, panelSize, lines } = fixture(id);
      const parsed = parsePrompt(raw, { panelSize, dialect: GUIDE, language: 'ru', pack });
      const source = parsed.paragraphs.join('\n\n');

      // В плейсхолдерной форме не остаётся ни одного номера и ни одной реплики.
      expect(source).not.toMatch(/<<<image_\d+>>>/);
      expect(parsed.leftovers.filter((l) => l.kind === 'bare-line')).toEqual([]);
      expect(Object.values(parsed.lines).map((l) => l.ru)).toEqual(lines);

      const back = resolve(source, context({ panel: parsed.panel, lines: parsed.lines }));
      expect(back.issues).toEqual([]);
      expect(back.text).toBe(normalize(raw));
    });
  }

  it('К3·1: чужой синтаксис остаётся сырым и попадает в leftovers', () => {
    const { raw, panelSize } = fixture('k3a1');
    const parsed = parsePrompt(raw, { panelSize, dialect: GUIDE, language: 'ru', pack });
    expect(parsed.leftovers).toEqual([{ kind: 'foreign-ref', text: '@image7', paragraph: 3 }]);
  });
});

describe('номера — производная от порядка панели', () => {
  const { raw, panelSize } = fixture('k2');
  const parsed = parsePrompt(raw, { panelSize, dialect: GUIDE, language: 'ru', pack });
  const source = parsed.paragraphs.join('\n\n');

  it('перестановка картинок в панели перенумеровывает весь текст', () => {
    const reversed = [...parsed.panel].reverse();
    const out = resolve(source, context({ panel: reversed, lines: parsed.lines })).text;
    // r5 (Alexander) был пятым из семи — стал третьим.
    expect(normalize(raw)).toContain('Alexander, matching <<<image_5>>>');
    expect(out).toContain('Alexander, matching <<<image_3>>>');
    expect(out).not.toContain('Alexander, matching <<<image_5>>>');
    const count = (text: string) => (text.match(/<<<image_\d+>>>/g) ?? []).length;
    expect(count(out)).toBe(count(raw));
  });

  it('официальный диалект: @Image N и реплики в фигурных скобках', () => {
    const out = resolve(source, context({ panel: parsed.panel, lines: parsed.lines, dialect: { refSyntax: 'at-image', dialogueWrap: 'braces' } })).text;
    expect(out).toContain('Alexander, matching @Image 5');
    expect(out).not.toMatch(/<<<image_|«/);
    expect(out).toContain('says naturally in Russian: {Сейчас мы снимаем на Sony VENICE 2 с объективами ZEISS Supreme Prime.}');
  });

  it('референс убран из панели → плейсхолдер остаётся на месте и называется в issues, текст не портится молча', () => {
    const out = resolve(source, context({ panel: parsed.panel.filter((key) => key !== 'r7'), lines: parsed.lines }));
    expect(out.issues.every((issue) => issue.code === 'REF_NOT_IN_PANEL')).toBe(true);
    expect(out.issues.length).toBeGreaterThan(0);
    expect(out.text).toContain('{{ref:r7}}');
    expect(out.text).not.toMatch(/from\s+[.,]/);
  });
});

describe('сущности, состояния и реплики', () => {
  const ctx = context({
    panel: ['loc', 'alex-sheet', 'pickup'],
    lines: { L1: { ru: 'Снимаем на RED V-RAPTOR. Анаморфот Laowa Proteus.' } },
    entities: {
      alexander: { name: 'Alexander', kind: 'character', refKey: 'alex-sheet' },
      pickup: { name: 'the main pickup', kind: 'object', refKey: 'pickup' },
      guard: { name: 'a guard', kind: 'character' },
      john: { name: 'John', kind: 'character', refKey: 'alex-sheet', studioBackdrop: true },
    },
    states: { S1: "Alexander's face shows a slight redness and a small scrape on the right side only — a mark from a recent hit, no blood, no cut, just a light bruise forming under the skin, like a fresh impact." },
  });

  it('intro разворачивается формулами гайда', () => {
    const out = resolve('{{intro:alexander}} stands near {{intro:pickup}}. {{intro:guard}} yawns.', ctx);
    expect(out.issues).toEqual([]);
    expect(out.text).toBe('Alexander, matching <<<image_2>>> stands near the main pickup from <<<image_3>>>. a guard yawns.');
  });

  it('у character sheet со студийным задником клауза-исключение ставится автоматически', () => {
    expect(resolve('{{intro:john}}', ctx).text).toContain('do not take the background');
  });

  it('реплика и состояние проходят буква в букву', () => {
    const out = resolve('{{state:S1}} He turns to the camera and {{line:L1}}', ctx);
    expect(out.text).toContain('right side only');
    expect(out.text).toContain('says in clear, native Russian, perfect pronunciation, natural intonation: «Снимаем на RED V-RAPTOR. Анаморфот Laowa Proteus.»');
    expect(out.map.map((m) => m.type)).toEqual(['state', 'line']);
  });

  it('грамматика закрытая: всё остальное — MALFORMED', () => {
    expect(findPlaceholders('{{ref:a}} {{line:L2}}').map((p) => p.type)).toEqual(['ref', 'line']);
    expect(findMalformed('{{ref: alexander}} {{image:1}} {{ref:ok}}').map((m) => m.raw)).toEqual(['{{ref: alexander}}', '{{image:1}}']);
    const out = resolve('shot on RED from {{image:1}}', ctx);
    expect(out.issues.map((i) => i.code)).toEqual(['MALFORMED']);
  });
});
