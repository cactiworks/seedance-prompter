/**
 * Выгрузка дизайн-системы Lab UI из копии Figma-файла владельца через REST API.
 * Лимиты плана Starter не проверены → каждый сетевой запрос учитывается в raw/requests.log,
 * всё скачанное кэшируется на диск, повторный запуск сеть не трогает.
 *
 *   node scripts/design/figma-pull.ts file                 1 запрос: весь файл → raw/file.json
 *   node scripts/design/figma-pull.ts map                  офлайн: карта страниц, компонентов, стилей → map.json
 *   node scripts/design/figma-pull.ts renders <id,id,…>    1 запрос: PNG ×2 узлов → renders/
 *   node scripts/design/figma-pull.ts icons <id,id,…>      1 запрос: SVG узлов → icons/
 *   node scripts/design/figma-pull.ts budget               сколько запросов уже сделано
 *
 * Токен читается из macOS Keychain (запись figma-pat-lab-ui) и никогда не печатается и не пишется в файлы.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'design/lab-ui');
const RAW = path.join(DIR, 'raw');
const FILE_KEY = 'wP6urCw0zI90FXZny4KKzh'; // копия владельца; ключ файла — не секрет
const KEYCHAIN_ITEM = 'figma-pat-lab-ui';
const API = 'https://api.figma.com/v1';

function token(): string {
  try {
    const value = execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_ITEM, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (value === '') throw new Error('пусто');
    return value;
  } catch {
    console.error(`Нет токена в Keychain (запись «${KEYCHAIN_ITEM}»). См. docs/DECISIONS.md → чек-лист M0-d.`);
    process.exit(2);
  }
}

function logRequest(kind: string, status: number): void {
  mkdirSync(RAW, { recursive: true });
  appendFileSync(path.join(RAW, 'requests.log'), `${new Date().toISOString()}\t${kind}\t${status}\n`);
}

async function api(kind: string, url: string): Promise<Response> {
  const res = await fetch(url, { headers: { 'X-Figma-Token': token() } });
  logRequest(kind, res.status);
  if (res.status === 429) {
    // Не крутим ретраи: на Starter лимит может быть месячным, каждая попытка — расход бюджета.
    console.error(`429: лимит Figma API. Retry-After: ${res.headers.get('retry-after') ?? '?'} с. План: ${res.headers.get('x-figma-plan-tier') ?? '?'}, лимит: ${res.headers.get('x-figma-rate-limit-type') ?? '?'}.`);
    process.exit(3);
  }
  if (!res.ok) {
    console.error(`Figma API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(4);
  }
  return res;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  absoluteBoundingBox?: { width: number; height: number };
}

async function pullFile(): Promise<void> {
  const out = path.join(RAW, 'file.json');
  if (existsSync(out)) {
    console.log('raw/file.json уже есть — сеть не трогаю. Удали файл, чтобы перекачать.');
    return;
  }
  mkdirSync(RAW, { recursive: true });
  const res = await api('file', `${API}/files/${FILE_KEY}`);
  if (res.body === null) throw new Error('пустое тело ответа');
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(out));
  console.log(`raw/file.json сохранён (${(readFileSync(out).length / 1e6).toFixed(1)} МБ)`);
}

function buildMap(): void {
  const file = JSON.parse(readFileSync(path.join(RAW, 'file.json'), 'utf8')) as {
    name: string;
    lastModified: string;
    document: FigmaNode;
    components: Record<string, { name: string; componentSetId?: string }>;
    componentSets: Record<string, { name: string }>;
    styles: Record<string, { name: string; styleType: string }>;
  };
  const pages = (file.document.children ?? []).map((page) => ({
    id: page.id,
    name: page.name,
    frames: (page.children ?? []).map((frame) => ({ id: frame.id, name: frame.name, type: frame.type, w: Math.round(frame.absoluteBoundingBox?.width ?? 0), h: Math.round(frame.absoluteBoundingBox?.height ?? 0) })),
  }));
  const setVariants: Record<string, number> = {};
  for (const component of Object.values(file.components)) {
    if (component.componentSetId !== undefined) setVariants[component.componentSetId] = (setVariants[component.componentSetId] ?? 0) + 1;
  }
  const componentSets = Object.entries(file.componentSets).map(([id, set]) => ({ id, name: set.name, variants: setVariants[id] ?? 0 })).sort((a, b) => a.name.localeCompare(b.name));
  const looseComponents = Object.entries(file.components).filter(([, c]) => c.componentSetId === undefined).map(([id, c]) => ({ id, name: c.name }));
  const styles = Object.entries(file.styles).map(([id, s]) => ({ id, name: s.name, type: s.styleType })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  writeFileSync(path.join(DIR, 'map.json'), `${JSON.stringify({ file: file.name, lastModified: file.lastModified, pages, componentSets, looseComponents: looseComponents.length, styles }, null, 1)}\n`);
  console.log(`${file.name} · изменён ${file.lastModified}`);
  for (const page of pages) console.log(`  стр. ${page.id.padEnd(10)} ${page.name} — фреймов ${page.frames.length}`);
  console.log(`наборов компонентов: ${componentSets.length}, одиночных компонентов: ${looseComponents.length}, стилей: ${styles.length}`);
  const byType: Record<string, number> = {};
  for (const style of styles) byType[style.type] = (byType[style.type] ?? 0) + 1;
  console.log(`стили по типам: ${JSON.stringify(byType)}`);
}

async function pullImages(ids: string[], format: 'png' | 'svg'): Promise<void> {
  if (ids.length === 0) {
    console.error('Нужен список id узлов через запятую.');
    process.exit(1);
  }
  const outDir = path.join(DIR, format === 'png' ? 'renders' : 'icons');
  mkdirSync(outDir, { recursive: true });
  const query = new URLSearchParams({ ids: ids.join(','), format, ...(format === 'png' ? { scale: '2' } : { svg_simplify_stroke: 'true' }) });
  const res = await api(`images:${format}:${ids.length}`, `${API}/images/${FILE_KEY}?${query.toString()}`);
  const body = (await res.json()) as { images: Record<string, string | null> };
  let saved = 0;
  for (const [id, url] of Object.entries(body.images)) {
    if (url === null) {
      console.warn(`нет рендера для ${id}`);
      continue;
    }
    // Скачивание с S3 по выданной ссылке в лимит API не входит.
    const file = await fetch(url);
    writeFileSync(path.join(outDir, `${id.replace(/[:;]/g, '-')}.${format}`), Buffer.from(await file.arrayBuffer()));
    saved += 1;
  }
  console.log(`сохранено ${saved} из ${ids.length} → ${path.relative(ROOT, outDir)}/`);
}

function budget(): void {
  const log = path.join(RAW, 'requests.log');
  if (!existsSync(log)) {
    console.log('Запросов к Figma API ещё не было.');
    return;
  }
  const rows = readFileSync(log, 'utf8').trim().split('\n');
  console.log(`Запросов к Figma API: ${rows.length}\n${rows.join('\n')}`);
}

const [command, arg] = process.argv.slice(2);
const ids = (arg ?? '').split(',').map((id) => id.trim()).filter(Boolean);
if (command === 'file') await pullFile();
else if (command === 'map') buildMap();
else if (command === 'renders') await pullImages(ids, 'png');
else if (command === 'icons') await pullImages(ids, 'svg');
else if (command === 'budget') budget();
else console.log('Команды: file | map | renders <ids> | icons <ids> | budget');
