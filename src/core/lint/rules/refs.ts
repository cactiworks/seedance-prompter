import type { TextRule } from '../types.ts';
import { anyOf } from '../tokenize.ts';
import { at, matches } from './helpers.ts';

const CHIP_RE = /<<<image_(\d+)>>>/g;
const AT_RE = /@image\s?_?(\d+)/gi;

export const REF_SYNTAX_FOREIGN: TextRule = {
  id: 'REF_SYNTAX_FOREIGN',
  family: 'refs',
  run: (ctx) => {
    const foreign = ctx.refSyntax === 'higgsfield-chip' ? AT_RE : CHIP_RE;
    const expected = ctx.refSyntax === 'higgsfield-chip' ? '<<<image_N>>>' : '@Image N';
    return ctx.paragraphs.flatMap((p) =>
      matches(p, foreign).map((m) => at('REF_SYNTAX_FOREIGN', 'error', p, m, `Ссылка записана чужим синтаксисом: ${m.text}. В проекте принят ${expected}.`, 'Формат ссылок должен быть одинаковым везде — заменить на ссылку из панели.')),
    );
  },
};

/** «shot on RED from with Laowa…», «exactly as in and —»: при копировании пропали теги ссылок. */
export const REF_DANGLING_PREP: TextRule = {
  id: 'REF_DANGLING_PREP',
  family: 'refs',
  run: (ctx) =>
    ctx.paragraphs.flatMap((p) =>
      matches(p, /\bfrom\s+(?:with|in(?!\s+front)|and)\b|\bfrom\s*[,.]|\bmatching\s*,|\bas in\s+and\b|\blenses from\s*,/i).map((m) =>
        at('REF_DANGLING_PREP', 'error', p, m, `После «${m.text.trim()}» пусто — здесь должна стоять ссылка на референс.`, 'Гайд: «проверять текст в самом Higgsfield: ссылки должны быть на месте». Вернуть ссылку из панели.'),
      ),
    ),
};

export const REF_OUT_OF_RANGE: TextRule = {
  id: 'REF_OUT_OF_RANGE',
  family: 'refs',
  run: (ctx) => {
    if (ctx.panelSize === null) return [];
    const size = ctx.panelSize;
    return ctx.paragraphs.flatMap((p) =>
      matches(p, CHIP_RE)
        .filter((m) => Number(m.text.match(/\d+/)?.[0]) > size || Number(m.text.match(/\d+/)?.[0]) < 1)
        .map((m) => at('REF_OUT_OF_RANGE', 'error', p, m, `${m.text} — в панели только ${size} картинок.`, 'Сверить порядок картинок в панели с номерами в тексте.')),
    );
  },
};

export const REF_UNUSED: TextRule = {
  id: 'REF_UNUSED',
  family: 'refs',
  run: (ctx) => {
    if (ctx.panelSize === null) return [];
    const used = new Set([...ctx.raw.matchAll(CHIP_RE)].map((m) => Number(m[1])));
    if (used.size === 0) return [];
    const unused = Array.from({ length: ctx.panelSize }, (_, i) => i + 1).filter((n) => !used.has(n));
    return unused.map((n) => at('REF_UNUSED', 'warning', null, null, `Картинка №${n} в панели есть, а в тексте не вызвана.`, 'Лишний референс превращается в героя: убрать из панели или дать ему роль.'));
  },
};

/** У случайного прохожего не должно быть ни референса, ни подробной роли. */
export const REF_ON_EXTRA: TextRule = {
  id: 'REF_ON_EXTRA',
  family: 'refs',
  run: (ctx) => {
    const extras = anyOf(ctx.lexicon.extraNouns ?? []).source;
    const re = new RegExp(`${extras}[^.]{0,30}<<<image_\\d+>>>`, 'giu');
    const seen = new Set<string>();
    return ctx.paragraphs.flatMap((p) =>
      matches(p, re)
        .filter((m) => (seen.has(m.text) ? false : (seen.add(m.text), true)))
        .map((m) => at('REF_ON_EXTRA', 'warning', p, m, `Статисту выдан референс: «${m.text}». Модель сделает его главным героем сцены.`, 'Гайд, Кадр 1: убрать персонажа и его референс, оставить безликого «random man».')),
    );
  },
};

export const REF_PANEL_LIMIT: TextRule = {
  id: 'REF_PANEL_LIMIT',
  family: 'refs',
  run: (ctx) => {
    if (ctx.panelSize === null) return [];
    if (ctx.panelSize > ctx.params.refs.hardLimit) return [at('REF_PANEL_LIMIT', 'error', null, null, `В панели ${ctx.panelSize} изображений — Seedance 2.5 принимает до ${ctx.params.refs.hardLimit}.`, 'Убрать лишние референсы.')];
    if (ctx.panelSize > ctx.params.refs.softLimit) return [at('REF_PANEL_LIMIT', 'info', null, null, `В панели ${ctx.panelSize} референсов. ByteDance: «the more assets, the more easily stability drops».`, 'Оставить только то, что нужно этому кадру (в гайде Кадр 2 сократили с 11 до 7).')];
    return [];
  },
};
