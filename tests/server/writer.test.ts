import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWriterSystem, linesInBeats, type FewShot } from '../../src/core/llm/buildWriter.ts';
import { validateWriterOutput, type ValidationContext } from '../../src/core/llm/validate.ts';
import { newProject, type Project } from '../../src/core/model/project.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import type { LlmRequest } from '../../src/server/llm/codexCli/provider.ts';
import type { WriteShotResult } from '../../src/server/llm/tasks/write.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };

const ctx: ValidationContext = {
  writable: ['seg-1'],
  requiredLines: { 'seg-1': ['L1', 'L2'] },
  known: { intro: ['alex', 'pickup'], ref: ['loc'], line: ['L1', 'L2'], state: ['S1'] },
  alreadyIntroduced: ['pickup'],
};
const codes = (en: string, segmentId = 'seg-1') => validateWriterOutput({ blocks: [{ segmentId, en }] }, ctx).map((v) => v.code);

describe('контракт писателя: LLM не пишет номера, реплики и русский текст', () => {
  it('чистый абзац проходит', () => {
    expect(codes('{{intro:alex}} steps out of the pickup and {{line:L1}} He stumbles on a word. The frame shakes. He {{line:L2}}')).toEqual([]);
  });

  it('ловит сырые номера и чужой синтаксис ссылок', () => {
    expect(codes('Alexander, matching <<<image_5>>>, {{line:L1}} then {{line:L2}}')).toContain('RAW_REF');
    expect(codes('Alexander from @image7 {{line:L1}} {{line:L2}}')).toContain('RAW_REF');
  });

  it('ловит реплику, написанную текстом, и кириллицу', () => {
    const found = codes('{{intro:alex}} says: «Привет» {{line:L1}} {{line:L2}}');
    expect(found).toContain('RAW_LINE');
    expect(found).toContain('CYRILLIC');
  });

  it('ловит неизвестный id, кривой плейсхолдер, пропущенную и задвоенную реплику, порядок', () => {
    expect(codes('{{intro:john}} {{line:L1}} {{line:L2}}')).toContain('UNKNOWN_ID');
    expect(codes('{{ref: loc}} {{line:L1}} {{line:L2}}')).toContain('MALFORMED_PLACEHOLDER');
    expect(codes('{{intro:alex}} {{line:L1}}')).toContain('LINE_MISSING');
    expect(codes('{{intro:alex}} {{line:L1}} {{line:L1}} {{line:L2}}')).toContain('LINE_DUPLICATED');
    expect(codes('{{intro:alex}} {{line:L2}} then {{line:L1}}')).toContain('LINE_ORDER');
  });

  it('повторное представление сущности запрещено, чужой и пропущенный сегмент называются', () => {
    expect(codes('{{intro:pickup}} {{line:L1}} {{line:L2}}')).toContain('INTRO_DUPLICATED');
    expect(codes('text', 'seg-9')).toEqual(expect.arrayContaining(['UNKNOWN_SEGMENT', 'MISSING_SEGMENT']));
  });

  it('реплики берутся из битов в порядке упоминания', () => {
    expect(linesInBeats('Говорит L2, блокирует удар, потом L1 и снова L2. L9 не существует.', ['L1', 'L2'])).toEqual(['L2', 'L1']);
  });
});

describe('системный промпт агента', () => {
  const rules = readFileSync(path.join(ROOT, 'packs/cinema-doc/prompts/writer.system.md'), 'utf8');
  const fewshot = JSON.parse(readFileSync(path.join(ROOT, 'packs/cinema-doc/prompts/fewshot/k2.json'), 'utf8')) as FewShot;
  const system = buildWriterSystem(rules, fewshot);

  it('стабилен байт в байт (prompt cache) и не содержит ни одного номера ссылки', () => {
    expect(buildWriterSystem(rules, fewshot)).toBe(system);
    // Единственное вхождение <<<image — поясняющая строка контракта; в примере номеров нет.
    expect(system.match(/<<<image_\d+>>>/g)).toEqual(['<<<image_6>>>']);
    expect(system).toContain('{{intro:alexander}}');
    expect(system).toContain('{{line:L1}}');
  });

  it('пример гайда сам проходит контракт', () => {
    const lineIds = fewshot.lines.map((l) => l.id);
    const violations = validateWriterOutput(
      { blocks: fewshot.segments.map((s) => ({ segmentId: s.id, en: s.en })) },
      { writable: fewshot.segments.map((s) => s.id), requiredLines: Object.fromEntries(fewshot.segments.map((s) => [s.id, linesInBeats(s.beatsRu, lineIds)])), known: { intro: fewshot.entities.map((e) => e.key), ref: [], line: lineIds, state: [] }, alreadyIntroduced: [] },
    );
    expect(violations).toEqual([]);
  });
});

describe('POST /api/llm/write: агент → валидатор и линтер → ремонт', () => {
  const project: Project = {
    ...newProject('demo', 'Демо'),
    world: { place: { ru: '', en: 'a quiet embankment', source: 'manual', locked: true }, useOnlyEn: 'the space and sky', weather: { ru: '', en: 'Wet asphalt, puddles reflecting the sky, a light wind.', source: 'manual', locked: true } },
    refs: [{ key: 'loc', label: 'Место', kind: 'location', file: null, flags: { hasPeople: false, hasText: false, studioBackdrop: false } }, { key: 'hero', label: 'Герой', kind: 'character', file: null, flags: { hasPeople: false, hasText: false, studioBackdrop: false } }],
    entities: [{ key: 'alex', name: 'Alexander', kind: 'character', refKey: 'hero' }],
    lines: [{ id: 'L1', speakerKey: 'alex', ru: 'Привет.', proofread: true }],
  };
  project.shots = project.shots.map((s) => ({ ...s, panel: ['loc', 'hero'], locationRefs: ['loc'], segments: [{ id: 'seg-1', titleRu: '', beatsRu: 'Alexander выходит и говорит L1.', text: { ru: '', en: '', source: 'empty' as const, locked: false } }] }));

  it('грязный первый ответ уходит на ремонт с конкретными нарушениями; принимается чистый', async () => {
    const calls: LlmRequest[] = [];
    const answers = [
      { blocks: [{ segmentId: 'seg-1', en: 'The operator jumps out. Alexander, matching <<<image_2>>>, says: «Привет.»' }] },
      { blocks: [{ segmentId: 'seg-1', en: '{{intro:alex}} steps out and {{line:L1}} A cloud passes, the light shifts for two seconds, then returns.', notesRu: 'Добавил световое событие.' }] },
    ];
    const app = createApp({
      rootDir: ROOT,
      dataDir: mkdtempSync(path.join(tmpdir(), 'sp-writer-')),
      runLlm: async <T>(request: LlmRequest) => {
        calls.push(request);
        return { data: answers[calls.length - 1] as T, meta: { durationMs: 10, model: 'mock', turns: 2, inputTokens: 100, outputTokens: 50 } };
      },
    });

    const res = await app.request('/api/llm/write', { method: 'POST', headers, body: JSON.stringify({ project, shotId: 'shot-1' }) });
    expect(res.status).toBe(200);
    const result = (await res.json()) as WriteShotResult;

    expect(calls).toHaveLength(2);
    expect(calls[1]?.user).toContain('Never write reference numbers');
    expect(calls[1]?.user).toContain('Never write dialogue text');
    expect(calls[0]?.system).toBe(calls[1]?.system);
    expect(result.rounds).toBe(2);
    expect(result.remaining.violations).toEqual([]);
    expect(result.blocks[0]?.en).toContain('{{line:L1}}');
    expect(result.blocks[0]?.notesRu).toBe('Добавил световое событие.');
  });

  it('заблокированный отрезок писатель не трогает; без русских битов писать нечего', async () => {
    const locked: Project = { ...project, shots: project.shots.map((s) => ({ ...s, segments: s.segments.map((x) => ({ ...x, text: { ...x.text, en: 'Manual text.', locked: true } })) })) };
    const app = createApp({ rootDir: ROOT, dataDir: mkdtempSync(path.join(tmpdir(), 'sp-writer-')), runLlm: async () => Promise.reject(new Error('не должен вызываться')) });
    const res = await app.request('/api/llm/write', { method: 'POST', headers, body: JSON.stringify({ project: locked, shotId: 'shot-1' }) });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { messageRu: string }).messageRu).toContain('Нечего писать');
  });
});
