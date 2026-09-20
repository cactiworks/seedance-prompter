/**
 * Извлекает из снимка гайда размеченные данные — руками ничего не перепечатывается:
 *   tests/fixtures/guide/<id>.json   шесть промптов: сырой текст, абзацы, блоки, спаны 7 категорий
 *   packs/cinema-doc/highlight.json  словари подсветки, посеянные из hl-спанов гайда
 *   packs/cinema-doc/looks.seed.json компактные look-строки из встроенного конструктора гайда
 *
 * Запуск: node scripts/extract-guide.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'docs/source/guide.html'), 'utf8');

const META: Record<string, { shot: number; attempt: number; verdict: 'in-edit' | 'rejected' | 'partial'; kit: string; panelSize: number | null; noteRu: string }> = {
  k1a1: { shot: 1, attempt: 1, verdict: 'rejected', kit: 'arri-alexa35-cooke-s4i', panelSize: 11, noteRu: 'Нет референса пикапа, лишний персонаж, не та одежда' },
  k1a2: { shot: 1, attempt: 2, verdict: 'rejected', kit: 'arri-alexa35-cooke-s4i', panelSize: 11, noteRu: 'В кадре постоянно камера и руки оператора' },
  k1a3: { shot: 1, attempt: 3, verdict: 'in-edit', kit: 'arri-alexa35-cooke-s4i', panelSize: 11, noteRu: 'Камера едет из салона машины, оператор не в кадре' },
  k2: { shot: 2, attempt: 1, verdict: 'in-edit', kit: 'sony-venice2-zeiss-supreme', panelSize: 7, noteRu: 'Чистая цифра: оператор не виден, драка держит ритм' },
  k3a1: { shot: 3, attempt: 1, verdict: 'partial', kit: 'red-vraptor-laowa-proteus', panelSize: 7, noteRu: 'Лицо: разбитая щека не с той стороны; начало не вошло в монтаж' },
  k3a2: { shot: 3, attempt: 2, verdict: 'in-edit', kit: 'red-vraptor-laowa-proteus', panelSize: 7, noteRu: 'Роли разведены, травма точная, блик только на изображении' },
};

const CATEGORIES = ['ref', 'cam', 'imp', 'look', 'world', 'say', 'neg'] as const;
type Category = (typeof CATEGORIES)[number];

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(fragment: string): string {
  return decode(fragment.replace(/<[^>]+>/g, ''));
}

interface Span {
  category: Category;
  text: string;
  start: number;
  end: number;
}

interface Paragraph {
  text: string;
  spans: Span[];
}

/** Абзац с вложенными hl-спанами → чистый текст + диапазоны категорий. */
function parseParagraph(inner: string): Paragraph {
  const spans: Span[] = [];
  let text = '';
  const tokenRe = /<span class="hl hl-([a-z]+)">|<\/span>|<[^>]+>|[^<]+/g;
  const stack: { category: Category; start: number }[] = [];
  for (const match of inner.matchAll(tokenRe)) {
    const token = match[0];
    if (match[1] !== undefined) {
      stack.push({ category: match[1] as Category, start: text.length });
    } else if (token === '</span>') {
      const open = stack.pop();
      if (open !== undefined) spans.push({ category: open.category, text: text.slice(open.start), start: open.start, end: text.length });
    } else if (!token.startsWith('<')) {
      text += decode(token);
    }
  }
  return { text, spans };
}

const fixturesDir = path.join(ROOT, 'tests/fixtures/guide');
mkdirSync(fixturesDir, { recursive: true });

const highlight: Record<Category, Map<string, number>> = Object.fromEntries(CATEGORIES.map((c) => [c, new Map()])) as Record<Category, Map<string, number>>;
const report: string[] = [];

for (const [id, meta] of Object.entries(META)) {
  const rawMatch = html.match(new RegExp(`<textarea[^>]*id="raw-${id}"[^>]*>([\\s\\S]*?)</textarea>`));
  if (rawMatch?.[1] === undefined) throw new Error(`нет textarea raw-${id}`);
  const raw = decode(rawMatch[1]).replace(/\r\n/g, '\n').trim();

  // Блоки этой попытки идут сразу после её textarea и до следующей textarea / конца секции.
  const from = (rawMatch.index ?? 0) + rawMatch[0].length;
  const nextTextarea = html.indexOf('<textarea', from);
  const region = html.slice(from, nextTextarea === -1 ? undefined : nextTextarea);

  const blocks: { index: number; paragraphs: Paragraph[]; note: { kind: string; title: string; bullets: string[] } | null }[] = [];
  const articleRe = /<article class="blk">([\s\S]*?)<\/article>/g;
  for (const article of region.matchAll(articleRe)) {
    const body = article[1] ?? '';
    const ptxt = body.match(/<div class="ptxt">([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? body.match(/<div class="ptxt">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const paragraphs = [...ptxt.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => parseParagraph(m[1] ?? ''));
    const afterSrc = body.slice(body.indexOf('</div></div>') + 1);
    const kind = stripTags(afterSrc.match(/<span class="tagl[^"]*">([\s\S]*?)<\/span>/)?.[1] ?? '').trim();
    const title = stripTags(afterSrc.match(/<h5[^>]*>([\s\S]*?)<\/h5>/)?.[1] ?? afterSrc.match(/<h4[^>]*>([\s\S]*?)<\/h4>/)?.[1] ?? '').trim();
    const bullets = [...afterSrc.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1] ?? '').trim());
    blocks.push({ index: blocks.length + 1, paragraphs, note: bullets.length > 0 ? { kind, title, bullets } : null });
    for (const paragraph of paragraphs) {
      for (const span of paragraph.spans) {
        const key = span.text.trim();
        if (key !== '') highlight[span.category].set(key, (highlight[span.category].get(key) ?? 0) + 1);
      }
    }
  }

  const rawParagraphs = raw.split(/\n+/).map((p) => p.trim()).filter((p) => p !== '');
  const blockParagraphs = blocks.flatMap((b) => b.paragraphs.map((p) => p.text.trim()));
  const mismatches = rawParagraphs.filter((p, i) => blockParagraphs[i] !== p).length + Math.abs(rawParagraphs.length - blockParagraphs.length);

  const refs = [...new Set([...raw.matchAll(/<<<image_(\d+)>>>/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const lines = [...raw.matchAll(/«([^»]*)»/g)].map((m) => m[1] ?? '');

  writeFileSync(
    path.join(fixturesDir, `${id}.json`),
    `${JSON.stringify({ id, ...meta, stats: { chars: raw.length, words: raw.split(/\s+/).length, paragraphs: rawParagraphs.length, blocks: blocks.length, dialogueWords: lines.join(' ').split(/\s+/).filter(Boolean).length }, refs, lines, raw, blocks }, null, 1)}\n`,
  );
  report.push(`${id}: ${raw.length} зн., абзацев ${rawParagraphs.length}, блоков ${blocks.length}, реплик ${lines.length}, рефы [${refs.join(',')}], расхождений абзацев с raw: ${mismatches}`);
}

const highlightOut = Object.fromEntries(CATEGORIES.map((c) => [c, [...highlight[c].entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([text, count]) => ({ text, count }))]));
mkdirSync(path.join(ROOT, 'packs/cinema-doc'), { recursive: true });
writeFileSync(path.join(ROOT, 'packs/cinema-doc/highlight.json'), `${JSON.stringify({ source: 'docs/source/guide.html (hl-спаны)', categories: { ref: 'Референс', cam: 'Камера и оптика', imp: 'Дефекты оператора', look: 'Характер картинки', world: 'Мир, погода, свет', say: 'Реплики', neg: 'Запреты' }, phrases: highlightOut }, null, 1)}\n`);

const looks = html.match(/<script type="application\/json" id="look-data">([\s\S]*?)<\/script>/)?.[1];
if (looks !== undefined) writeFileSync(path.join(ROOT, 'packs/cinema-doc/looks.seed.json'), `${JSON.stringify(JSON.parse(looks), null, 1)}\n`);

console.log(report.join('\n'));
console.log(`подсветка: ${CATEGORIES.map((c) => `${c}=${highlight[c].size}`).join(' ')}`);
