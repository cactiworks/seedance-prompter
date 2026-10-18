import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCriticSystem, buildCriticUser, verifyCritique, type CriticOutput, type SymptomCatalog } from '../../src/core/llm/buildCritic.ts';
import { newProject, type Critique, type Project } from '../../src/core/model/project.ts';
import { buildShot, type PackBundle } from '../../src/core/pipeline.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import type { LlmRequest } from '../../src/server/llm/codexCli/provider.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const host = `${HOST}:${PORT}`;
const headers = { host, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };
const flags = { hasPeople: false, hasText: false, studioBackdrop: false };
const unit = (en: string) => ({ ru: '', en, source: 'manual' as const, locked: true });

/** Собранный кадр без блокеров: герой с референсом, реплика, финал. */
function project(): Project {
  const base = newProject('demo', 'Демо');
  return {
    ...base,
    world: { place: unit('a quiet embankment'), useOnlyEn: 'the space and sky', weather: unit('Wet asphalt, puddles reflecting the sky, steam rising, a light wind.') },
    refs: [{ key: 'loc', label: 'Набережная', kind: 'location', file: null, flags }, { key: 'hero', label: 'Герой', kind: 'character', file: 'hero.jpg', flags }],
    entities: [{ key: 'alex', name: 'Alexander', kind: 'character', refKey: 'hero' }],
    lines: [{ id: 'L1', speakerKey: 'alex', ru: 'Привет.', proofread: true }],
    shots: base.shots.map((s) => ({
      ...s,
      panel: ['loc', 'hero'],
      locationRefs: ['loc'],
      segments: [
        { id: 'seg-1', titleRu: '', beatsRu: '', text: unit('{{intro:alex}} stands near the pickup in a medium shot, looks into the lens and {{line:L1}}') },
        { id: 'seg-2', titleRu: '', beatsRu: '', text: unit('He presses a bag of ice in his left hand to his right cheek. A second of silence, just the wind. The camera slowly lowers, as if the arms holding it are finally tired.') },
      ],
    })),
  };
}

const pack = (): PackBundle => {
  const dir = path.join(ROOT, 'packs/cinema-doc');
  const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as T;
  const kits: PackBundle['kits'] = {};
  for (const file of readdirSync(path.join(dir, 'kits'))) {
    const kit = read<PackBundle['kits'][string]>(`kits/${file}`);
    kits[kit.id] = kit;
  }
  return { id: 'cinema-doc', verbatim: read('verbatim.json'), kits, dialects: read('dialects.json'), lexicon: read('lexicon.json'), lintParams: read('lint.json') };
};

describe('критик: вход и проверка ответа', () => {
  const p = project();
  const shot = p.shots[0];
  if (shot === undefined) throw new Error('нет кадра');
  const build = buildShot(p, shot, pack());

  it('критик видит промпт как видеомодель: развёрнутые номера и реплики, панель с ролями, что уже нашёл линтер', () => {
    const user = buildCriticUser({ project: p, shot, paragraphs: build.paragraphs, resolvedParagraphs: build.resolvedParagraphs, durationSec: 30, findings: build.findings });
    expect(user).toContain('Alexander, matching <<<image_2>>>');
    expect(user).toContain('«Привет.»');
    expect(user).not.toContain('{{intro');
    expect(user).toMatch(/"n": 2,\s+"label": "Герой",\s+"kind": "character",\s+"boundTo": \[\s+"Alexander"\s+\]/);
    expect(user).toContain('"durationSec": 30');
  });

  it('system prompt стабилен между вызовами и несёт таблицу симптомов pack', () => {
    const catalog = JSON.parse(readFileSync(path.join(ROOT, 'packs/cinema-doc/symptoms.json'), 'utf8')) as SymptomCatalog;
    const rules = readFileSync(path.join(ROOT, 'packs/cinema-doc/prompts/critic.system.md'), 'utf8');
    const a = buildCriticSystem(rules, catalog);
    expect(a).toBe(buildCriticSystem(rules, catalog));
    expect(a).toContain('"id": "operator-visible"');
    expect(a).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it('находка без цитаты в тексте выбрасывается; цитата из другого абзаца переадресуется; вердикт не мягче найденного', () => {
    const output: CriticOutput = {
      readback: [{ paragraph: 4, seesRu: 'Герой у пикапа говорит в камеру.' }, { paragraph: 99, seesRu: 'мимо' }],
      findings: [
        { severity: 'note', category: 'finale', quote: 'the arms holding it are finally tired', paragraph: 1, problemRu: 'Финал есть.', fixRu: '—' },
        { severity: 'critical', category: 'physics', quote: 'bag of ice in his left hand to his right cheek', paragraph: 5, problemRu: 'Левой рукой к правой щеке — неудобно, модель нарисует руку поперёк лица.', fixRu: 'Правая рука или левая щека.' },
        { severity: 'critical', category: 'operator', quote: 'the operator jumps out of the truck', paragraph: 4, problemRu: 'Оператор в кадре.', fixRu: 'Убрать.' },
      ],
      verdict: 'ready',
      summaryRu: 'Ок.',
    };
    const { critique, droppedRu } = verifyCritique(output, build.resolvedParagraphs);
    const finale = build.resolvedParagraphs.findIndex((t) => t.includes('finally tired')) + 1;
    expect(critique.findings.map((f) => [f.category, f.paragraph])).toEqual([['physics', 5], ['finale', finale]]);
    expect(droppedRu).toHaveLength(1);
    expect(droppedRu[0]).toContain('Оператор в кадре');
    expect(critique.verdict).toBe('not-ready');
    expect(critique.readback.map((r) => r.paragraph)).toEqual([4]);
  });

  it('XML-подобные хвосты модели вычищаются из всех полей для владельца', () => {
    const output: CriticOutput = { readback: [{ paragraph: 4, seesRu: 'Герой у пикапа.</seesRu>' }], findings: [{ severity: 'note', category: 'finale</category>', quote: 'finally tired', paragraph: 5, problemRu: 'Ок.</problemRu>', fixRu: '—' }], verdict: 'ready', summaryRu: 'Простой кадр.</summaryRu>' };
    const { critique } = verifyCritique(output, build.resolvedParagraphs);
    expect(critique.summaryRu).toBe('Простой кадр.');
    expect(critique.readback[0]?.seesRu).toBe('Герой у пикапа.');
    expect(critique.findings[0]?.problemRu).toBe('Ок.');
    expect(critique.findings[0]?.category).toBe('finale');
  });

  it('двухреференсная формула локации остаётся байт в байт, однореференсная схлопывается и в длинной форме', () => {
    const p2: Project = { ...p, refs: [...p.refs, { key: 'loc2', label: 'Набережная 2', kind: 'location', file: null, flags }] };
    const two = buildShot(p2, { ...shot, panel: ['loc', 'loc2', 'hero'], locationRefs: ['loc', 'loc2'], locationRule: 'long' }, pack());
    expect(two.prompt).toContain('exactly as in <<<image_1>>> and <<<image_2>>> —');
    expect(two.prompt).toContain('Ignore any people present in <<<image_1>>> and <<<image_2>>>.');
    const one = buildShot(p, { ...shot, locationRule: 'long' }, pack());
    expect(one.prompt).toContain('Ignore any people present in <<<image_1>>>.');
  });
});

describe('POST /api/llm/critique и экспорт панели', () => {
  it('без блокеров критик получает собранный промпт; ответ возвращается проверенным и с текстом, для которого сделан', async () => {
    const calls: LlmRequest[] = [];
    const app = createApp({
      rootDir: ROOT,
      dataDir: mkdtempSync(path.join(tmpdir(), 'sp-critic-')),
      reveal: false,
      runLlm: async <T>(request: LlmRequest) => {
        calls.push(request);
        const data: CriticOutput = { readback: [{ paragraph: 4, seesRu: 'Герой говорит в камеру.' }], findings: [{ severity: 'warning', category: 'physics', quote: 'left hand to his right cheek', paragraph: 5, problemRu: 'Рука поперёк лица.', fixRu: 'Сменить руку.' }, { severity: 'critical', category: 'x', quote: 'nothing like this', paragraph: 1, problemRu: 'Выдумка.', fixRu: '—' }], verdict: 'ready', summaryRu: 'Простой кадр.' };
        return { data: data as T, meta: { durationMs: 5, model: 'mock', turns: 2, inputTokens: 1, outputTokens: 1 } };
      },
    });
    const p = project();
    const res = await app.request('/api/llm/critique', { method: 'POST', headers, body: JSON.stringify({ project: p, shotId: 'shot-1' }) });
    expect(res.status).toBe(200);
    const { critique } = (await res.json()) as { critique: Critique };
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toContain('# Known failures');
    expect(critique.findings.map((f) => f.category)).toEqual(['physics']);
    expect(critique.verdict).toBe('risky');
    expect(critique.droppedRu).toHaveLength(1);
    expect(critique.prompt).toContain('Alexander, matching <<<image_2>>>');

    // С блокерами вызова нет: квота не тратится на несобранный промпт.
    const broken = { ...p, world: { ...p.world, place: unit('') } };
    const blocked = await app.request('/api/llm/critique', { method: 'POST', headers, body: JSON.stringify({ project: broken, shotId: 'shot-1' }) });
    expect(blocked.status).toBe(422);
    expect(calls).toHaveLength(1);

    // Снятое владельцем требование учитывает тот же core и на сервере.
    const brokenShot = broken.shots[0]!;
    const finding = buildShot(broken, brokenShot, pack()).blockers.find((b) => b.code === 'NO_PLACE')!;
    const accepted = { ...broken, shots: [{ ...brokenShot, suppressed: [{ fingerprint: finding.fingerprint!, reasonRu: 'Место видно на референсе.' }] }] };
    const reviewed = await app.request('/api/llm/critique', { method: 'POST', headers, body: JSON.stringify({ project: accepted, shotId: 'shot-1' }) });
    expect(reviewed.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('экспорт панели: файлы 01-…, 02-… в порядке панели; референс без картинки — пропуск с пометкой', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-export-'));
    const revealed: string[] = [];
    const app = createApp({ rootDir: ROOT, dataDir, reveal: (dir) => revealed.push(dir) });
    const created = (await (await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify({ slug: 'demo', title: 'Демо' }) })).json()) as Project;
    const p: Project = { ...created, refs: [{ key: 'loc', label: 'Набережная', kind: 'location', file: null, flags }, { key: 'hero', label: 'Герой', kind: 'character', file: 'hero.png?v=123', flags }], shots: created.shots.map((s) => ({ ...s, panel: ['loc', 'hero'], locationRefs: ['loc'] })) };
    await app.request('/api/projects/demo', { method: 'PUT', headers: { ...headers, 'if-match': '1' }, body: JSON.stringify(p) });
    await app.request('/api/projects/demo/refs/hero.png', { method: 'PUT', headers: { host, [CLIENT_HEADER]: '1' }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });

    const res = await app.request('/api/projects/demo/shots/shot-1/export', { method: 'POST', headers });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { dir: string; files: { n: number; key: string; file: string | null }[] };
    expect(result.files).toEqual([{ n: 1, key: 'loc', file: null }, { n: 2, key: 'hero', file: '02-hero.png' }]);
    expect(readdirSync(result.dir)).toEqual(['02-hero.png']);
    expect(existsSync(path.join(dataDir, 'projects/demo/export/shot-1/02-hero.png'))).toBe(true);
    expect(revealed).toEqual([result.dir]);
    expect((await app.request('/api/projects/demo/shots/nope/export', { method: 'POST', headers })).status).toBe(404);
  });
});
