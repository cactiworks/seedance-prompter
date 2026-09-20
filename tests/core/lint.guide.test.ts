import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintText, type Finding, type Lexicon, type LintParams } from '../../src/core/lint/index.ts';

/**
 * Шесть промптов гайда — размеченные данные: три попытки не вошли в монтаж (причины названы в гайде),
 * три вошли. Линтер обязан ловить названные причины и не ругаться ошибками на удачных промптах.
 */
const ROOT = path.join(import.meta.dirname, '../..');
const lexicon = JSON.parse(readFileSync(path.join(ROOT, 'packs/cinema-doc/lexicon.json'), 'utf8')) as Lexicon;
const params = JSON.parse(readFileSync(path.join(ROOT, 'packs/cinema-doc/lint.json'), 'utf8')) as LintParams;

interface Fixture {
  id: string;
  raw: string;
  panelSize: number;
  blocks: { index: number; paragraphs: { text: string }[]; note: { kind: string } | null }[];
}

function load(id: string): Fixture {
  return JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/guide', `${id}.json`), 'utf8')) as Fixture;
}

function lint(id: string): Finding[] {
  const fixture = load(id);
  return lintText(fixture.raw, { lexicon, params, panelSize: fixture.panelSize });
}

const ids = (findings: Finding[]) => new Set(findings.map((f) => f.ruleId));
const errors = (findings: Finding[]) => findings.filter((f) => f.severity === 'error');

/** Абзац → метка блока в гайде («Причина проблемы» / «Ключевое решение» / «Разбор абзаца»). */
function blockKindByParagraph(fixture: Fixture): string[] {
  return fixture.blocks.flatMap((block) => block.paragraphs.map(() => block.note?.kind ?? ''));
}

describe('попытки, не вошедшие в монтаж: линтер называет причины из гайда', () => {
  it('К1·1 — лишний персонаж с референсом, перегруз мелкими жестами, непоказуемое, портрет оператора', () => {
    const found = ids(lint('k1a1'));
    for (const rule of ['REF_ON_EXTRA', 'MICRO_ACTION_OVERLOAD', 'UNSHOWABLE_SENSE', 'UNSHOWABLE_SILENT_SPEECH', 'OP_PORTRAIT_IN_STYLE', 'OP_BODY_NOUN', 'OP_RULE_MISSING']) {
      expect(found, rule).toContain(rule);
    }
  });

  it('К1·2 — оператор как действующее лицо: точка съёмки через человека, глаголы и тело оператора', () => {
    const findings = lint('k1a2');
    const found = ids(findings);
    for (const rule of ['OP_VANTAGE_VIA_PERSON', 'OP_ACTOR_VERB', 'OP_BODY_NOUN', 'OP_PORTRAIT_IN_STYLE', 'OP_RULE_MISSING', 'SHOT_SIZE_KEY_MOMENTS', 'HYG_PUNCT']) {
      expect(found, rule).toContain(rule);
    }
    expect(findings.filter((f) => f.ruleId === 'OP_ACTOR_VERB').length).toBeGreaterThanOrEqual(8);
    expect(errors(findings).map((f) => f.ruleId)).toEqual(['OP_VANTAGE_VIA_PERSON']);
  });

  it('К3·1 — пропавшие ссылки, чужой синтаксис, кириллица в английском тексте, блик на реквизите, финал-команда', () => {
    const findings = lint('k3a1');
    const found = ids(findings);
    for (const rule of ['REF_DANGLING_PREP', 'REF_SYNTAX_FOREIGN', 'HYG_CYRILLIC_OUTSIDE_QUOTES', 'HYG_PUNCT', 'ROLE_FX_ON_PROP', 'FINALE_COMMAND', 'FINALE_PRESENT']) {
      expect(found, rule).toContain(rule);
    }
    const cyrillic = findings.filter((f) => f.ruleId === 'HYG_CYRILLIC_OUTSIDE_QUOTES').map((f) => f.evidence);
    expect(cyrillic).toEqual(['внимание', 'Ка']);
    expect(findings.find((f) => f.ruleId === 'REF_SYNTAX_FOREIGN')?.evidence).toBe('@image7');
  });

  it('ошибки К3·1 лежат в блоках, которые сам гайд пометил «Причина проблемы»', () => {
    const fixture = load('k3a1');
    const kinds = blockKindByParagraph(fixture);
    const structural = errors(lint('k3a1')).filter((f) => f.ruleId !== 'HYG_CYRILLIC_OUTSIDE_QUOTES');
    expect(structural.length).toBeGreaterThan(0);
    for (const finding of structural) expect(kinds[finding.paragraph ?? -1], finding.evidence).toBe('Причина проблемы');
  });
});

describe('промпты, вошедшие в монтаж: без ошибок, с ожидаемыми честными срабатываниями', () => {
  it('К1·3 — ошибок нет; рука оператора на двери (она и в видео была), механика борта, слияние однотипных объектов', () => {
    const findings = lint('k1a3');
    expect(errors(findings)).toEqual([]);
    const found = ids(findings);
    for (const rule of ['OP_ACTOR_VERB', 'OP_RULE_MISSING', 'MECH_RISK', 'SAME_OBJECTS_MERGE']) expect(found, rule).toContain(rule);
    expect(found).not.toContain('OP_BODY_NOUN');
    expect(found).not.toContain('OP_PORTRAIT_IN_STYLE');
    expect(found).not.toContain('SHOT_SIZE_KEY_MOMENTS');
  });

  it('К2 — ошибок нет; осознанное отражение оператора и перегруз речи (79 слов, часть реплики в видео выпала)', () => {
    const findings = lint('k2');
    expect(errors(findings)).toEqual([]);
    expect(ids(findings)).toContain('OP_BAN_CONTRADICTED');
    expect(findings.find((f) => f.ruleId === 'SPEECH_BUDGET')?.severity).toBe('warning');
    expect(findings.filter((f) => f.severity === 'warning').map((f) => f.ruleId)).toEqual(['SPEECH_BUDGET']);
  });

  it('К3·2 — ошибок нет; гайд сам признаёт слабый финал «The scene ends.»', () => {
    const findings = lint('k3a2');
    expect(errors(findings)).toEqual([]);
    expect(ids(findings)).toContain('FINALE_COMMAND');
    expect(ids(findings)).not.toContain('ROLE_FX_ON_PROP');
    expect(ids(findings)).not.toContain('REF_DANGLING_PREP');
  });

  it('починка попытки видна в числах: у каждой удачной версии находок меньше, чем у провальной', () => {
    const weight = (id: string) => lint(id).filter((f) => f.severity !== 'info').length;
    expect(weight('k1a3')).toBeLessThan(weight('k1a2'));
    expect(weight('k1a2')).toBeLessThan(weight('k1a1') + 1);
    expect(weight('k3a2')).toBeLessThan(weight('k3a1'));
  });
});

describe('подавление находки («осознанное исключение»)', () => {
  it('отпечаток переживает смену номера референса и убирает находку', () => {
    const fixture = load('k2');
    const target = lint('k2').find((f) => f.ruleId === 'OP_BAN_CONTRADICTED');
    expect(target).toBeDefined();
    const after = lintText(fixture.raw, { lexicon, params, panelSize: fixture.panelSize, suppressed: [target?.fingerprint ?? ''] });
    expect(ids(after)).not.toContain('OP_BAN_CONTRADICTED');
  });
});

describe('снимок: дрейф правил виден в diff', () => {
  for (const id of ['k1a1', 'k1a2', 'k1a3', 'k2', 'k3a1', 'k3a2']) {
    it(id, () => {
      expect(lint(id).map((f) => `${f.severity} ${f.ruleId} p${f.paragraph === null ? '-' : f.paragraph + 1} ${f.evidence.slice(0, 48)}`)).toMatchSnapshot();
    });
  }
});
