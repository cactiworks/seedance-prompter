import type { TextRule } from '../types.ts';
import { anyOf, countWords, includesAny } from '../tokenize.ts';
import { at, matches } from './helpers.ts';

// ---------- стиль ----------

export const STYLE_REAL_GEAR: TextRule = {
  id: 'STYLE_REAL_GEAR',
  family: 'style',
  run: (ctx) => {
    const zone = ctx.styleZone.map((p) => p.masked).join('\n');
    const out = [];
    if (!includesAny(zone, ctx.lexicon.gearAnchor ?? [])) {
      out.push(at('STYLE_REAL_GEAR', 'warning', ctx.styleZone[0] ?? null, null, 'В блоке «как снято» нет якоря техники («shot on <камера> with <объективы>»).', 'Приём 01: реальная модель камеры и объективов, рядом — характер картинки этой техники.'));
    }
    for (const p of ctx.styleZone) {
      for (const m of matches(p, anyOf(ctx.lexicon.genericGear ?? []))) {
        out.push(at('STYLE_REAL_GEAR', 'warning', p, m, `«${m.text}» — не якорь: модель выберет усреднённую картинку.`, 'Назвать реальную камеру и объективы.'));
      }
    }
    return out;
  },
};

export const STYLE_HANDHELD_SWITCH: TextRule = {
  id: 'STYLE_HANDHELD_SWITCH',
  family: 'style',
  run: (ctx) => {
    const zone = ctx.styleZone.map((p) => p.masked).join('\n');
    if (!includesAny(zone, ctx.lexicon.handheldSwitch ?? [])) {
      return [at('STYLE_HANDHELD_SWITCH', 'warning', ctx.styleZone[0] ?? null, null, 'Нет главного переключателя документальности — «unstabilized handheld camera».', 'Гладкая камера — первый признак ИИ-слопа.')];
    }
    if (!includesAny(zone, ctx.lexicon.noStabilization ?? [])) {
      return [at('STYLE_HANDHELD_SWITCH', 'info', ctx.styleZone[0] ?? null, null, 'Нет усилителя «no stabilization whatsoever».', 'В удачных промптах гайда он стоит сразу после «unstabilized handheld camera».')];
    }
    return [];
  },
};

export const STYLE_DEFECT_STACK: TextRule = {
  id: 'STYLE_DEFECT_STACK',
  family: 'style',
  run: (ctx) => {
    const zone = ctx.styleZone.map((p) => p.masked.toLowerCase()).join('\n');
    const found = (ctx.lexicon.defects ?? []).filter((d) => zone.includes(d.toLowerCase()));
    if (found.length >= ctx.params.defectStack.minItems) return [];
    return [at('STYLE_DEFECT_STACK', 'warning', ctx.styleZone[0] ?? null, null, `Стек несовершенств слабый: найдено ${found.length} из минимум ${ctx.params.defectStack.minItems}.`, 'Приём 02: набор дефектов оператора и камеры одним абзацем — самый дешёвый способ убрать «дрон».')];
  },
};

export const STYLE_LANG_TAIL: TextRule = {
  id: 'STYLE_LANG_TAIL',
  family: 'style',
  run: (ctx) => {
    if (ctx.lines.length === 0) return [];
    const zone = ctx.styleZone.map((p) => p.masked).join('\n');
    if (includesAny(zone, ctx.lexicon.languageTail ?? [])) return [];
    return [at('STYLE_LANG_TAIL', 'warning', ctx.styleZone[0] ?? null, null, 'В стиль-блоке нет языкового хвоста («All dialogue in clear, native Russian…»).', 'Хвост фиксирует язык и произношение для всех реплик кадра.')];
  },
};

export const ONE_TAKE_CONTRADICTION: TextRule = {
  id: 'ONE_TAKE_CONTRADICTION',
  family: 'style',
  run: (ctx) =>
    ctx.paragraphs.flatMap((p) =>
      matches(p, anyOf(ctx.lexicon.cutWords ?? [])).map((m) => at('ONE_TAKE_CONTRADICTION', 'warning', p, m, `«${m.text}» спорит с форматом «one continuous take, no cuts».`, 'Один дубль без склеек: описывать движение камеры, а не монтаж.')),
    ),
};

// ---------- финал ----------

export const FINALE_COMMAND: TextRule = {
  id: 'FINALE_COMMAND',
  family: 'finale',
  run: (ctx) => {
    const last = ctx.paragraphs.at(-1);
    if (last === undefined) return [];
    return matches(last, /\bThe (?:scene|shot|clip|video|take) ends\.\s*$/u).map((m) => at('FINALE_COMMAND', 'warning', last, m, '«The scene ends.» — команда, а не картина. Без описанного покоя модель обрывает сцену посреди движения.', 'Приём 10 «финальная пауза»: покой, тишина, звук за кадром, камера опускается.'));
  },
};

export const FINALE_PRESENT: TextRule = {
  id: 'FINALE_PRESENT',
  family: 'finale',
  run: (ctx) => {
    const last = ctx.paragraphs.at(-1);
    if (last === undefined) return [];
    const signals = [ctx.lexicon.finaleRest, ctx.lexicon.finaleSilence, ctx.lexicon.finaleOffscreen, ctx.lexicon.finaleCameraSettle].filter((group) => includesAny(last.masked, group ?? [])).length;
    if (signals >= ctx.params.finale.minSignals) return [];
    return [at('FINALE_PRESENT', 'warning', last, null, `У дубля нет прописанного финала: найдено ${signals} признаков из 4 (покой, тишина, звук за кадром, камера оседает).`, 'Шаблон гайда: «A second of silence, just the wind. Someone laughs off-screen. The camera slowly lowers, as if the arms holding it are finally tired.»')];
  },
};

// ---------- показуемость ----------

export const UNSHOWABLE_SENSE: TextRule = {
  id: 'UNSHOWABLE_SENSE',
  family: 'showable',
  run: (ctx) => ctx.paragraphs.flatMap((p) => matches(p, anyOf(ctx.lexicon.unshowableSense ?? [])).map((m) => at('UNSHOWABLE_SENSE', 'info', p, m, `«${m.text}» нельзя показать в кадре — строка тратит бюджет внимания впустую.`, 'Заменить видимым действием или убрать.'))),
};

export const UNSHOWABLE_SILENT_SPEECH: TextRule = {
  id: 'UNSHOWABLE_SILENT_SPEECH',
  family: 'showable',
  run: (ctx) => ctx.paragraphs.flatMap((p) => matches(p, anyOf(ctx.lexicon.silentSpeech ?? [])).map((m) => at('UNSHOWABLE_SILENT_SPEECH', 'info', p, m, `Реплика без звука («${m.text}») не сработает: модель либо озвучит её, либо проигнорирует.`, 'Убрать немую речь или дать реплику в «ёлочках».'))),
};

// ---------- роли: один объект — одна роль ----------

export const ROLE_FX_ON_PROP: TextRule = {
  id: 'ROLE_FX_ON_PROP',
  family: 'roles',
  run: (ctx) => {
    const fx = anyOf(ctx.lexicon.opticalFx ?? []);
    const handling = anyOf(ctx.lexicon.propHandling ?? []);
    const prop = anyOf(ctx.lexicon.propLensNouns ?? []);
    const out: ReturnType<TextRule['run']> = [];
    // Стиль-блок описывает саму снимающую технику: «streaks when a light source hits the lens» там на месте.
    const style = new Set(ctx.styleZone.map((p) => p.index));
    for (const p of ctx.paragraphs.filter((x) => !style.has(x.index))) {
      p.sentences.forEach((sentence, i) => {
        if (!fx.test(sentence.text)) return;
        if (/\b(?:no|not|never|without)\b/iu.test(sentence.text)) return;
        if (includesAny(sentence.text, ctx.lexicon.fxOnImageMarkers ?? [])) return;
        const window = p.sentences.slice(Math.max(0, i - 2), i + 1).map((s) => s.text).join(' ');
        if (handling.test(window) && prop.test(window)) {
          // Эвристика по соседству слов: копирование не блокирует, решение за владельцем.
          out.push(at('ROLE_FX_ON_PROP', 'warning', p, { index: sentence.from, text: sentence.text }, 'Эффект оптики описан рядом с предметом в руках героя — модель нарисует блик на самом предмете.', 'Приём 06: снимающий объектив даёт эффект «on the image itself», а реквизит — «just glass, metal… No flares, no streaks».'));
        }
      });
    }
    return out;
  },
};

// ---------- реплики и бюджет ----------

export const LINE_LANG_PHRASE: TextRule = {
  id: 'LINE_LANG_PHRASE',
  family: 'lines',
  run: (ctx) => {
    const out = [];
    for (const line of ctx.lines) {
      const p = ctx.paragraphs[line.paragraph];
      if (p === undefined) continue;
      const before = p.text.slice(Math.max(0, line.from - 140), line.from);
      // Любой язык и оба диалекта: «clear, native Russian…» (гайд) или «says naturally in Russian:» (ByteDance).
      if (!includesAny(before, ctx.lexicon.languagePhrase ?? []) && !/\bnative\s+[A-Z][a-z]+\b|\bin\s+[A-Z][a-z]+\s*:\s*$/u.test(before)) {
        out.push(at('LINE_LANG_PHRASE', 'warning', p, { index: line.from, text: `«${line.text.slice(0, 40)}…»` }, 'Перед репликой нет языковой фразы.', 'Приём 09: «says in clear, native Russian, perfect pronunciation, natural intonation: «…»».'));
      }
    }
    return out;
  },
};

export const LINE_TOO_LONG: TextRule = {
  id: 'LINE_TOO_LONG',
  family: 'lines',
  run: (ctx) =>
    ctx.lines
      .filter((line) => countWords(line.text) > ctx.params.speech.maxLineWords)
      .map((line) => at('LINE_TOO_LONG', 'info', ctx.paragraphs[line.paragraph] ?? null, { index: line.from, text: `«${line.text.slice(0, 40)}…»` }, `Реплика на ${countWords(line.text)} слов. Гайд: реплики делаем короткими.`, 'Разбить на две с жестом или паузой между ними.')),
};

export const LINE_HOMOGLYPH: TextRule = {
  id: 'LINE_HOMOGLYPH',
  family: 'lines',
  run: (ctx) => {
    const out = [];
    for (const line of ctx.lines) {
      for (const m of line.text.matchAll(/[\p{L}]+/gu)) {
        const word = m[0];
        if (/[Ѐ-ӿ]/u.test(word) && /[A-Za-z]/.test(word)) {
          out.push(at('LINE_HOMOGLYPH', 'error', ctx.paragraphs[line.paragraph] ?? null, { index: line.from, text: word }, `В слове «${word}» смешаны кириллица и латиница — озвучка произнесёт его буквально.`, 'Перенабрать слово одной раскладкой.'));
        }
      }
    }
    return out;
  },
};

export const SPEECH_BUDGET: TextRule = {
  id: 'SPEECH_BUDGET',
  family: 'budget',
  run: (ctx) => {
    const words = ctx.lines.reduce((n, line) => n + countWords(line.text), 0);
    if (words === 0) return [];
    const { wordsPerSecond, speakingShare, infoAt, warnAt } = ctx.params.speech;
    const capacity = Math.round(ctx.durationSec * speakingShare * wordsPerSecond);
    const ratio = words / capacity;
    if (ratio <= infoAt) return [];
    return [at('SPEECH_BUDGET', ratio > warnAt ? 'warning' : 'info', null, null, `В репликах ${words} слов при ёмкости ≈${capacity} (${ctx.durationSec} с × ${speakingShare} × ${wordsPerSecond} слова/с).`, 'Лишние слова модель теряет: в Кадре 2 гайда (79 слов) часть реплики выпала. Сократить реплики или убрать одну.')];
  },
};

/** Не драка и не действие, а россыпь мелких жестов: потёр руки, прищурился, кивнул, ухмыльнулся… */
export const MICRO_ACTION_OVERLOAD: TextRule = {
  id: 'MICRO_ACTION_OVERLOAD',
  family: 'budget',
  run: (ctx) => {
    const gesture = anyOf(ctx.lexicon.microGestures ?? []);
    const limit = ctx.params.microActions.maxGesturesPerParagraph;
    return ctx.paragraphs
      .map((p) => ({ p, found: matches(p, gesture) }))
      .filter(({ found }) => found.length > limit)
      .map(({ p, found }) => at('MICRO_ACTION_OVERLOAD', 'warning', p, null, `В абзаце ${found.length} мелких жестов подряд (${found.slice(0, 5).map((m) => m.text).join(', ')}…). За 30 секунд модель это не покажет.`, 'Гайд, Кадр 1 попытка 1: «больше 15 мелких действий подряд… лучше оставить одно действие на героя».'));
  },
};

export const SHOT_SIZE_KEY_MOMENTS: TextRule = {
  id: 'SHOT_SIZE_KEY_MOMENTS',
  family: 'budget',
  run: (ctx) => {
    if (includesAny(ctx.raw, ctx.lexicon.shotSizes ?? [])) return [];
    return [at('SHOT_SIZE_KEY_MOMENTS', 'info', null, null, 'Размер плана нигде не задан — модель выберет общий план.', 'Гайд, Кадр 1: «settles into a medium shot of Alexander» в ключевой момент.')];
  },
};

// ---------- свет ----------

export const LIGHT_EVENT: TextRule = {
  id: 'LIGHT_EVENT',
  family: 'light',
  run: (ctx) => {
    if (includesAny(ctx.raw, ctx.lexicon.lightEventMarkers ?? [])) return [];
    return [at('LIGHT_EVENT', 'warning', null, null, 'Свет описан как постоянное состояние — нет ни одного события во времени.', 'Приём 07: «A cloud passes, the light shifts for two seconds, then returns.»')];
  },
};

export const WEATHER_PHYSICS: TextRule = {
  id: 'WEATHER_PHYSICS',
  family: 'light',
  run: (ctx) => {
    const lower = ctx.raw.toLowerCase();
    const found = new Set((ctx.lexicon.weatherPhysics ?? []).filter((w) => lower.includes(w)));
    if (found.size >= 3) return [];
    return [at('WEATHER_PHYSICS', 'info', null, null, 'Погода не даёт физики: мало отражений, пара, ветра.', 'Сигнал реальности 04: мокрый асфальт, отражения, пар, ветер в одежде.')];
  },
};

// ---------- риски ----------

export const MECH_RISK: TextRule = {
  id: 'MECH_RISK',
  family: 'risk',
  run: (ctx) => {
    const nouns = anyOf(ctx.lexicon.mechanicsNouns ?? []).source;
    const verbs = anyOf(ctx.lexicon.mechanicsVerbs ?? []).source;
    const re = new RegExp(`(?:${verbs})[^.]{0,30}(?:${nouns})|(?:${nouns})[^.]{0,30}(?:${verbs})`, 'giu');
    const seen = new Set<string>();
    return ctx.paragraphs.flatMap((p) =>
      matches(p, re)
        .filter((m) => {
          const noun = m.text.toLowerCase().match(new RegExp(nouns, 'iu'))?.[0] ?? m.text;
          return seen.has(noun) ? false : (seen.add(noun), true);
        })
        .map((m) => at('MECH_RISK', 'info', p, m, `Механика открывающихся частей («${m.text.trim()}») — слабое место видеомоделей.`, 'Гайд: не бороться перегенерациями, строить сцену так, чтобы огрех спрятался шрифтом в монтаже.')),
    );
  },
};

export const SAME_OBJECTS_MERGE: TextRule = {
  id: 'SAME_OBJECTS_MERGE',
  family: 'risk',
  run: (ctx) => {
    const counts = anyOf(ctx.lexicon.countWords ?? []).source;
    const re = new RegExp(`(?:${counts})\\s+(?:[a-z-]+\\s){0,2}?[a-z]+s\\b`, 'giu');
    const seen = new Set<string>();
    return ctx.paragraphs.flatMap((p) =>
      matches(p, re)
        .filter((m) => !(ctx.lexicon.countNounStop ?? []).some((stop) => m.text.toLowerCase().endsWith(stop)))
        .filter((m) => (seen.has(m.text.toLowerCase()) ? false : (seen.add(m.text.toLowerCase()), true)))
        .map((m) => at('SAME_OBJECTS_MERGE', 'info', p, m, `«${m.text}»: однотипные объекты в одном состоянии модель склеивает (три кейса → один с тремя отсеками).`, 'Развести состояния или цвета объектов — либо принять слияние заранее.')),
    );
  },
};

export const LEN_RANGE: TextRule = {
  id: 'LEN_RANGE',
  family: 'platform',
  run: (ctx) => {
    if (ctx.raw.length <= ctx.params.length.infoAboveChars) return [];
    return [at('LEN_RANGE', 'info', null, null, `Промпт ${ctx.raw.length} знаков — длиннее проверенного гайдом диапазона (7,4–9,6 тыс.).`, 'Официальная рекомендация ByteDance — кратчайший промпт. Проверить, что каждая строка сужает выбор модели.')];
  },
};
