import type { SceneDraft, PromptPlan } from '../../src/core/production/plan.ts';

export const SCRIPT = 'Я открываю блокнот у окна. Записываю мысль. Закрываю блокнот.';
export function sceneDraft(count = 3): SceneDraft {
  return {
    scene: { title: 'Утро у окна', location: 'Комната с деревянным столом у северного окна', subject: 'Владелец; внешность задаётся будущим identity reference', wardrobe: 'Однотонная белая футболка', timeOfDay: 'Утро', weather: 'Пасмурно', lighting: 'Мягкий боковой свет из окна', palette: 'Тёплое дерево, белый и серый', continuity: ['Тот же стол и блокнот', 'Окно слева от персонажа'] },
    shots: Array.from({ length: count }, (_, i) => ({ title: `Кадр ${i + 1}`, scriptExcerpt: SCRIPT.split('. ')[i % 3]!, purpose: 'Показать действие для монтажа', framing: i % 2 ? 'Крупный план' : 'Средний план', action: 'Владелец открывает блокнот на столе', camera: 'Телефон на уровне стола, небольшое естественное движение', durationSec: 6 })),
    assumptions: ['Одежда и комната выбраны режиссёром'], warnings: ['Для узнаваемости нужен identity reference'],
  };
}
export function promptPlan(count = 3): PromptPlan {
  return { shots: Array.from({ length: count }, (_, i) => ({ shotId: `shot-${i + 1}`, imagePrompt: 'A natural phone photograph of the subject opening a notebook at a warm wooden desk beside a north facing window. A plain white shirt, soft overcast morning light from the left, restrained white and gray palette, a quiet room and a grounded tabletop composition.', motionPrompt: '0–3s: the subject opens the notebook at the same wooden desk. 3–6s: a subtle handheld camera drift settles on the page. One continuous shot in soft window light.' })), warnings: [] };
}
