import type { TextRule } from '../types.ts';
import { at, matches } from './helpers.ts';

/** Русское слово посреди английского текста («in внимание a puddle») — след неаккуратного копирования. */
export const HYG_CYRILLIC_OUTSIDE_QUOTES: TextRule = {
  id: 'HYG_CYRILLIC_OUTSIDE_QUOTES',
  family: 'hygiene',
  run: (ctx) =>
    ctx.paragraphs.flatMap((p) =>
      matches(p, /[Ѐ-ӿ]+(?:[\s-][Ѐ-ӿ]+)*/u).map((m) =>
        at('HYG_CYRILLIC_OUTSIDE_QUOTES', 'error', p, m, `Кириллица вне реплики: «${m.text}». Модель прочитает это как часть сцены.`, 'Удалить или перенести в реплику в «ёлочках». Гайд: «опечатки и странные слова попали в текст и озвучку».'),
      ),
    ),
};

export const HYG_PUNCT: TextRule = {
  id: 'HYG_PUNCT',
  family: 'hygiene',
  run: (ctx) => {
    const out = [];
    for (const p of ctx.paragraphs) {
      for (const m of matches(p, /,\.|\.,|(?<!\.)\.\.(?!\.)|\s,|,,/)) {
        out.push(at('HYG_PUNCT', 'warning', p, m, `Сбой пунктуации: «${m.text.trim() || m.text}».`, 'Вычитать абзац: модель такие места игнорирует, но рядом с ними обычно лежит потерянный кусок текста.'));
      }
      const last = p.text.trim().slice(-1);
      if (!/[.!?»"”)}]/.test(last)) {
        const tail = p.text.trim().slice(-40);
        out.push(at('HYG_PUNCT', 'warning', p, { index: p.text.length - tail.length, text: tail }, 'Абзац обрывается без точки — похоже на недокопированный текст.', 'Проверить, что абзац вставлен целиком.'));
      }
    }
    return out;
  },
};

/** Остатки шаблона: неразвёрнутые плейсхолдеры компилятора или слоты pack. */
export const HYG_PLACEHOLDER_LEFT: TextRule = {
  id: 'HYG_PLACEHOLDER_LEFT',
  family: 'hygiene',
  run: (ctx) =>
    ctx.paragraphs.flatMap((p) =>
      matches(p, /\{\{[^}]*\}\}|\[\[[^\]]*\]\]|\[[A-ZА-ЯЁ][A-ZА-ЯЁ0-9 :,/-]{3,}\]/u).map((m) =>
        at('HYG_PLACEHOLDER_LEFT', 'error', p, m, `Неразвёрнутый плейсхолдер: ${m.text}.`, 'Промпт нельзя отдавать в генерацию, пока слот не заполнен.'),
      ),
    ),
};
