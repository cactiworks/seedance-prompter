/**
 * Линт готового промпта из командной строки.
 *   node scripts/lint-text.ts tests/fixtures/guide/k3a1.json      # фикстура гайда
 *   node scripts/lint-text.ts путь/к/промпту.txt --panel=7
 *   node scripts/lint-text.ts --all                                # сводка по всем шести промптам гайда
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintText, type Lexicon, type LintParams } from '../src/core/lint/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lexicon = JSON.parse(readFileSync(path.join(ROOT, 'packs/cinema-doc/lexicon.json'), 'utf8')) as Lexicon;
const params = JSON.parse(readFileSync(path.join(ROOT, 'packs/cinema-doc/lint.json'), 'utf8')) as LintParams;

function load(file: string): { id: string; raw: string; panelSize: number | null; verdict?: string } {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const fixture = JSON.parse(text) as { id: string; raw: string; panelSize: number | null; verdict: string };
    return fixture;
  }
  const panel = process.argv.find((a) => a.startsWith('--panel='));
  return { id: path.basename(file), raw: text, panelSize: panel === undefined ? null : Number(panel.slice(8)) };
}

const files = process.argv.includes('--all')
  ? readdirSync(path.join(ROOT, 'tests/fixtures/guide')).filter((f) => f.endsWith('.json')).map((f) => path.join(ROOT, 'tests/fixtures/guide', f))
  : process.argv.slice(2).filter((a) => !a.startsWith('--'));

for (const file of files) {
  const { id, raw, panelSize, verdict } = load(file);
  const findings = lintText(raw, { lexicon, params, panelSize });
  const tally = { error: 0, warning: 0, info: 0 };
  for (const f of findings) tally[f.severity] += 1;
  console.log(`\n=== ${id}${verdict === undefined ? '' : ` (${verdict})`} — error ${tally.error} · warning ${tally.warning} · info ${tally.info}`);
  for (const f of findings) {
    const where = f.paragraph === null ? 'весь промпт' : `абзац ${f.paragraph + 1}`;
    console.log(`${f.severity.toUpperCase().padEnd(7)} ${f.ruleId.padEnd(28)} ${where.padEnd(12)} ${f.evidence.slice(0, 70).replace(/\s+/g, ' ')}`);
  }
}
