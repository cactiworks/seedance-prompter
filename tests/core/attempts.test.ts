import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeRatio, diffWords } from '../../src/core/attempts/diff.ts';
import { newProject, type Project } from '../../src/core/model/project.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import type { LlmRequest } from '../../src/server/llm/claudeCli/provider.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };

describe('пословный diff попыток', () => {
  it('показывает замену глаголов оператора глаголами камеры — как между попытками 2 и 3 Кадра 1', () => {
    const before = 'The operator slowly pulls back, still tracking. The operator lowers the camera slightly, as if his arms are tired.';
    const after = 'The camera slowly pulls back, still tracking. The camera lowers slightly, as if the arms holding it are tired.';
    const parts = diffWords(before, after);
    const removed = parts.filter((p) => p.type === 'del').map((p) => p.text).join(' ');
    const added = parts.filter((p) => p.type === 'add').map((p) => p.text).join(' ');
    expect(removed.match(/operator/g)).toHaveLength(2);
    expect(removed).toContain('his');
    expect(added).toContain('camera');
    expect(added).toContain('holding');
    // Неизменённое остаётся общим: правка точечная, а не переписывание абзаца.
    expect(changeRatio(parts)).toBeLessThan(0.45);
    expect(parts.map((p) => (p.type === 'del' ? '' : p.text)).join('')).toBe(after);
    expect(parts.map((p) => (p.type === 'add' ? '' : p.text)).join('')).toBe(before);
  });

  it('плейсхолдер — один токен; одинаковый текст не даёт правок', () => {
    const parts = diffWords('He turns and {{line:L1}} Then waits.', 'He turns and {{line:L2}} Then waits.');
    expect(parts.filter((p) => p.type !== 'same').map((p) => p.text)).toEqual(['{{line:L1}}', '{{line:L2}}']);
    expect(changeRatio(diffWords('same text', 'same text'))).toBe(0);
  });
});

describe('словарь симптомов покрывает таблицу ошибок гайда', () => {
  const catalog = JSON.parse(readFileSync(path.join(ROOT, 'packs/cinema-doc/symptoms.json'), 'utf8')) as { groups: Record<string, string>; symptoms: { id: string; group: string; fixEn: string; checkRu: string }[] };

  it('все десять строк таблицы гайда представлены; у каждого симптома есть либо починка агентом, либо действие владельца', () => {
    const ids = catalog.symptoms.map((s) => s.id);
    for (const id of ['wrong-object', 'extra-became-hero', 'wrong-clothes', 'operator-visible', 'mechanics-broken', 'objects-merged', 'injury-wrong', 'fx-on-prop', 'ref-leak', 'cut-mid-motion']) expect(ids, id).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of catalog.symptoms) {
      expect(Object.keys(catalog.groups), s.id).toContain(s.group);
      expect(s.fixEn.trim() !== '' || s.checkRu.trim() !== '', s.id).toBe(true);
    }
  });
});

describe('POST /api/llm/fix: симптомы попытки → минимальные правки как предложение', () => {
  const base = newProject('demo', 'Демо');
  const project: Project = {
    ...base,
    world: { place: { ru: '', en: 'a quiet embankment', source: 'manual', locked: true }, useOnlyEn: 'the space and sky', weather: { ru: '', en: 'Wet asphalt, puddles reflecting the sky, a light wind.', source: 'manual', locked: true } },
    refs: [{ key: 'loc', label: 'Место', kind: 'location', file: null, flags: { hasPeople: false, hasText: false, studioBackdrop: false } }],
    lines: [{ id: 'L1', speakerKey: null, ru: 'Привет.', proofread: true }],
    shots: base.shots.map((s) => ({
      ...s,
      panel: ['loc'],
      locationRefs: ['loc'],
      // Отрезок защищён ручной правкой — фиксер всё равно вправе ПРЕДЛОЖИТЬ правку.
      segments: [{ id: 'seg-1', titleRu: '', beatsRu: '', text: { ru: '', en: 'The operator rides in the cargo bed. He {{line:L1}}', source: 'manual' as const, locked: true } }],
      attempts: [{ n: 1, createdAt: '2026-09-21T00:00:00.000Z', prompt: '…', panel: [], segments: [], kitId: s.kitId, verdict: 'rejected' as const, workedRu: 'Локация та.', failedRu: 'В кадре руки оператора.', symptomIds: ['operator-visible', 'wrong-clothes'], readbackRu: '' }],
    })),
  };

  it('в запрос уходят инструкции выбранных симптомов и текущий текст; ответ не применяется сам', async () => {
    const calls: LlmRequest[] = [];
    const app = createApp({
      rootDir: ROOT,
      dataDir: mkdtempSync(path.join(tmpdir(), 'sp-fix-')),
      runLlm: async <T>(request: LlmRequest) => {
        calls.push(request);
        return { data: { blocks: [{ segmentId: 'seg-1', en: 'The camera is inside the cargo bed of a second truck. No camera, no hands, no operator visible in frame. A cloud passes, the light shifts for two seconds, then returns. He {{line:L1}}', notesRu: 'Точка съёмки вне тела.' }] } as T, meta: { durationMs: 5, model: 'mock', turns: 2, inputTokens: 1, outputTokens: 1 } };
      },
    });
    const res = await app.request('/api/llm/fix', { method: 'POST', headers, body: JSON.stringify({ project, shotId: 'shot-1', attemptN: 1 }) });
    expect(res.status).toBe(200);
    const user = calls[0]?.user ?? '';
    expect(user).toContain('Apply three layers of defence');
    expect(user).toContain('В кадре руки оператора.');
    expect(user).toContain('"currentText": "The operator rides in the cargo bed. He {{line:L1}}"');
    // «Не та одежда» текстом не чинится — агенту эта строка не отправляется.
    expect(user).not.toContain('не та одежда');
    const body = (await res.json()) as { blocks: { en: string }[] };
    expect(body.blocks[0]?.en).toContain('No camera, no hands');
  });

  it('без симптомов и описания чинить нечего — LLM не вызывается', async () => {
    const empty: Project = { ...project, shots: project.shots.map((s) => ({ ...s, attempts: s.attempts.map((a) => ({ ...a, symptomIds: [], failedRu: '' })) })) };
    const app = createApp({ rootDir: ROOT, dataDir: mkdtempSync(path.join(tmpdir(), 'sp-fix-')), runLlm: async () => Promise.reject(new Error('не должен вызываться')) });
    expect((await app.request('/api/llm/fix', { method: 'POST', headers, body: JSON.stringify({ project: empty, shotId: 'shot-1', attemptN: 1 }) })).status).toBe(422);
  });
});
