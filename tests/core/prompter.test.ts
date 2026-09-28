import { describe, expect, it } from 'vitest';
import { findModel, modelsOf, type GenModel } from '../../src/core/gen/models.ts';
import { agentParams, buildPrompterUser, cardFile, normalizePrompter, validatePrompter, type PrompterOutput } from '../../src/core/llm/buildPrompter.ts';

const soul = findModel('higgsfield/soul-2') as GenModel;
const gpt = findModel('kie/gpt-image-2-5') as GenModel;
const images = modelsOf('image');
const styles = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Old smartphone' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Subtle flash' },
];

const answer = (patch: Partial<PrompterOutput> = {}): PrompterOutput => ({
  modelId: 'higgsfield/soul-2',
  reasonRu: 'Лицо крупно, нужен редакционный вид — это Soul 2.',
  prompt: 'Night rooftop, candid phone-flash snapshot. A young man in a black puffer jacket leans on the railing, city lights blurred behind.',
  params: [
    { key: 'aspectRatio', value: '9:16' },
    { key: 'resolution', value: '1080p' },
  ],
  styleName: 'old smartphone',
  weakSpotsRu: ['Надпись на куртке Soul 2 испортит — добавь её потом правкой GPT Image 2.5.'],
  alternativesRu: '',
  ...patch,
});

describe('промптер: вход агента', () => {
  it('агент выбирает только свои параметры: seed, Soul ID и улучшение промпта остаются владельцу', () => {
    expect(agentParams(soul).map((d) => d.key)).toEqual(['resolution', 'aspectRatio']);
    expect(agentParams(gpt).map((d) => d.key)).toEqual(['variant', 'resolution', 'aspectRatio', 'background']);
  });

  it('в запросе — кандидаты с вариантами параметров и имена мудбордов; режим auto/fixed', () => {
    const user = buildPrompterUser({ ideaRu: ' я на крыше ночью ', kind: 'image', modelId: 'auto' }, images, styles);
    const input = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1)) as { ideaRu: string; mode: string; candidates: { id: string; params: { key: string }[]; moodboards: boolean }[]; styleOptions: string[] };
    expect(input.ideaRu).toBe('я на крыше ночью');
    expect(input.mode).toBe('auto');
    expect(input.candidates.map((c) => c.id)).toEqual(images.map((m) => m.id));
    expect(input.candidates.find((c) => c.id === soul.id)?.params.map((p) => p.key)).toEqual(['resolution', 'aspectRatio']);
    expect(input.candidates.find((c) => c.id === soul.id)?.moodboards).toBe(true);
    expect(input.styleOptions).toEqual(['Old smartphone', 'Subtle flash']);

    const fixed = buildPrompterUser({ ideaRu: 'постер', kind: 'image', modelId: gpt.id }, [gpt], styles);
    expect(fixed).toContain('"mode": "fixed"');
    expect(fixed).toContain('"styleOptions": []');
  });

  it('переписывание несёт прошлый промпт и комментарий', () => {
    const user = buildPrompterUser({ ideaRu: 'постер', kind: 'image', modelId: 'auto', commentRu: 'шире', previous: { modelId: gpt.id, prompt: 'A poster.', params: {}, styleName: '' } }, images, styles);
    expect(user).toMatch(/^Rewrite the previous prompt/);
    expect(user).toContain('"commentRu": "шире"');
  });

  it('карточка модели — файл по id', () => {
    expect(cardFile('kie/gpt-image-2-5')).toBe('kie--gpt-image-2-5.md');
  });
});

describe('промптер: проверка и нормализация ответа', () => {
  it('хороший ответ проходит; мудборд по имени без учёта регистра → id; параметры в типах модели', () => {
    expect(validatePrompter(answer(), images, styles)).toEqual([]);
    const result = normalizePrompter(answer(), styles);
    expect(result?.params).toMatchObject({ aspectRatio: '9:16', resolution: '1080p', styleId: styles[0]?.id, seed: 0, soulId: '' });
    expect(result?.styleName).toBe('Old smartphone');
  });

  it('модель не из кандидатов — ошибка со списком разрешённых', () => {
    expect(validatePrompter(answer({ modelId: 'kie/nano-banana' }), images, styles)[0]).toContain('higgsfield/soul-2');
    expect(normalizePrompter(answer({ modelId: 'kie/nano-banana' }), styles)).toBeNull();
  });

  it('кириллица в промпте — только в кавычках (текст в кадре)', () => {
    expect(validatePrompter(answer({ modelId: gpt.id, params: [], styleName: '', prompt: 'A poster with the headline "Привет, студия" in bold sans.' }), images, styles)).toEqual([]);
    expect(validatePrompter(answer({ modelId: gpt.id, params: [], styleName: '', prompt: 'A poster with the headline «Привет» in bold sans.' }), images, styles)).toEqual([]);
    expect(validatePrompter(answer({ prompt: 'Ночная крыша, flash photo.' }), images, styles).join(' ')).toContain('English only');
  });

  it('ссылки на картинки без картинок, чужие параметры, неверные значения и мудборд у модели без мудбордов', () => {
    const problems = validatePrompter(
      answer({ modelId: gpt.id, prompt: 'Keep the face from image 1.', params: [{ key: 'seed', value: '5' }, { key: 'resolution', value: '8K' }], styleName: 'Subtle flash' }),
      images,
      styles,
    ).join('\n');
    expect(problems).toContain('no images are attached');
    expect(problems).toContain('"seed" is not a parameter');
    expect(problems).toContain('"8K" is not allowed (options: 1K, 2K, 4K)');
    expect(problems).toContain('has no moodboards');
  });

  it('Soul 2: отрицание в промпте — на ремонт (negative prompt у Soul нет); у GPT Image 2.5 «No extra text» по гайду', () => {
    expect(validatePrompter(answer({ prompt: 'Night rooftop close-up, blurred city lights behind, no buildings visible.' }), images, styles).join(' ')).toContain('"no buildings"');
    expect(validatePrompter(answer({ modelId: gpt.id, params: [], styleName: '', prompt: 'A poster. No extra text, no watermarks.' }), images, styles)).toEqual([]);
  });

  it('длинный промпт Soul 2 и мудборд не из списка — на ремонт', () => {
    const problems = validatePrompter(answer({ prompt: Array.from({ length: 230 }, () => 'word').join(' '), styleName: 'Night T' }), images, styles).join('\n');
    expect(problems).toContain('keep it under 200 words');
    expect(problems).toContain('"Night T" is not in styleOptions');
  });

  it('видео: длительность строкой («8», «8s») приводится к числу, звук — к bool', () => {
    const video = modelsOf('video');
    const out = answer({ modelId: 'kie/seedance-2-5', styleName: '', params: [{ key: 'durationSec', value: '8s' }, { key: 'audio', value: 'false' }, { key: 'resolution', value: '720p' }] });
    expect(validatePrompter(out, video, [])).toEqual([]);
    expect(normalizePrompter(out, [])?.params).toMatchObject({ durationSec: 8, audio: false, resolution: '720p' });
  });
});
