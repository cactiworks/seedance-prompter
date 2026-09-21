import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { flagsFromVision, type VisionOutput } from '../../src/core/llm/buildVision.ts';
import type { Project } from '../../src/core/model/project.ts';
import { buildShot, type PackBundle } from '../../src/core/pipeline.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import type { LlmRequest } from '../../src/server/llm/claudeCli/provider.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const host = `${HOST}:${PORT}`;
const headers = { host, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };
const report = (patch: Partial<VisionOutput>): VisionOutput => ({ peopleCount: 0, readableText: '', backdrop: 'real', summaryRu: '', risksRu: [], ...patch });

describe('флаги референса из vision-отчёта', () => {
  it('человек на локации и на предмете — утечка; персонаж на своей карте — нет', () => {
    expect(flagsFromVision(report({ peopleCount: 1 }), 'location').hasPeople).toBe(true);
    expect(flagsFromVision(report({ peopleCount: 1 }), 'object').hasPeople).toBe(true);
    expect(flagsFromVision(report({ peopleCount: 1 }), 'character').hasPeople).toBe(false);
    expect(flagsFromVision(report({ peopleCount: 2 }), 'character').hasPeople).toBe(true);
  });

  it('текст и студийный задник', () => {
    expect(flagsFromVision(report({ readableText: 'RED V-RAPTOR 8K VV', backdrop: 'studio' }), 'gear')).toEqual({ hasPeople: false, hasText: true, studioBackdrop: true });
  });
});

describe('POST /api/llm/vision и правила линтера по флагам', () => {
  it('в LLM уходит уменьшенная копия base64-блоком; без копии и без картинки — отказ без вызова', async () => {
    const calls: LlmRequest[] = [];
    const app = createApp({
      rootDir: ROOT,
      dataDir: mkdtempSync(path.join(tmpdir(), 'sp-vision-')),
      runLlm: async <T>(request: LlmRequest) => {
        calls.push(request);
        return { data: report({ peopleCount: 1, readableText: 'Cooke Panchro Classic FF', summaryRu: 'Карточка объективов с подписью.', risksRu: ['Подпись может попасть в кадр.'] }) as T, meta: { durationMs: 5, model: 'mock', turns: 2, inputTokens: 1, outputTokens: 1 } };
      },
    });
    const created = (await (await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify({ slug: 'demo', title: 'Демо' }) })).json()) as Project;
    const flags = { hasPeople: false, hasText: false, studioBackdrop: false };
    const project: Project = { ...created, refs: [{ key: 'cooke', label: 'Объективы Cooke', kind: 'gear', file: 'cooke.jpg', flags }, { key: 'empty', label: 'Без картинки', kind: 'object', file: null, flags }] };
    await app.request('/api/projects/demo', { method: 'PUT', headers: { ...headers, 'if-match': '1' }, body: JSON.stringify(project) });

    const noImage = await app.request('/api/llm/vision', { method: 'POST', headers, body: JSON.stringify({ slug: 'demo', refKey: 'empty' }) });
    const noCopy = await app.request('/api/llm/vision', { method: 'POST', headers, body: JSON.stringify({ slug: 'demo', refKey: 'cooke' }) });
    expect([noImage.status, noCopy.status]).toEqual([422, 422]);
    expect(calls).toHaveLength(0);

    await app.request('/api/projects/demo/refs/cooke-vision.jpg', { method: 'PUT', headers: { host, [CLIENT_HEADER]: '1' }, body: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]) });
    const ok = await app.request('/api/llm/vision', { method: 'POST', headers, body: JSON.stringify({ slug: 'demo', refKey: 'cooke' }) });
    expect(ok.status).toBe(200);
    expect(calls[0]?.images?.[0]).toEqual({ mediaType: 'image/jpeg', base64: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64') });
    expect(calls[0]?.user).toContain('kind="gear"');
    expect(((await ok.json()) as { flags: unknown }).flags).toEqual({ hasPeople: true, hasText: true, studioBackdrop: false });
  });

  it('флаги дают находки: текст на референсе, человек на референсе предмета, студийный задник без сущности', async () => {
    const app = createApp({ rootDir: ROOT, dataDir: mkdtempSync(path.join(tmpdir(), 'sp-vision-')) });
    const pack = (await (await app.request('/api/packs/cinema-doc', { headers: { host } })).json()) as PackBundle;
    const created = (await (await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify({ slug: 'demo', title: 'Демо' }) })).json()) as Project;
    const shot = created.shots[0];
    if (shot === undefined) throw new Error('нет кадра');
    const project: Project = {
      ...created,
      refs: [
        { key: 'loc', label: 'Набережная', kind: 'location', file: null, flags: { hasPeople: true, hasText: false, studioBackdrop: false } },
        { key: 'red', label: 'Карточка RED', kind: 'gear', file: null, flags: { hasPeople: false, hasText: true, studioBackdrop: false } },
        { key: 'pickup', label: 'Пикап', kind: 'object', file: null, flags: { hasPeople: true, hasText: false, studioBackdrop: false } },
        { key: 'sheet', label: 'Карта героя', kind: 'character', file: null, flags: { hasPeople: false, hasText: false, studioBackdrop: true } },
      ],
    };
    const rules = buildShot(project, { ...shot, panel: ['loc', 'red', 'pickup', 'sheet'], locationRefs: ['loc'] }, pack).findings.filter((f) => f.ruleId.startsWith('REF_') && f.ruleId !== 'REF_UNUSED').map((f) => f.ruleId);
    // Человек на референсе локации — не находка: формула гайда «Ignore any people present» стоит всегда.
    expect(rules).toEqual(['REF_TEXT_ON_REF', 'REF_PEOPLE_ON_OBJECT_REF', 'REF_STUDIO_BACKDROP']);
  });
});
