import type { GeneratedBrollDraft, GeneratedSceneDraft, PromptPlan } from '../../src/core/production/plan.ts';

export const SCRIPT = 'Я открываю блокнот у окна. Записываю мысль. Закрываю блокнот.';
export function sceneDraft(count = 3): GeneratedSceneDraft {
  return {
    artDirection: { concept: 'Момент выбора перед записью', visualHook: 'Тень оконной рамы делит открытую страницу', captureTexture: 'Телефонный кадр с сохранённой фактурой бумаги' },
    storyboardVersion: 'events-v1',
    scenes: [{ id: 'room', title: 'Утро у окна', location: 'Комната с деревянным столом у северного окна', subject: 'Владелец; внешность задаётся будущим identity reference', wardrobe: 'Однотонная белая футболка', timeOfDay: 'Утро', weather: 'Пасмурно', lighting: 'Мягкий боковой свет из окна', palette: 'Тёплое дерево, белый и серый', continuity: ['Тот же стол и блокнот', 'Окно слева от персонажа'] }],
    shots: Array.from({ length: count }, (_, i) => ({ title: `Кадр ${i + 1}`, scriptExcerpt: SCRIPT.split('. ')[Math.min(2, Math.floor(i * 3 / count))]!, purpose: 'Показать действие для монтажа', framing: i % 2 ? 'Крупный план' : 'Средний план', action: `Владелец выполняет событие ${i + 1} с блокнотом`, sceneId: 'room', beat: `Смысловой момент ${i + 1}`, startFrame: `Видимое состояние ${i + 1} блокнота и рук`, subjectVisibility: 'person', camera: 'Телефон на уровне стола, небольшое естественное движение', visualAnchor: 'Рука пересекает полосу оконной тени на странице', durationSec: 6 })),
    assumptions: ['Одежда и комната выбраны режиссёром'], warnings: ['Для узнаваемости нужен identity reference'],
  };
}
export function promptPlan(count = 3): PromptPlan {
  return { masterPrompt: 'A wide establishing photograph of one quiet room with a warm wooden desk next to a north facing window. {{identity}}. The subject wears a plain white shirt and sits at the desk with a notebook. Soft overcast morning light from the left reveals the furniture, room layout and consistent neutral palette.', shots: Array.from({ length: count }, (_, i) => ({ shotId: `shot-${i + 1}`, imagePrompt: `Frame ${i + 1}: a natural phone photograph of the subject opening a notebook at a warm wooden desk beside a north facing window. A plain white shirt, soft overcast morning light from the left, restrained white and gray palette, a quiet room and a grounded tabletop composition. {{identity}}.`, motionPrompt: '0–3s: the subject opens the notebook at the same wooden desk. 3–6s: a subtle handheld camera drift settles on the page. One continuous shot in soft window light.' })), warnings: [] };
}

/** Synthetic independent concepts; this fixture does not prove creative quality. */
export function brollDraft(count = 4): GeneratedBrollDraft {
  const base = sceneDraft(count);
  return { ...base, contentMode: 'broll',
    scenes: base.shots.map((_, i) => ({ ...base.scenes[0]!, id: `location-${i + 1}`, title: `Локация ${i + 1}`, wardrobe: `Авторский силуэт ${i + 1}` })),
    shots: base.shots.map(({ scriptExcerpt: _quote, beat: _beat, ...shot }, i) => ({ ...shot,
      sceneId: `location-${i + 1}`, concept: `Самостоятельная визуальная идея ${i + 1}`,
      intentionalEffect: i === 0 ? 'Ткань образует вихрь вокруг неподвижного человека; его анатомия естественна' : 'Естественная физика, эффект создаётся постановкой',
      visualAnchor: `Визуальный приём ${i + 1}`, purpose: 'Вставка для разговорного ролика без связи с репликой',
    })),
  };
}

export function reviewReport(ids: string[]) {
  return { summary: 'Тестовый отчёт, без оценки настоящего качества.', results: ids.map((artifactId) => ({
    artifactId, verdict: 'keep' as const, reason: 'Соответствует плану в тестовом ответе.',
    checks: { character: 'pass' as const, face: 'pass' as const, likeness: 'pass' as const, identityLeakage: 'pass', text: 'not_visible', hands: 'pass' as const, continuity: 'pass' as const, shotMatch: 'pass' as const, visualInterest: 'pass' as const },
    faceDetail: { leftEye: 'pass', rightEye: 'pass', mouth: 'pass' },
    observations: (['face', 'character', 'hands', 'identityLeakage', 'text'] as const).map(check => ({ check, region: `Тестовая область ${check}`, evidence: 'Синтетическое наблюдение; настоящие пиксели моделью не оценивались.' })),
  })) };
}

export function appearanceOutput(count = 2) {
  const anchorEn = 'An adult man with short dark wavy hair, a broad forehead, straight eyebrows and a defined jaw. His visible shoulders are moderately broad and his torso has a straight natural silhouette, consistently preserved across the photographs.';
  const source = promptPlan(count);
  return { profile: { anchorEn, summaryRu: 'Синтетический профиль для теста.', traits: { presentation: 'Взрослый мужской образ', face: 'Выраженная челюсть', hair: 'Короткие волнистые волосы', build: 'Прямой силуэт' }, evidence: [{ imageIndex: 1, observation: 'Тестовое наблюдение' }], unknowns: [], usable: true },
    prompts: { ...source, masterPrompt: source.masterPrompt!.replace('{{identity}}', anchorEn), shots: source.shots.map(s => ({ ...s, imagePrompt: s.imagePrompt.replace('{{identity}}', anchorEn) })) } };
}
