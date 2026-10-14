import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PrompterOutput, PrompterResult } from '../../src/core/llm/buildPrompter.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import type { GenProvider } from '../../src/server/gen/provider.ts';
import { createGenRuntime } from '../../src/server/gen/runtime.ts';
import type { LlmRequest } from '../../src/server/llm/codexCli/provider.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };
const STYLE_ID = '33333333-3333-4333-8333-333333333333';

const unused = async (): Promise<never> => Promise.reject(new Error('генерация промптером не запускается'));

function setup(answers: PrompterOutput[]) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-prompter-'));
  const higgsfield: GenProvider = { id: 'higgsfield', hasKey: () => true, upload: unused, submit: unused, poll: unused, freshUrl: unused, listStyles: async () => [{ id: STYLE_ID, name: 'Subtle flash', description: '', previewUrl: null }] };
  const gen = createGenRuntime({ dataDir, providers: { higgsfield } });
  const calls: LlmRequest[] = [];
  const app = createApp({
    rootDir: ROOT,
    dataDir,
    gen,
    runLlm: async <T>(request: LlmRequest) => {
      calls.push(request);
      return { data: answers[calls.length - 1] as T, meta: { durationMs: 5, model: 'mock', turns: 2, inputTokens: 10, outputTokens: 10 } };
    },
  });
  const post = (body: unknown) => app.request('/api/llm/prompter', { method: 'POST', headers, body: JSON.stringify(body) });
  return { calls, post };
}

const good: PrompterOutput = {
  modelId: 'higgsfield/soul-2',
  reasonRu: 'Крупный план и вспышка — сильная сторона Soul 2.',
  prompt: 'Flash party snapshot at night. A young man laughing, close-up, sweat on skin, crowd lights behind.',
  params: [{ key: 'aspectRatio', value: '9:16' }],
  styleName: 'Subtle flash',
  weakSpotsRu: [],
  alternativesRu: 'GPT Image 2.5 — если нужна надпись в кадре.',
};

describe('POST /api/llm/prompter', () => {
  it.each([
    { common: undefined, role: undefined, expected: 'gpt-6-astra' },
    { common: 'gpt-shared-test', role: undefined, expected: 'gpt-shared-test' },
    { common: 'gpt-shared-test', role: 'gpt-role-test', expected: 'gpt-role-test' },
  ])('выбор LLM: роль $role, общий $common → $expected; медиа остаётся в Higgsfield', async ({ common, role, expected }) => {
    vi.stubEnv('SP_LLM_MODEL', common);
    vi.stubEnv('SP_PROMPTER_MODEL', role);
    try {
      const { calls, post } = setup([good]);
      const response = await post({ ideaRu: 'фото со вспышкой', kind: 'image', modelId: 'auto' });
      expect(response.status).toBe(200);
      expect(calls[0]?.model).toBe(expected);
      expect(calls[0]).not.toHaveProperty('fallbackModel');
      expect(((await response.json()) as { result: PrompterResult }).result.modelId).toBe('higgsfield/soul-2');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('системный промпт = правила + маршрутизация + карточки кандидатов; плохой ответ уходит на ремонт', async () => {
    const { calls, post } = setup([{ ...good, prompt: 'Ночная вечеринка со вспышкой.' }, good]);
    const res = await post({ ideaRu: 'я смеюсь на вечеринке, фото со вспышкой', kind: 'image', modelId: 'auto' });
    const body = (await res.json()) as { result: PrompterResult; problems: string[] };

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.system).toContain('prompt writer');
    expect(calls[0]?.system).toContain('# Routing');
    expect(calls[0]?.system).toContain('Soul 2 (Higgsfield, official API) — card');
    expect(calls[0]?.system).toContain('GPT Image 2.5 (OpenAI, via KIE) — card');
    expect(calls[0]?.system).not.toContain('Kling 3.0 (Kuaishou, via KIE) — card');
    expect(calls[0]?.user).toContain('"Subtle flash"');
    expect(calls[1]?.user).toContain('English only');
    expect(body.problems).toEqual([]);
    expect(body.result.modelId).toBe('higgsfield/soul-2');
    expect(body.result.params).toMatchObject({ aspectRatio: '9:16', resolution: '1080p', styleId: STYLE_ID });
  });

  it('модель выбрана владельцем — в системе только её карточка, агенту — режим fixed', async () => {
    const { calls, post } = setup([{ ...good, modelId: 'kie/kling-3', styleName: '', params: [{ key: 'durationSec', value: '5' }] }]);
    const res = await post({ ideaRu: 'оживи кадр: волосы на ветру', kind: 'video', modelId: 'kie/kling-3' });
    expect(res.status).toBe(200);
    expect(calls[0]?.system).toContain('Kling 3.0 (Kuaishou, via KIE) — card');
    expect(calls[0]?.system).not.toContain('Seedance 2.5 (ByteDance, via KIE) — card');
    expect(calls[0]?.user).toContain('"mode": "fixed"');
    expect(calls[0]?.user).toContain('"styleOptions": []');
  });

  it('референсы: картинки уходят агенту вложениями, комплект камеры раскрыт из pack «Кадров», в ответе — какие картинки идут в модель', async () => {
    const answer: PrompterOutput = { ...good, modelId: 'kie/gpt-image-2-5', styleName: '', params: [], prompt: 'Shot on a Sony Handycam. Keep the face and identity of the person in image 1; apply the light of image 2 — not its subject.' };
    const { calls, post } = setup([answer]);
    const image = { mediaType: 'image/jpeg', base64: Buffer.from('jpeg').toString('base64') };
    const res = await post({
      ideaRu: 'я на крыше ночью',
      kind: 'image',
      modelId: 'auto',
      refs: [
        { role: 'character', commentRu: 'это я' },
        { role: 'style', commentRu: 'свет' },
      ],
      images: [image, image],
      shot: { aspectRatio: '', cameraKitId: 'camcorder-sony-minidv', cameraRu: '', placeRu: '', lightRu: '', textRu: '' },
    });
    const body = (await res.json()) as { result: PrompterResult; problems: string[] };
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.images).toHaveLength(2);
    expect(calls[0]?.user).toContain('"commentRu": "это я"');
    expect(calls[0]?.user).toContain('Sony Handycam');
    expect(body.problems).toEqual([]);
    expect(body.result.refs).toEqual([
      { index: 0, role: 'ref' },
      { index: 1, role: 'ref' },
    ]);
  });

  it('пустая идея, чужая модель, картинок не столько, сколько ролей, кадр видео у картинки, неизвестная камера — отказ без агента', async () => {
    const { calls, post } = setup([]);
    const image = { mediaType: 'image/jpeg', base64: 'eA==' };
    expect((await post({ ideaRu: '  ', kind: 'image' })).status).toBe(422);
    expect((await post({ ideaRu: 'постер', kind: 'image', modelId: 'kie/kling-3' })).status).toBe(422);
    expect((await post({ ideaRu: 'постер', kind: 'image', refs: [{ role: 'style', commentRu: '' }], images: [] })).status).toBe(422);
    expect((await post({ ideaRu: 'постер', kind: 'image', refs: [{ role: 'start', commentRu: '' }], images: [image] })).status).toBe(422);
    expect((await post({ ideaRu: 'постер', kind: 'image', shot: { cameraKitId: 'polaroid' } })).status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});

describe('шаблоны и свои мудборды', () => {
  it('шаблон из pack уходит агенту; неизвестный — отказ', async () => {
    const answer: PrompterOutput = { ...good, modelId: 'kie/seedream-5-pro', styleName: '', params: [], prompt: 'A character reference sheet: full-body front, three-quarter, side profile and back views, plus close-up portraits.' };
    const { calls, post } = setup([answer]);
    expect((await post({ ideaRu: 'я в худи', kind: 'image', template: 'character-sheet' })).status).toBe(200);
    expect(calls[0]?.user).toContain('Character reference sheet.');
    expect((await post({ ideaRu: 'я', kind: 'image', template: 'nope' })).status).toBe(422);
  });

  it('мудборд: создать из картинок, список, удалить; без имени или картинок — отказ', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-mood-'));
    const app = createApp({ rootDir: ROOT, dataDir, gen: createGenRuntime({ dataDir, providers: {} }) });
    const send = (method: string, url: string, body?: unknown) => app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const images = [{ label: 'кадр', source: { type: 'upload', uploadId: 'u-abc123def' } }];
    expect((await send('POST', '/api/moodboards', { name: '', images })).status).toBe(422);
    expect((await send('POST', '/api/moodboards', { name: 'Night T', images: [] })).status).toBe(422);
    const created = (await (await send('POST', '/api/moodboards', { name: 'Night T', images })).json()) as { id: string; name: string }[];
    expect(created.map((m) => m.name)).toEqual(['Night T']);
    expect(((await (await send('GET', '/api/moodboards')).json()) as unknown[]).length).toBe(1);
    expect((await (await send('DELETE', `/api/moodboards/${created[0]?.id ?? ''}`)).json()) as unknown[]).toEqual([]);
  });
});

describe('POST /api/llm/region-edit', () => {
  it('русская инструкция → агент-переводчик → промпт с рамками; английская — без агента; без рамок — отказ', async () => {
    const calls: LlmRequest[] = [];
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-region-'));
    const app = createApp({
      rootDir: ROOT,
      dataDir,
      gen: createGenRuntime({ dataDir, providers: {} }),
      runLlm: async <T>(request: LlmRequest) => {
        calls.push(request);
        return { data: { instructionEn: 'Replace the mug with a glass of orange juice.' } as T, meta: { durationMs: 5, model: 'mock', turns: 1, inputTokens: 1, outputTokens: 1 } };
      },
    });
    const post = (body: unknown) => app.request('/api/llm/region-edit', { method: 'POST', headers, body: JSON.stringify(body) });
    const box = { x1: 100, y1: 200, x2: 300, y2: 400 };
    const ru = (await (await post({ instructionRu: 'замени кружку на стакан сока', boxes: [box] })).json()) as { prompt: string };
    expect(calls).toHaveLength(1);
    expect(calls[0]?.user).toContain('замени кружку на стакан сока');
    expect(ru.prompt).toContain('Image 1 <bbox>100 200 300 400</bbox>: Replace the mug with a glass of orange juice.');
    const en = (await (await post({ instructionRu: 'remove the mug', boxes: [box] })).json()) as { prompt: string };
    expect(calls).toHaveLength(1);
    expect(en.prompt).toContain(': remove the mug.');
    expect((await post({ instructionRu: 'убери', boxes: [] })).status).toBe(422);
    expect((await post({ instructionRu: 'убери', boxes: [{ x1: 500, y1: 0, x2: 100, y2: 10 }] })).status).toBe(422);
  });
});

describe('журнал калибровки', () => {
  it('оценка — только на файл из библиотеки; правило попадает в карточку модели у промптера', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-journal-'));
    const calls: LlmRequest[] = [];
    const app = createApp({
      rootDir: ROOT,
      dataDir,
      gen: createGenRuntime({ dataDir, providers: {} }),
      runLlm: async <T>(request: LlmRequest) => {
        calls.push(request);
        return { data: { ...good, styleName: '' } as T, meta: { durationMs: 5, model: 'mock', turns: 1, inputTokens: 1, outputTokens: 1 } };
      },
    });
    const send = (method: string, url: string, body?: unknown) => app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await send('PUT', '/api/verdicts/m-nope', { verdict: 'bad', symptoms: ['text'] })).status).toBe(404);
    expect((await send('POST', '/api/learnings', { modelId: 'kie/nope', textRu: 'правило' })).status).toBe(422);
    expect((await send('POST', '/api/learnings', { modelId: 'higgsfield/soul-2', textRu: 'Надписи в Soul 2 ломаются — делать правкой GPT Image 2.5.', evidence: ['a'] })).status).toBe(201);
    await send('POST', '/api/llm/prompter', { ideaRu: 'я на крыше', kind: 'image', modelId: 'higgsfield/soul-2' });
    expect(calls[0]?.system).toContain('Надписи в Soul 2 ломаются');
    expect(((await (await send('GET', '/api/calibration')).json()) as { suites: unknown[] }).suites.length).toBe(3);
  });
});
