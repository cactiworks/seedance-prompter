import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractLines, validatePlan, type PlannerOutput } from '../../src/core/llm/buildPlanner.ts';
import { newProject } from '../../src/core/model/project.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import type { LlmRequest } from '../../src/server/llm/claudeCli/provider.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };

describe('реплики вынимаются из синопсиса детерминированно', () => {
  it('«ёлочки» → L-id, текст буква в букву; существующая реплика переиспользуется', () => {
    const out = extractLines('Он говорит: «Сейчас мы снимаем на Sony.» Потом драка. Снова: «Привет.» и ещё раз «Сейчас мы снимаем на Sony.»', [{ id: 'L1', ru: 'Привет.' }]);
    expect(out.text).toBe('Он говорит: L2 Потом драка. Снова: L1 и ещё раз L2');
    expect(out.newLines).toEqual([{ id: 'L2', ru: 'Сейчас мы снимаем на Sony.' }]);
  });

  it('без реплик синопсис не меняется', () => {
    expect(extractLines('Пикап заносит на мокрой дороге.', [])).toEqual({ text: 'Пикап заносит на мокрой дороге.', newLines: [] });
  });
});

const plan = (segments: string[], extra: Partial<PlannerOutput> = {}): PlannerOutput => ({ segments: segments.map((beatsRu, i) => ({ titleRu: `Отрезок ${i + 1}`, beatsRu })), placeEn: '', weatherEn: '', notesRu: '', ...extra });

describe('проверка плана', () => {
  it('чистый план проходит', () => {
    expect(validatePlan(plan(['Пикап заносит.', 'Alexander выходит и говорит L1.', 'Облако, пауза, финал, L2.']), ['L1', 'L2'])).toEqual([]);
  });

  it('ловит потерянную, задвоенную и переставленную реплику, текст реплики и кириллицу в английском', () => {
    expect(validatePlan(plan(['A', 'говорит L1']), ['L1', 'L2']).join(' ')).toContain('L2 must be placed');
    expect(validatePlan(plan(['L1 здесь', 'и L1 тут']), ['L1']).join(' ')).toContain('found 2');
    expect(validatePlan(plan(['сначала L2', 'потом L1']), ['L1', 'L2']).join(' ')).toContain('spoken order');
    expect(validatePlan(plan(['говорит «Привет»', 'финал']), []).join(' ')).toContain('by id only');
    expect(validatePlan(plan(['A', 'B'], { placeEn: 'набережная' }), []).join(' ')).toContain('must be English');
    expect(validatePlan(plan(['только один']), []).join(' ')).toContain('expected 2–8');
  });
});

describe('POST /api/llm/plan', () => {
  it('планировщик получает синопсис без текста реплик; плохой план уходит на ремонт', async () => {
    const calls: LlmRequest[] = [];
    const answers: PlannerOutput[] = [plan(['Пикап заносит.', 'Финал.']), plan(['Пикап заносит.', 'Alexander говорит L1.', 'Финал.'], { placeEn: 'a quiet embankment', notesRu: 'Борт пикапа — риск механики.' })];
    const app = createApp({
      rootDir: ROOT,
      dataDir: mkdtempSync(path.join(tmpdir(), 'sp-plan-')),
      runLlm: async <T>(request: LlmRequest) => {
        calls.push(request);
        return { data: answers[calls.length - 1] as T, meta: { durationMs: 5, model: 'mock', turns: 2, inputTokens: 10, outputTokens: 10 } };
      },
    });
    const project = { ...newProject('demo', 'Демо'), world: { place: { ru: 'Тихая набережная', en: '', source: 'empty', locked: false }, useOnlyEn: 'the space', weather: { ru: '', en: '', source: 'empty', locked: false } } };
    const res = await app.request('/api/llm/plan', { method: 'POST', headers, body: JSON.stringify({ project, synopsisRu: 'Пикап заносит. Alexander выходит и говорит: «Почему у одних видео получаются настоящими?» Финал.' }) });
    const body = (await res.json()) as { plan: PlannerOutput; newLines: { id: string; ru: string }[]; problems: string[] };

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.user).not.toContain('Почему у одних видео');
    expect(calls[0]?.user).toContain('"lineIds"');
    expect(calls[0]?.user).toContain('Тихая набережная');
    expect(calls[1]?.user).toContain('L1 must be placed');
    expect(body.newLines).toEqual([{ id: 'L1', ru: 'Почему у одних видео получаются настоящими?' }]);
    expect(body.problems).toEqual([]);
    expect(body.plan.segments).toHaveLength(3);
  });

  it('пустой синопсис — 422 без вызова LLM', async () => {
    const app = createApp({ rootDir: ROOT, dataDir: mkdtempSync(path.join(tmpdir(), 'sp-plan-')), runLlm: async () => Promise.reject(new Error('не должен вызываться')) });
    const res = await app.request('/api/llm/plan', { method: 'POST', headers, body: JSON.stringify({ project: newProject('demo', 'Демо'), synopsisRu: '  ' }) });
    expect(res.status).toBe(422);
  });
});
