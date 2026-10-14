import { describe, expect, it } from 'vitest';
import { estimate, findModel, formatCost, forProvider, GEN_MODELS, modelsOf, paramsFor, resolveSeeds, validateGen, type GenModel, type SentRef } from '../../src/core/gen/models.ts';

const model = (id: string): GenModel => {
  const found = findModel(id);
  if (found === undefined) throw new Error(`нет модели ${id}`);
  return found;
};
const seedance = model('kie/seedance-2-5');
const kling = model('kie/kling-3');
const gpt = model('kie/gpt-image-2-5');
const seedream = model('kie/seedream-5-pro');
const soul = model('higgsfield/soul-2');
const defaults = (m: GenModel) => paramsFor(m, {});

describe('каталог: набор владельца 27.09', () => {
  it('картинки — Soul 2, GPT Image 2.5, Seedream 5 Pro; видео — Kling 3.0, Seedance 2.5', () => {
    expect(modelsOf('image').map((m) => m.titleRu)).toEqual(['Soul 2', 'GPT Image 2.5', 'Seedream 5 Pro']);
    expect(modelsOf('video').map((m) => m.titleRu)).toEqual(['Kling 3.0', 'Seedance 2.5']);
  });

  it('у каждой модели значения по умолчанию проходят её же проверку', () => {
    // Инструменты (апскейл): без промпта и с обязательной картинкой — умолчания проверяются в их условиях.
    for (const m of GEN_MODELS) expect(validateGen(m, m.promptless === true ? '' : 'A test prompt.', defaults(m), Array.from({ length: m.refs.min ?? 0 }, () => 'ref' as const)), m.id).toEqual([]);
  });

  it('смена модели: общие параметры переживают, чужие — на умолчания', () => {
    expect(paramsFor(kling, { aspectRatio: '16:9', durationSec: 10, resolution: '1080p' })).toEqual({ mode: 'std', aspectRatio: '16:9', durationSec: 10, audio: false });
    expect(paramsFor(kling, { aspectRatio: '21:9', durationSec: 30 })).toMatchObject({ aspectRatio: '9:16', durationSec: 5 });
  });
});

describe('цена по прайсу 27.09.2026', () => {
  it('Seedance 2.5 — кредиты в секунду по разрешению', () => {
    expect(estimate(seedance, paramsFor(seedance, { resolution: '720p', durationSec: 5 }))).toEqual({ credits: 315, usd: 1.575, unitRu: 'кр' });
    expect(estimate(seedance, paramsFor(seedance, { resolution: '480p', durationSec: 4 })).credits).toBe(112);
  });

  it('Kling 3.0 — режим × звук × секунды', () => {
    expect(estimate(kling, paramsFor(kling, { mode: 'std', durationSec: 5 })).credits).toBe(70);
    expect(estimate(kling, paramsFor(kling, { mode: 'pro', durationSec: 5, audio: true })).credits).toBe(135);
    expect(estimate(kling, paramsFor(kling, { mode: '4K', durationSec: 10, audio: true })).credits).toBe(670);
  });

  it('GPT Image 2.5 — за картинку по разрешению, count умножает', () => {
    expect(estimate(gpt, paramsFor(gpt, { resolution: '2K' }), 2)).toEqual({ credits: 20, usd: 0.1, unitRu: 'кр' });
  });

  it('Seedream 5 Pro — каждая входная картинка после первой +0.5 кр', () => {
    expect(estimate(seedream, paramsFor(seedream, { resolution: '2K' }), 1, 10).credits).toBe(18.5);
    expect(estimate(seedream, paramsFor(seedream, { resolution: '1K' }), 1, 1).credits).toBe(7);
  });

  it('Soul 2 — в долларах Higgsfield API', () => {
    const e = estimate(soul, paramsFor(soul, { resolution: '720p' }), 3);
    expect(e).toEqual({ credits: 0.012, usd: 0.012, unitRu: '$' });
    expect(formatCost(e)).toBe('$0.012');
    expect(formatCost(estimate(gpt, defaults(gpt)))).toBe('6 кр ≈ $0.03');
  });
});

describe('тело запроса и id модели', () => {
  const ref = (url: string, role: SentRef['role'] = 'ref'): SentRef => ({ url, role });

  it('GPT Image 2.5: вариант и наличие картинок выбирают model id', () => {
    const p = paramsFor(gpt, { variant: 'sunburst' });
    expect(gpt.target(p, [])).toBe('gpt-image-2-5-sunburst-text-to-image');
    expect(gpt.target(defaults(gpt), ['ref'])).toBe('gpt-image-2-5-flare-image-to-image');
    expect(gpt.input('x', defaults(gpt), [ref('https://a')])).toEqual({ prompt: 'x', aspect_ratio: '9:16', resolution: '1K', background: 'auto', input_urls: ['https://a'] });
  });

  it('Seedream 5 Pro: разрешение → quality basic / high, картинки → image_urls', () => {
    expect(seedream.target(defaults(seedream), [])).toBe('seedream/5-pro-text-to-image');
    expect(seedream.input('x', paramsFor(seedream, { resolution: '1K' }), [ref('https://a')])).toMatchObject({ quality: 'basic', image_urls: ['https://a'] });
  });

  it('Kling 3.0: старт и финал → image_urls по порядку, duration строкой, mode/sound явно', () => {
    expect(kling.input('x', paramsFor(kling, { durationSec: 7, audio: true }), [ref('https://end', 'end'), ref('https://start', 'start')])).toEqual({
      prompt: 'x',
      mode: 'std',
      aspect_ratio: '9:16',
      duration: '7',
      sound: true,
      multi_shots: false,
      image_urls: ['https://start', 'https://end'],
    });
  });

  it('Seedance 2.5: кадры → first/last_frame_url, референсы → reference_image_urls', () => {
    expect(seedance.input('x', defaults(seedance), [ref('https://s', 'start'), ref('https://e', 'end')])).toMatchObject({ first_frame_url: 'https://s', last_frame_url: 'https://e' });
    expect(seedance.input('x', defaults(seedance), [ref('https://r')])).toMatchObject({ reference_image_urls: ['https://r'] });
  });

  it('Soul 2: Soul ID со strength, seed не передаётся, умолчания явно', () => {
    const id = '3db34ab5-3439-4317-9e03-08dc30852e69';
    expect(soul.input('x', paramsFor(soul, { soulId: id }), [])).toEqual({ prompt: 'x', aspect_ratio: '9:16', resolution: '1080p', enhance_prompt: false, batch_size: 1, custom_reference_id: id, custom_reference_strength: 1 });
    expect(soul.input('x', defaults(soul), [])).not.toHaveProperty('custom_reference_id');
    expect(validateGen(soul, 'x', paramsFor(soul, { soulId: 'matthew' }), []).join(' ')).toContain('Soul ID: неверный формат');
  });
});

describe('ссылки на референсы в диалекте провайдера (решение 23)', () => {
  it('<<<image_N>>> и @Image N → @ImageN для Seedance; «image N» для остальных', () => {
    expect(forProvider(seedance, 'Man <<<image_1>>> meets @Image 2 near @image_3.')).toEqual({ prompt: 'Man @Image1 meets @Image2 near @Image3.', maxRef: 3 });
    expect(forProvider(gpt, 'Put @Image1 on @Image 2').prompt).toBe('Put image 1 on image 2');
  });

  it('ссылка на номер больше числа рефов у Seedance — отказ до отправки', () => {
    expect(validateGen(seedance, 'Hero <<<image_2>>> walks.', defaults(seedance), ['ref']).join(' ')).toContain('ссылка на картинку 2');
  });
});

describe('проверки ролей и параметров', () => {
  it('Seedance: кадры и референсы не смешиваются; финал без старта нельзя', () => {
    expect(validateGen(seedance, 'x', defaults(seedance), ['start', 'ref']).join(' ')).toContain('нельзя смешивать');
    expect(validateGen(seedance, 'x', defaults(seedance), ['end']).join(' ')).toContain('без стартового');
  });

  it('Kling не принимает референсы, Soul 2 принимает только один reference', () => {
    expect(validateGen(kling, 'x', defaults(kling), ['ref']).join(' ')).toContain('«Реф» не поддерживается');
    expect(validateGen(soul, 'x', defaults(soul), ['ref'])).toEqual([]);
    expect(validateGen(soul, 'x', defaults(soul), ['ref', 'ref'])).not.toEqual([]);
    expect(validateGen(soul, 'x', defaults(soul), ['start'])).not.toEqual([]);
  });

  it('длительность, разрешение, формат, пустой промпт', () => {
    const bad = validateGen(seedance, '  ', { resolution: '4K', aspectRatio: '2:3', durationSec: 31, audio: true }, []);
    expect(bad).toHaveLength(4);
    expect(validateGen(seedance, 'ok', { ...defaults(seedance), durationSec: 4.5 }, [])).toHaveLength(1);
  });
});

describe('Soul 2: seed и мудборд (решение 27)', () => {
  const STYLE = '7ee16ff3-c0b0-4f5f-a0e1-e7fc46144230';

  it('seed 0 — случайный на каждую задачу; фиксированный — seed, seed+1, …, с переносом через максимум', () => {
    const rnd = [111, 222, 333];
    let i = 0;
    const random = () => rnd[i++] ?? 1;
    expect(resolveSeeds(soul, defaults(soul), 3, random).map((p) => p.seed)).toEqual([111, 222, 333]);
    expect(resolveSeeds(soul, paramsFor(soul, { seed: 500 }), 3, random).map((p) => p.seed)).toEqual([500, 501, 502]);
    expect(resolveSeeds(soul, paramsFor(soul, { seed: 1_000_000 }), 2, random).map((p) => p.seed)).toEqual([1_000_000, 1]);
    expect(resolveSeeds(gpt, defaults(gpt), 2, random)).toEqual([defaults(gpt), defaults(gpt)]);
  });

  it('в тело уходят seed и style_id; 0 и пустой стиль не отправляются', () => {
    expect(soul.input('x', paramsFor(soul, { seed: 42, styleId: STYLE }), [])).toMatchObject({ seed: 42, style_id: STYLE });
    const plain = soul.input('x', defaults(soul), []);
    expect(plain).not.toHaveProperty('seed');
    expect(plain).not.toHaveProperty('style_id');
  });

  it('проверки: seed — целое 0…1 000 000, мудборд — UUID', () => {
    expect(paramsFor(soul, { seed: -5 }).seed).toBe(0);
    expect(validateGen(soul, 'x', { ...defaults(soul), seed: 2_000_000 }, []).join(' ')).toContain('Seed — целое число');
    expect(validateGen(soul, 'x', { ...defaults(soul), styleId: 'retro' }, []).join(' ')).toContain('Мудборд: неверный формат');
    expect(validateGen(soul, 'x', { ...defaults(soul), styleId: STYLE, seed: 7 }, [])).toEqual([]);
  });
});
