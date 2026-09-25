import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FieldItem, FieldsOutput } from '../../src/core/compose.ts';
import { newProject, type Project } from '../../src/core/model/project.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import type { LlmRequest } from '../../src/server/llm/claudeCli/provider.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };
const emptyKit = { camera: '', lens: '', look: '', lensNote: '' };

const project: Project = {
  ...newProject('demo', 'Демо'),
  world: { place: { ru: 'Тихая набережная', en: '', source: 'empty', locked: false }, useOnlyEn: 'the space', weather: { ru: 'Дождь закончился', en: '', source: 'empty', locked: false } },
  entities: [{ key: 'sasha', nameRu: 'Саша', name: '', kind: 'character', refKey: null }],
};

describe('POST /api/llm/fields', () => {
  it('агент получает только русские поля; плохой ответ уходит на ремонт; ответ нормализован', async () => {
    const calls: LlmRequest[] = [];
    const answers: FieldsOutput[] = [
      { texts: [{ id: 'place', en: 'a quiet embankment.' }, { id: 'weather', en: 'Дождь' }], kit: emptyKit, notesRu: '' },
      { texts: [{ id: 'place', en: 'a quiet embankment.' }, { id: 'weather', en: 'The rain has just stopped. Wet asphalt, puddles reflecting the sky.' }, { id: 'entity:sasha', en: 'Sasha' }], kit: emptyKit, notesRu: 'Сторона света не указана — взял мягкое солнце.' },
    ];
    const app = createApp({
      rootDir: ROOT,
      dataDir: mkdtempSync(path.join(tmpdir(), 'sp-fields-')),
      runLlm: async <T>(request: LlmRequest) => {
        calls.push(request);
        return { data: answers[calls.length - 1] as T, meta: { durationMs: 5, model: 'mock', turns: 2, inputTokens: 10, outputTokens: 10 } };
      },
    });
    const res = await app.request('/api/llm/fields', { method: 'POST', headers, body: JSON.stringify({ project, shotId: 'shot-1' }) });
    const body = (await res.json()) as { items: FieldItem[]; output: FieldsOutput; problems: string[] };

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.system).toContain('field writer');
    expect(calls[0]?.user).toContain('Тихая набережная');
    expect(calls[1]?.user).toContain('entity:sasha must be returned exactly once');
    expect(calls[1]?.user).toContain('weather: English only');
    expect(body.problems).toEqual([]);
    expect(body.output.texts.find((t) => t.id === 'place')?.en).toBe('a quiet embankment');
    expect(body.output.kit).toBeNull();
    expect(body.items.map((item) => item.id)).toEqual(['place', 'weather', 'entity:sasha']);
  });

  it('переводить нечего — ответ без вызова LLM', async () => {
    const app = createApp({ rootDir: ROOT, dataDir: mkdtempSync(path.join(tmpdir(), 'sp-fields-')), runLlm: async () => Promise.reject(new Error('не должен вызываться')) });
    const res = await app.request('/api/llm/fields', { method: 'POST', headers, body: JSON.stringify({ project: newProject('demo', 'Демо'), shotId: 'shot-1' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { output: unknown }).output).toBeNull();
  });
});
