import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { choiceParams, fillFix, fixParams, validateFixPack, type FixPack } from '../../src/core/gen/fixes.ts';
import { estimate, findModel, modelsOf, paramsFor, validateGen, type GenModel } from '../../src/core/gen/models.ts';

const pack = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../packs/prompter/fixes.json'), 'utf8')) as FixPack;
const recipe = (id: string) => pack.recipes.find((r) => r.id === id) ?? pack.recipes[0]!;

describe('рецепты починки', () => {
  it('набор цел: модели есть и принимают картинки, параметры валидны, плейсхолдеры — поля рецепта', () => {
    expect(validateFixPack(pack)).toEqual([]);
    expect(pack.recipes.map((r) => `${r.group}:${r.id}`)).toEqual(['fix:text', 'fix:face', 'fix:hands', 'fix:count', 'fix:skin', 'fix:physics', 'fix:detail', 'tool:bg', 'tool:expand', 'tool:relight', 'tool:upscale']);
  });

  it('текст подставляется буква в букву в кавычках, внешние кавычки владельца снимаются; пустое обязательное — сообщение', () => {
    const filled = fillFix(recipe('text'), { text: '«Привет,  студия»' });
    expect(filled.problems).toEqual([]);
    expect(filled.prompt).toContain('reads exactly "Привет, студия"');
    expect(fillFix(recipe('text'), {}).problems).toEqual(['Заполни «Какой должен быть текст».']);
  });

  it('пустое необязательное поле — строка с ним выбрасывается целиком; заполненное — остаётся', () => {
    expect(fillFix(recipe('hands'), {}).prompt).not.toContain('Owner');
    expect(fillFix(recipe('hands'), { note: 'держит кружку' }).prompt).toMatch(/Owner's note in Russian — follow it: держит кружку$/);
  });

  it('параметры правки: формат исходника сохраняется, вариант — из рецепта, чужие ключи Soul 2 отбрасываются', () => {
    const gpt = findModel('kie/gpt-image-2-5') as GenModel;
    const params = fixParams(gpt, { aspectRatio: '3:4', resolution: '1080p', styleId: 'x', seed: 5 }, { variant: 'sunburst' });
    expect(params).toEqual({ variant: 'sunburst', resolution: '1K', aspectRatio: '3:4', background: 'auto' });
  });
});

describe('инструменты правки', () => {
  it('выбор варианта: значение — в промпт, параметры — поверх модели; по умолчанию первый вариант', () => {
    const expand = recipe('expand');
    expect(fillFix(expand, {}).prompt).toContain('to a 16:9 frame');
    expect(choiceParams(expand, { aspect: '9:16' })).toEqual({ aspectRatio: '9:16' });
    const relight = recipe('relight');
    expect(fillFix(relight, { light: relight.fields[0]?.options?.[2]?.value ?? '' }).prompt).toContain('neon');
  });

  it('апскейл Topaz: цена по длинной стороне результата, больше 8K — нельзя, без картинки — нельзя, промпт не нужен', () => {
    const topaz = findModel('kie/topaz-upscale') as GenModel;
    const price = (sourceSize: number, upscaleFactor: string) => estimate(topaz, paramsFor(topaz, { sourceSize, upscaleFactor })).credits;
    expect(price(1024, '2')).toBe(10);
    expect(price(1448, '2')).toBe(20);
    expect(price(2048, '4')).toBe(40);
    expect(validateGen(topaz, '', paramsFor(topaz, { sourceSize: 4096, upscaleFactor: '4' }), ['ref']).join(' ')).toContain('больше 8K');
    expect(validateGen(topaz, '', paramsFor(topaz, { sourceSize: 1024, upscaleFactor: '2' }), [])).toEqual(['Topaz Upscale нужна входная картинка.']);
    expect(validateGen(topaz, '', paramsFor(topaz, { sourceSize: 1024, upscaleFactor: '2' }), ['ref'])).toEqual([]);
    expect(topaz.input('', paramsFor(topaz, { upscaleFactor: '4' }), [{ url: 'https://x/a.png', role: 'ref' }])).toEqual({ image_url: 'https://x/a.png', upscale_factor: '4' });
  });

  it('инструменты не попадают в выбор моделей студии и промптера', () => {
    expect(modelsOf('image').map((m) => m.id)).not.toContain('kie/topaz-upscale');
  });
});
