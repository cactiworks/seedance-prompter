/**
 * Точечная правка по выделению (решение 32): владелец закрашивает кистью, что изменить, и пишет, что сделать.
 * Seedream 5 Pro принимает область прямо в промпте — официальный формат интерактивной правки BytePlus
 * (docs.byteplus.com/en/docs/modelark/seedream-5-0-pro-editing-guide, 28.09.2026):
 * `Image 1 <bbox>x1 y1 x2 y2</bbox>` и `<point>x y</point>`, координаты нормированы к 0…999 от левого верхнего угла.
 * Отдельного параметра маски у модели через KIE нет, поэтому маска превращается в рамки: по одной на каждое
 * связное пятно закраски.
 */

/** Маска в сетке `width × height` (пропорции картинки): 1 — закрашено. */
export interface MaskGrid {
  width: number;
  height: number;
  cells: Uint8Array;
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export const MAX_REGIONS = 6;

const clamp999 = (value: number): number => Math.max(0, Math.min(999, Math.round(value)));

/**
 * Связные пятна закраски → рамки в координатах 0…999. Пятна меньше `minCells` (случайный тычок кистью) — мимо.
 * Рамки, которые пересекаются или почти касаются, склеиваются: модель лучше понимает одну область, чем две впритык.
 */
export function maskToBoxes(mask: MaskGrid, minCells = 3): Box[] {
  const { width, height, cells } = mask;
  const seen = new Uint8Array(cells.length);
  const boxes: Box[] = [];
  for (let start = 0; start < cells.length; start += 1) {
    if (cells[start] !== 1 || seen[start] === 1) continue;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % width;
      const y = (i - x) / width;
      count += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      const neighbours = [x + 1 < width ? i + 1 : -1, x > 0 ? i - 1 : -1, y + 1 < height ? i + width : -1, y > 0 ? i - width : -1];
      for (const j of neighbours) {
        if (j >= 0 && cells[j] === 1 && seen[j] === 0) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (count < minCells) continue;
    boxes.push({ x1: clamp999((minX / width) * 1000), y1: clamp999((minY / height) * 1000), x2: clamp999(((maxX + 1) / width) * 1000), y2: clamp999(((maxY + 1) / height) * 1000) });
  }
  return mergeBoxes(boxes, 20);
}

const near = (a: Box, b: Box, gap: number): boolean => a.x1 <= b.x2 + gap && b.x1 <= a.x2 + gap && a.y1 <= b.y2 + gap && b.y1 <= a.y2 + gap;

/** Склеивает рамки, между которыми меньше `gap` (в единицах 0…999), пока склеивать нечего. */
export function mergeBoxes(input: readonly Box[], gap: number): Box[] {
  let boxes = [...input];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i] as Box;
        const b = boxes[j] as Box;
        if (!near(a, b, gap)) continue;
        const union = { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
        boxes = [...boxes.filter((_, k) => k !== i && k !== j), union];
        merged = true;
        break outer;
      }
    }
  }
  // Сверху вниз, слева направо — порядок, в котором владелец их видит.
  return boxes.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
}

export const boxToken = (box: Box, image = 1): string => `Image ${image} <bbox>${box.x1} ${box.y1} ${box.x2} ${box.y2}</bbox>`;

/** Что мешает отправить правку — по-русски, для строки под картинкой. */
export function regionProblems(boxes: readonly Box[], instructionRu: string): string[] {
  const problems: string[] = [];
  if (boxes.length === 0) problems.push('Закрась кистью, что изменить.');
  if (instructionRu.trim() === '') problems.push('Напиши, что сделать с выделенным.');
  if (boxes.length > MAX_REGIONS) problems.push(`Выделено ${boxes.length} отдельных мест — больше ${MAX_REGIONS} модель путает; объедини соседние мазки.`);
  return problems;
}

/** Промпт правки по формулам гайда ByteDance: рамки выделения + английская инструкция + что сохранить. */
export function buildRegionPrompt(boxes: readonly Box[], instructionEn: string): string {
  const instruction = instructionEn.trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, '');
  const area = boxes.map((box) => boxToken(box)).join(' and ');
  const plural = boxes.length > 1;
  return `Edit only the marked area${plural ? 's' : ''} ${area}: ${instruction}. Keep everything outside ${plural ? 'these areas' : 'this area'} in Image 1 exactly the same — composition, people, faces, objects, text, lighting and colors — and blend the edit seamlessly with the surrounding light, perspective and texture.`;
}
