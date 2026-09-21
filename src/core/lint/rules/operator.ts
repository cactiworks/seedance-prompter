import type { TextLintContext, TextRule } from '../types.ts';
import { anyOf, includesAny } from '../tokenize.ts';
import { at, matches } from './helpers.ts';

function hasOperatorRule(ctx: TextLintContext): boolean {
  return includesAny(ctx.raw, ctx.lexicon.operatorRuleMarkers ?? []);
}

function hasOperatorBan(ctx: TextLintContext): boolean {
  return includesAny(ctx.raw, ctx.lexicon.operatorBanMarkers ?? []) || hasOperatorRule(ctx);
}

/** Точка съёмки задана через человека — чтобы её показать, модель рисует оператора с камерой. */
export const OP_VANTAGE_VIA_PERSON: TextRule = {
  id: 'OP_VANTAGE_VIA_PERSON',
  family: 'operator',
  run: (ctx) => {
    const verbs = anyOf(ctx.lexicon.operatorVantageVerbs ?? []).source;
    const re = new RegExp(`\\bthe operator\\s+${verbs}[^.]{0,80}|\\bfilming from\\b[^.]{0,40}`, 'giu');
    return ctx.paragraphs.flatMap((p) =>
      matches(p, re).map((m) => at('OP_VANTAGE_VIA_PERSON', 'error', p, m, 'Точка съёмки задана через человека. Чтобы её показать, модель нарисует оператора, его руки и камеру.', 'Приём 04 «точка съёмки вне тела»: дать камере физическое место («The camera is inside the front seat of a second car…») + запрет + правило про оператора.')),
    );
  },
};

export const OP_ACTOR_VERB: TextRule = {
  id: 'OP_ACTOR_VERB',
  family: 'operator',
  run: (ctx) => {
    const verbs = anyOf(ctx.lexicon.operatorBodyVerbs ?? []).source;
    const re = new RegExp(`\\bthe operator(?:\\s+in\\s+[^,.]{0,40})?\\s+(?:${verbs})[^.]{0,70}`, 'giu');
    const withRule = hasOperatorRule(ctx);
    // Абзац с самим правилом чтения («when the operator moves, the frame moves») — не нарушение.
    const ruleMarkers = ctx.lexicon.operatorRuleMarkers ?? [];
    return ctx.paragraphs
      .filter((p) => !includesAny(p.masked, ruleMarkers))
      .flatMap((p) =>
      matches(p, re).map((m) =>
        at(
          'OP_ACTOR_VERB',
          withRule ? 'info' : 'warning',
          p,
          m,
          withRule ? 'Оператор — подлежащее телесного глагола. Правило чтения в промпте есть, но надёжнее глаголы камеры.' : 'Оператор описан как действующее лицо. Модель покажет человека с камерой.',
          'Приём 03: заменить глаголы оператора глаголами камеры («The camera lurches forward», «A quiet laugh shakes the frame») и добавить правило «Every mention of the operator refers only to the behavior of the camera».',
        ),
      ),
    );
  },
};

/**
 * Части тела оператора. «his hands» героя сюда не попадает: местоимение считается операторским,
 * только если оператор назван в этом или предыдущем предложении. Безличное
 * «as if the arms holding it are tired» допустимо — так сделано в удачных промптах гайда.
 */
export const OP_BODY_NOUN: TextRule = {
  id: 'OP_BODY_NOUN',
  family: 'operator',
  run: (ctx) => {
    const out: ReturnType<TextRule['run']> = [];
    const hint = 'Переписать безлично: «camera hand repositioning», «as if the arms holding it are tired», «Breathing is steady».';
    for (const p of ctx.paragraphs) {
      for (const m of matches(p, /\boperator'?s?\s+(?:hand|hands|arm|arms|body|face|breath|breathing)\b[^,.]{0,30}/iu)) {
        out.push(at('OP_BODY_NOUN', 'warning', p, m, `Тело оператора в тексте: «${m.text.trim()}». Это описывает человека с камерой, а не картинку.`, hint));
      }
      p.sentences.forEach((sentence, i) => {
        const context = `${p.sentences[i - 1]?.text ?? ''} ${sentence.text}`;
        if (!/\boperator\b/iu.test(context)) return;
        const match = sentence.text.match(/\bhis (?:hand|hands|arm|arms|breath)\b[^,.]{0,30}/iu);
        if (match?.index === undefined) return;
        out.push(at('OP_BODY_NOUN', 'warning', p, { index: sentence.from + match.index, text: match[0] }, `Тело оператора в тексте: «${match[0].trim()}».`, hint));
      });
    }
    return out;
  },
};

export const OP_PORTRAIT_IN_STYLE: TextRule = {
  id: 'OP_PORTRAIT_IN_STYLE',
  family: 'operator',
  run: (ctx) =>
    ctx.styleZone.flatMap((p) =>
      matches(p, /\bThe operator moves continuously[^.]*\./u).map((m) =>
        at('OP_PORTRAIT_IN_STYLE', 'warning', p, m, 'В стиль-блоке — портрет оператора. Он сообщает модели, что у сцены есть человек с камерой.', 'Гайд, Кадр 1 попытка 3: убрать из стиль-блока «The operator moves continuously…», оставить дефекты камеры.'),
      ),
    ),
};

export const OP_RULE_MISSING: TextRule = {
  id: 'OP_RULE_MISSING',
  family: 'operator',
  run: (ctx) => {
    if (hasOperatorRule(ctx)) return [];
    const mentions = ctx.paragraphs.reduce((n, p) => n + matches(p, /\boperator\b/iu).length, 0);
    if (mentions === 0) return [];
    return [at('OP_RULE_MISSING', 'warning', null, null, `Оператор упомянут ${mentions} раз, а правила чтения в промпте нет.`, 'Секция «Как снято» → правило «оператор не виден»: включить «Полное». Оно добавит дословный блок «The operator is never visible in frame… Every mention of the operator refers only to the behavior of the camera.»')];
  },
};

/** Запрет работает, только когда остальной текст с ним не спорит. */
export const OP_BAN_CONTRADICTED: TextRule = {
  id: 'OP_BAN_CONTRADICTED',
  family: 'operator',
  run: (ctx) => {
    if (!hasOperatorBan(ctx)) return [];
    return ctx.paragraphs.flatMap((p) =>
      matches(p, /\boperator'?s?\s+(?:faint\s+)?reflection[^.]{0,80}/iu).map((m) =>
        at('OP_BAN_CONTRADICTED', 'info', p, m, 'Промпт запрещает оператора в кадре и тут же просит его отражение.', 'В гайде это осознанное исключение (мимолётное отражение считывается как реальность). Если так и задумано — подавить находку с причиной; иначе убрать.'),
      ),
    );
  },
};
