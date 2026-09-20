import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileShot, joinParagraphs, type Kit, type ShotCompileInput, type VerbatimPack } from '../../src/core/compile/compile.ts';
import { resolve, type DialectPack } from '../../src/core/compile/dialect.ts';
import { parsePrompt } from '../../src/core/import/parsePrompt.ts';
import { lintText, type Lexicon, type LintParams } from '../../src/core/lint/index.ts';

/**
 * Побайтный golden: из структурных входов компилятор обязан выдать удачные промпты гайда байт в байт.
 * Сценарные абзацы подаются готовыми (в плейсхолдерной форме) — проверяется всё детерминированное:
 * дословные блоки, комплекты, стек дефектов, разделение ролей, локация, диалект, склейка.
 */
const ROOT = path.join(import.meta.dirname, '../..');
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as T;

const pack = read<VerbatimPack>('packs/cinema-doc/verbatim.json');
const dialects = read<DialectPack>('packs/cinema-doc/dialects.json');
const GUIDE = { refSyntax: 'higgsfield-chip', dialogueWrap: 'guillemets' } as const;
const kit = (id: string): Kit => read<Kit>(`packs/cinema-doc/kits/${id}.json`);

const PLACE = 'the embankment of the Moskva River near the parking area, with a distant view of Moscow State University';
const USE_ONLY = 'the space, architecture, ground, parapet, water, sky, and weather';
const normalize = (raw: string): string => raw.split(/\n+/).map((p) => p.trim()).filter(Boolean).join('\n\n');

interface Case {
  id: string;
  deterministic: number;
  input: (segments: { id: string; en: string }[], weatherEn: string) => ShotCompileInput;
}

const CASES: Case[] = [
  {
    id: 'k1a3',
    deterministic: 2,
    input: (segments, weatherEn) => ({
      kit: kit('arri-alexa35-cooke-s4i'),
      behavior: ['real-human', 'no-staged', 'no-theatrical', 'micro-expressions', 'subtle-movement'],
      operatorRule: 'off',
      locationRule: 'long',
      locationRefs: ['r1', 'r2'],
      world: { placeEn: PLACE, useOnlyEn: USE_ONLY, weatherEn },
      languageName: 'Russian',
      segments,
    }),
  },
  {
    id: 'k2',
    deterministic: 3,
    input: (segments, weatherEn) => ({
      kit: kit('sony-venice2-zeiss-supreme'),
      behavior: ['real-human', 'no-staged', 'micro-expressions', 'subtle-movement'],
      operatorRule: 'long',
      locationRule: 'short',
      locationRefs: ['r1', 'r2'],
      world: { placeEn: PLACE, useOnlyEn: USE_ONLY, weatherEn },
      languageName: 'Russian',
      segments,
    }),
  },
  {
    id: 'k3a2',
    deterministic: 9,
    input: (segments, weatherEn) => ({
      kit: kit('red-vraptor-laowa-proteus'),
      behavior: ['real-human', 'no-staged', 'micro-expressions', 'subtle-movement'],
      operatorRule: 'short',
      locationRule: 'short',
      locationRefs: ['r4', 'r5'],
      world: { placeEn: PLACE, useOnlyEn: USE_ONLY, weatherEn },
      languageName: 'Russian',
      roleSplit: {
        cameraRef: 'r1',
        lensRef: 'r2',
        cameraHolder: 'Alexander',
        lensHolder: 'John',
        propsEn: 'Alexander holds a RED V-RAPTOR in his hands, and John holds an open case with Laowa Proteus lenses',
      },
      segments,
    }),
  },
];

describe('компилятор воспроизводит удачные промпты гайда байт в байт', () => {
  for (const testCase of CASES) {
    it(testCase.id, () => {
      const fixture = read<{ raw: string; panelSize: number }>(`tests/fixtures/guide/${testCase.id}.json`);
      const parsed = parsePrompt(fixture.raw, { panelSize: fixture.panelSize, dialect: GUIDE, language: 'ru', pack: dialects });

      // Погода — хвост абзаца локации после «Use only …»; сценарий — всё, что после детерминированных абзацев.
      const location = parsed.paragraphs[testCase.deterministic - 1] ?? '';
      const weatherEn = location.slice(location.indexOf(`Use only ${USE_ONLY}.`) + `Use only ${USE_ONLY}. `.length);
      const segments = parsed.paragraphs.slice(testCase.deterministic).map((en, i) => ({ id: `seg${i + 1}`, en }));

      const compiled = compileShot(testCase.input(segments, weatherEn), pack);
      expect(compiled.issues).toEqual([]);
      expect(compiled.paragraphs.filter((p) => p.kind !== 'segment')).toHaveLength(testCase.deterministic);

      const out = resolve(joinParagraphs(compiled.paragraphs), { panel: parsed.panel, lines: parsed.lines, entities: {}, states: {}, dialect: GUIDE, language: 'ru', pack: dialects });
      expect(out.issues).toEqual([]);
      expect(out.text).toBe(normalize(fixture.raw));
    });
  }
});

describe('комплект — одна переменная', () => {
  it('смена комплекта меняет стиль-блок целиком и не оставляет следов прежнего', () => {
    const fixture = read<{ raw: string; panelSize: number }>('tests/fixtures/guide/k2.json');
    const parsed = parsePrompt(fixture.raw, { panelSize: fixture.panelSize, dialect: GUIDE, language: 'ru', pack: dialects });
    const base = CASES[1]?.input([], 'The rain has just stopped.');
    if (base === undefined) throw new Error('нет кейса');
    const arri = compileShot({ ...base, kit: kit('arri-alexa35-cooke-s4i') }, pack);
    const style = arri.paragraphs[0]?.text ?? '';
    expect(style).toContain('shot on ARRI Alexa 35 with Cooke S4/i Prime lenses at T2.0');
    expect(style).toContain('Kodak');
    expect(style).not.toMatch(/Sony|ZEISS|lens coating/);
    expect(parsed.panel).toHaveLength(7);
  });

  it('split-комплект без разделения ролей не собирается молча', () => {
    const base = CASES[2]?.input([], 'x');
    if (base === undefined) throw new Error('нет кейса');
    const { roleSplit: _omit, ...withoutRoles } = base;
    expect(compileShot(withoutRoles, pack).issues.map((i) => i.code)).toContain('ROLE_SPLIT_REQUIRED');
  });

  it('собранное с нуля проходит линтер без ошибок', () => {
    const lexicon = read<Lexicon>('packs/cinema-doc/lexicon.json');
    const params = read<LintParams>('packs/cinema-doc/lint.json');
    const base = CASES[1]?.input([{ id: 's1', en: `A cloud passes, the light shifts for two seconds, then returns. ${pack.finaleTail}` }], 'Wet asphalt, puddles reflecting the sky. A light wind.');
    if (base === undefined) throw new Error('нет кейса');
    const text = resolve(joinParagraphs(compileShot(base, pack).paragraphs), { panel: ['r1', 'r2'], lines: {}, entities: {}, states: {}, dialect: GUIDE, language: 'ru', pack: dialects }).text;
    expect(lintText(text, { lexicon, params, panelSize: 2 }).filter((f) => f.severity === 'error')).toEqual([]);
  });
});

describe('verbatim.lock: формулировки гайда нельзя «улучшить» незаметно', () => {
  it('sha256 каждой формулировки совпадает с замком', () => {
    const lock = read<Record<string, string>>('packs/cinema-doc/verbatim.lock.json');
    const actual: Record<string, string> = {};
    const walk = (prefix: string, value: unknown): void => {
      if (typeof value === 'string') actual[prefix] = createHash('sha256').update(value).digest('hex').slice(0, 16);
      else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(`${prefix}.${k}`, v);
    };
    walk('verbatim', pack);
    const kits = Object.fromEntries(['arri-alexa35-cooke-s4i', 'sony-venice2-zeiss-supreme', 'red-vraptor-laowa-proteus'].map((id) => {
      const { id: _id, ...rest } = kit(id) as Kit & { id: string };
      return [id, rest];
    }));
    walk('kits', kits);
    expect(actual).toEqual(lock);
  });
});
