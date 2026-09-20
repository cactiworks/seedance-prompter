/**
 * design/lab-ui/tokens.source.json → src/web/ui/tokens/tokens.css
 *
 * Архитектура Lab UI v2.1.1: по модам (light / light-contrast / dark-contrast / dark) переключаются только
 * примитивы (Neutral 0–12 и акценты); семантика = «примитив × непрозрачность» и объявлена один раз.
 * Бренд-цвет меняется в одном месте — `--lab-brand`.
 *
 * Запуск: node scripts/design/build-tokens.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type Mode = 'light' | 'light-contrast' | 'dark-contrast' | 'dark';
type Ref = [string, number];

const source = JSON.parse(readFileSync(path.join(ROOT, 'design/lab-ui/tokens.source.json'), 'utf8')) as {
  primitive: {
    neutral: Record<string, Record<Mode, string>>;
    accent: Record<string, Record<Mode, string>>;
    static: Record<string, string>;
    alpha: number[];
    radius: Record<string, string>;
    space: Record<string, string>;
    blur: Record<string, string>;
    duration: Record<string, string>;
    ease: Record<string, string>;
  };
  type: { family: Record<string, string>; weight: Record<string, number>; scale: Record<string, { size: string; line: string; tracking: string }> };
  semantic: Record<string, Ref>;
  status: Record<string, string>;
  statusSteps: Record<string, number>;
  themeOnly: Record<'light' | 'dark', Record<string, Ref>>;
  shadow: { color: string; layers: Record<string, number>; xs: number[][]; s: number[][]; m: number[][]; l: number[][]; xl: number[][] };
};

const mix = ([token, alpha]: Ref): string => (alpha >= 100 ? `var(--lab-${token})` : `color-mix(in srgb, var(--lab-${token}) ${alpha}%, transparent)`);

const lines: string[] = [];
const block = (selector: string, decls: string[]): void => void lines.push(`${selector} {`, ...decls.map((d) => `  ${d}`), '}', '');

function primitives(mode: Mode): string[] {
  const decls: string[] = [];
  for (const [step, values] of Object.entries(source.primitive.neutral)) decls.push(`--lab-neutral-${step}: ${values[mode]};`);
  for (const [name, values] of Object.entries(source.primitive.accent)) decls.push(`--lab-${name}: ${values[mode]};`);
  decls.push(`color-scheme: ${mode.startsWith('dark') ? 'dark' : 'light'};`);
  return decls;
}

// --- не зависящее от моды ---
const base: string[] = [];
for (const [name, hex] of Object.entries(source.primitive.static)) base.push(`--lab-static-${name}: ${hex};`);
for (const group of ['radius', 'space', 'blur', 'duration', 'ease'] as const) {
  for (const [name, v] of Object.entries(source.primitive[group])) base.push(`--lab-${group}-${name}: ${v};`);
}
for (const [name, v] of Object.entries(source.type.family)) base.push(`--lab-font-${name}: ${v};`);
for (const [name, v] of Object.entries(source.type.weight)) base.push(`--lab-weight-${name}: ${v};`);
for (const [name, t] of Object.entries(source.type.scale)) {
  base.push(`--lab-type-${name}-size: ${t.size};`, `--lab-type-${name}-line: ${t.line};`, `--lab-type-${name}-tracking: ${t.tracking};`);
}
base.push('--lab-scale: 1;');
block(':root', base);

// --- примитивы по модам ---
block(':root, [data-theme="light"]', primitives('light'));
block('[data-theme="light"][data-contrast="more"]', primitives('light-contrast'));
block('[data-theme="dark"]', primitives('dark'));
block('[data-theme="dark"][data-contrast="more"]', primitives('dark-contrast'));

// --- семантика: объявляется на каждом тематическом корне, чтобы пересчитываться от его примитивов ---
const semantic: string[] = Object.entries(source.semantic).map(([token, ref]) => `--lab-${token}: ${mix(ref)};`);
for (const [role, color] of Object.entries(source.status)) {
  semantic.push(`--lab-${role}: var(--lab-${color});`);
  for (const [step, alpha] of Object.entries(source.statusSteps)) semantic.push(`--lab-${role}-${step}: ${mix([color, alpha])};`);
}
const { color, layers } = source.shadow;
const alphas = Object.values(layers);
for (const size of ['xs', 's', 'm', 'l', 'xl'] as const) {
  const stack = source.shadow[size].map(([x, y, blur], i) => `${x}px ${y}px ${blur}px ${mix([color, alphas[i] ?? 1])}`);
  semantic.push(`--lab-shadow-${size}: ${stack.join(', ')};`);
}
// Интерактивная кромка из стиля Interactive/Default и её нажатое состояние.
semantic.push(`--lab-shadow-edge: inset 0 -1px 1px ${mix([color, 12])};`, `--lab-shadow-edge-pressed: inset 0 1px 1px ${mix([color, 12])};`);
block(':root, [data-theme]', semantic);

for (const theme of ['light', 'dark'] as const) {
  const decls = Object.entries(source.themeOnly[theme]).map(([token, ref]) => `--lab-${token}: ${mix(ref)};`);
  block(theme === 'light' ? ':root, [data-theme="light"]' : '[data-theme="dark"]', decls);
}

// Масштаб 75–133 %: все размеры в rem, меняется только корневой кегль.
block('html', ['font-size: calc(16px * var(--lab-scale));']);
for (const pct of [75, 90, 110, 125, 133]) block(`[data-scale="${pct}"]`, [`--lab-scale: ${pct / 100};`]);

const out = path.join(ROOT, 'src/web/ui/tokens/tokens.css');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `/* generated by scripts/design/build-tokens.ts — do not edit. Source: design/lab-ui/tokens.source.json (Figma Lab UI v2.1) */\n\n${lines.join('\n')}`);
console.log(`tokens.css: ${lines.filter((l) => l.trim().startsWith('--lab-')).length} деклараций, мод: 4`);
