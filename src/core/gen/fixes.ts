import { findModel, paramsFor, validateGen, type GenModel, type GenParams, type ParamValue, type RefRole } from './models.ts';

/**
 * Рецепты починки (этап 2): типовая ошибка картинки → модель и формулировка правки. Данные — в
 * packs/prompter/fixes.json (каталог из ресёрча 003); здесь — подстановка полей владельца и проверка набора.
 */

/** Вариант выбора: `value` уходит в промпт, `params` — поверх параметров модели (новый формат, множитель апскейла). */
export interface FixOption {
  value: string;
  labelRu: string;
  params?: Record<string, ParamValue>;
}

export interface FixField {
  key: string;
  labelRu: string;
  placeholder: string;
  required: boolean;
  /** Есть — поле выбора (по умолчанию первый вариант); нет — текст владельца. */
  options?: FixOption[];
}

export interface FixRecipe {
  id: string;
  /** fix — «что не так» (починка ошибки), tool — инструмент (фон, формат, свет, апскейл). */
  group: 'fix' | 'tool';
  titleRu: string;
  whenRu: string;
  whyRu: string;
  /** Первая — основная, остальные — запасные. `params` — поверх параметров исходной картинки. */
  models: { modelId: string; params: Record<string, ParamValue> }[];
  fields: FixField[];
  /** Вторая картинка, без которой правка не имеет смысла (фото лица). */
  extraRef: { labelRu: string; hintRu: string } | null;
  /** `{{key}}` — поле владельца; строка с пустым необязательным полем выбрасывается целиком. */
  prompt: string;
  sourceRu: string;
}

export interface FixPack {
  version: number;
  sourceRu: string;
  recipes: FixRecipe[];
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Значение поля без внешних кавычек и лишних пробелов: «Привет» и "Привет" — одна надпись. */
const clean = (value: string): string =>
  value
    .trim()
    .replace(/^["«“]+|["»”]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ');

const chosen = (field: FixField, values: Readonly<Record<string, string>>): FixOption | undefined => field.options?.find((o) => o.value === values[field.key]) ?? field.options?.[0];

/** Значение поля: у выбора — выбранный вариант (или первый), у текста — очищенный ввод владельца. */
const fieldValue = (field: FixField, values: Readonly<Record<string, string>>): string => (field.options !== undefined ? (chosen(field, values)?.value ?? '') : clean(values[field.key] ?? ''));

/** Параметры, которые задают выбранные варианты (формат расширения, множитель апскейла). */
export function choiceParams(recipe: FixRecipe, values: Readonly<Record<string, string>>): Record<string, ParamValue> {
  return Object.assign({}, ...recipe.fields.map((field) => chosen(field, values)?.params ?? {})) as Record<string, ParamValue>;
}

/** Промпт правки из шаблона. Незаполненные обязательные поля — сообщения по-русски, промпт не отдаётся. */
export function fillFix(recipe: FixRecipe, values: Readonly<Record<string, string>>): { prompt: string; problems: string[] } {
  const filled = Object.fromEntries(recipe.fields.map((field) => [field.key, fieldValue(field, values)]));
  const problems = recipe.fields.filter((field) => field.required && filled[field.key] === '').map((field) => `Заполни «${field.labelRu}».`);
  const prompt = recipe.prompt
    .split('\n')
    .filter((line) => [...line.matchAll(PLACEHOLDER)].every((m) => (filled[m[1] ?? ''] ?? '') !== ''))
    .map((line) => line.replace(PLACEHOLDER, (_m, key: string) => filled[key] ?? ''))
    .join('\n')
    .trim();
  return { prompt, problems };
}

/** Параметры правки: формат и разрешение исходника, если модель их умеет, поверх — параметры рецепта. */
export const fixParams = (model: GenModel, source: GenParams, override: Readonly<Record<string, ParamValue>>): GenParams => paramsFor(model, { ...source, ...override });

/** Роли картинок правки: исходник — image 1, фото из рецепта — image 2. */
export const fixRoles = (recipe: FixRecipe): RefRole[] => (recipe.extraRef === null ? ['ref'] : ['ref', 'ref']);

/** Проверка набора рецептов (тест): модели есть и принимают картинки, параметры валидны, плейсхолдеры — поля рецепта. */
export function validateFixPack(pack: FixPack): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const recipe of pack.recipes) {
    if (ids.has(recipe.id)) problems.push(`${recipe.id}: повторяется id.`);
    ids.add(recipe.id);
    if (recipe.models.length === 0) problems.push(`${recipe.id}: нет модели.`);
    let promptless = false;
    for (const { modelId, params } of recipe.models) {
      const model = findModel(modelId);
      if (model === undefined || model.kind !== 'image') {
        problems.push(`${recipe.id}: ${modelId} — нет такой модели картинок.`);
        continue;
      }
      promptless ||= model.promptless === true;
      // Каждый вариант выбора проверяется отдельно: формат 21:9 должен существовать у каждой модели рецепта.
      const variants = recipe.fields.flatMap((field) => (field.options ?? []).map((option) => ({ [field.key]: option.value })));
      for (const values of variants.length > 0 ? variants : [{}]) {
        const text = Object.fromEntries(recipe.fields.filter((f) => f.options === undefined).map((f) => [f.key, 'x']));
        const merged = { ...params, ...choiceParams(recipe, { ...text, ...values }) };
        const full = paramsFor(model, { sourceSize: 1024, ...merged });
        for (const [key, value] of Object.entries(merged)) if (full[key] !== value) problems.push(`${recipe.id}: ${modelId} не принимает ${key}=${String(value)}.`);
        problems.push(...validateGen(model, fillFix(recipe, { ...text, ...values }).prompt, full, fixRoles(recipe)).map((p) => `${recipe.id} / ${modelId}: ${p}`));
      }
    }
    const keys = new Set(recipe.fields.map((field) => field.key));
    for (const m of recipe.prompt.matchAll(PLACEHOLDER)) if (!keys.has(m[1] ?? '')) problems.push(`${recipe.id}: {{${m[1] ?? ''}}} — нет такого поля.`);
    if (recipe.extraRef !== null && !recipe.prompt.includes('image 2')) problems.push(`${recipe.id}: вторая картинка не названа в промпте (image 2).`);
    if (!promptless && !recipe.prompt.includes('image 1')) problems.push(`${recipe.id}: исходник не назван в промпте (image 1).`);
  }
  return problems;
}
