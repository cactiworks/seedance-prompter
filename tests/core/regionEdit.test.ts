import { describe, expect, it } from 'vitest';
import { boxToken, buildRegionPrompt, maskToBoxes, mergeBoxes, regionProblems, type MaskGrid } from '../../src/core/gen/regionEdit.ts';
import { needsTranslation, validateEditInstruction } from '../../src/core/llm/buildEditInstruction.ts';

/** Маска из прямоугольников в клетках сетки. */
function grid(width: number, height: number, rects: [number, number, number, number][]): MaskGrid {
  const cells = new Uint8Array(width * height);
  for (const [x1, y1, x2, y2] of rects) for (let y = y1; y < y2; y += 1) for (let x = x1; x < x2; x += 1) cells[y * width + x] = 1;
  return { width, height, cells };
}

describe('правка кистью: маска → рамки Seedream', () => {
  it('пятно → рамка в координатах 0…999 от левого верхнего угла, по пропорциям сетки', () => {
    expect(maskToBoxes(grid(100, 50, [[10, 5, 30, 25]]))).toEqual([{ x1: 100, y1: 100, x2: 300, y2: 500 }]);
    expect(boxToken({ x1: 100, y1: 100, x2: 300, y2: 500 })).toBe('Image 1 <bbox>100 100 300 500</bbox>');
  });

  it('два далёких пятна — две рамки сверху вниз; соседние склеиваются; случайный тычок — мимо', () => {
    const far = maskToBoxes(grid(100, 100, [[60, 60, 80, 80], [5, 5, 20, 20], [50, 5, 51, 6]]));
    expect(far).toEqual([
      { x1: 50, y1: 50, x2: 200, y2: 200 },
      { x1: 600, y1: 600, x2: 800, y2: 800 },
    ]);
    expect(maskToBoxes(grid(100, 100, [[10, 10, 20, 20], [21, 10, 30, 20]]))).toEqual([{ x1: 100, y1: 100, x2: 300, y2: 200 }]);
    expect(mergeBoxes([{ x1: 0, y1: 0, x2: 100, y2: 100 }, { x1: 500, y1: 500, x2: 600, y2: 600 }], 20)).toHaveLength(2);
  });

  it('промпт по формулам гайда ByteDance: рамки + инструкция + что сохранить', () => {
    const prompt = buildRegionPrompt([{ x1: 100, y1: 100, x2: 300, y2: 500 }], 'Replace the mug with a glass of orange juice.');
    expect(prompt).toBe('Edit only the marked area Image 1 <bbox>100 100 300 500</bbox>: Replace the mug with a glass of orange juice. Keep everything outside this area in Image 1 exactly the same — composition, people, faces, objects, text, lighting and colors — and blend the edit seamlessly with the surrounding light, perspective and texture.');
    expect(buildRegionPrompt([{ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 500, y1: 500, x2: 600, y2: 600 }], 'remove them')).toContain('marked areas Image 1 <bbox>0 0 10 10</bbox> and Image 1 <bbox>500 500 600 600</bbox>');
  });

  it('без выделения, без инструкции или больше 6 мест — сообщения по-русски', () => {
    expect(regionProblems([], '')).toEqual(['Закрась кистью, что изменить.', 'Напиши, что сделать с выделенным.']);
    const many = Array.from({ length: 7 }, (_, i) => ({ x1: i * 100, y1: 0, x2: i * 100 + 10, y2: 10 }));
    expect(regionProblems(many, 'убери')[0]).toContain('больше 6');
  });

  it('перевод нужен только для русского; надпись в кавычках остаётся русской; координат в инструкции нет', () => {
    expect(needsTranslation('убери кружку')).toBe(true);
    expect(needsTranslation('remove the mug')).toBe(false);
    expect(needsTranslation('replace the text with «Привет»')).toBe(false);
    expect(validateEditInstruction({ instructionEn: 'Replace the text with "Привет".' })).toEqual([]);
    expect(validateEditInstruction({ instructionEn: 'Убери кружку' })[0]).toContain('English only');
    expect(validateEditInstruction({ instructionEn: 'Remove the mug at 120 300 500' })[0]).toContain('no coordinates');
  });
});
