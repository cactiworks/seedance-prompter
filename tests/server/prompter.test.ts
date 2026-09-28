import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PrompterOutput, PrompterResult } from '../../src/core/llm/buildPrompter.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import type { GenProvider } from '../../src/server/gen/provider.ts';
import { createGenRuntime } from '../../src/server/gen/runtime.ts';
import type { LlmRequest } from '../../src/server/llm/claudeCli/provider.ts';

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

  it('пустая идея и чужая модель — отказ без вызова агента', async () => {
    const { calls, post } = setup([]);
    expect((await post({ ideaRu: '  ', kind: 'image' })).status).toBe(422);
    expect((await post({ ideaRu: 'постер', kind: 'image', modelId: 'kie/kling-3' })).status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});
