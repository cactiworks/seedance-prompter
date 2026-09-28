import { findModel, paramsFor, type GenModel, type GenParams, type MediaKind, type ParamDef, type ParamValue } from '../gen/models.ts';

/**
 * Промптер (решение 28): идея по-русски → промпт под одну модель, её параметры, мудборд и слабые места.
 * Знания — данные в packs/prompter/ (системный промпт, таблица «задача → модель», карточка на модель);
 * здесь — вход агента, схема ответа и проверки, по которым сервер отправляет ответ на один ремонтный круг.
 */

const TEXT = { type: 'string' } as const;

export const PROMPTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['modelId', 'reasonRu', 'prompt', 'params', 'styleName', 'weakSpotsRu', 'alternativesRu'],
  properties: {
    modelId: TEXT,
    reasonRu: TEXT,
    prompt: TEXT,
    params: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'value'], properties: { key: TEXT, value: TEXT } } },
    styleName: TEXT,
    weakSpotsRu: { type: 'array', items: TEXT },
    alternativesRu: TEXT,
  },
} as const;

export interface PrompterOutput {
  modelId: string;
  reasonRu: string;
  prompt: string;
  params: { key: string; value: string }[];
  styleName: string;
  weakSpotsRu: string[];
  alternativesRu: string;
}

/** Готовый результат для интерфейса: параметры уже в типах модели, мудборд — id из каталога провайдера. */
export interface PrompterResult {
  modelId: string;
  reasonRu: string;
  prompt: string;
  params: GenParams;
  styleName: string;
  weakSpotsRu: string[];
  alternativesRu: string;
}

export interface PrompterStyle {
  id: string;
  name: string;
}

export interface PrompterRequest {
  ideaRu: string;
  kind: MediaKind;
  /** 'auto' — модель выбирает агент; иначе id модели, выбранной владельцем. */
  modelId: string;
  commentRu?: string;
  previous?: { modelId: string; prompt: string; params: GenParams; styleName: string };
}

/**
 * Параметры, которые агент не выбирает: seed, Soul ID и улучшение промпта — решения владельца, мудборд идёт
 * отдельным полем по имени.
 */
const OWNER_ONLY = new Set(['seed', 'soulId', 'enhancePrompt', 'styleId']);

export const agentParams = (model: GenModel): ParamDef[] => model.params.filter((def) => !OWNER_ONLY.has(def.key) && (def.type === 'enum' || def.type === 'int' || def.type === 'bool'));
export const hasStyles = (model: GenModel): boolean => model.params.some((def) => def.type === 'style');

/** Файл карточки модели в packs/prompter/models/: `kie/gpt-image-2-5` → `kie--gpt-image-2-5.md`. */
export const cardFile = (modelId: string): string => `${modelId.replace('/', '--')}.md`;

export function buildPrompterSystem(system: string, routing: string, cards: { modelId: string; text: string }[]): string {
  return [system.trim(), routing.trim(), '# Model cards', ...cards.map((card) => card.text.trim())].join('\n\n');
}

function describeParam(def: ParamDef): Record<string, unknown> {
  if (def.type === 'enum') return { key: def.key, options: def.options ?? [], default: def.default };
  if (def.type === 'int') return { key: def.key, min: def.min, max: def.max, default: def.default };
  return { key: def.key, options: ['true', 'false'], default: String(def.default) };
}

export function buildPrompterUser(request: PrompterRequest, candidates: readonly GenModel[], styles: readonly PrompterStyle[]): string {
  const input = {
    ideaRu: request.ideaRu.trim(),
    kind: request.kind,
    mode: request.modelId === 'auto' ? 'auto' : 'fixed',
    candidates: candidates.map((model) => ({ id: model.id, title: model.titleRu, maxPromptChars: model.maxPromptChars, params: agentParams(model).map(describeParam), moodboards: hasStyles(model) })),
    styleOptions: candidates.some(hasStyles) ? styles.map((style) => style.name) : [],
    ...(request.previous !== undefined ? { previous: request.previous, commentRu: request.commentRu?.trim() ?? '' } : {}),
  };
  const task = request.previous !== undefined ? 'Rewrite the previous prompt following the comment.' : 'Write the prompt for this idea.';
  return `${task}\n\n\`\`\`json\n${JSON.stringify(input, null, 1)}\n\`\`\``;
}

function coerce(def: ParamDef, raw: string): ParamValue | undefined {
  const value = raw.trim();
  if (def.type === 'enum') return (def.options ?? []).find((option) => option.toLowerCase() === value.toLowerCase());
  if (def.type === 'int') {
    const n = Number(value.replace(/\s*(s|sec|seconds|с)$/i, ''));
    return Number.isInteger(n) && n >= (def.min ?? -Infinity) && n <= (def.max ?? Infinity) ? n : undefined;
  }
  if (def.type === 'bool') return value === 'true' ? true : value === 'false' ? false : undefined;
  return undefined;
}

const findStyle = (styles: readonly PrompterStyle[], name: string): PrompterStyle | undefined => styles.find((style) => style.name.toLowerCase() === name.trim().toLowerCase());

/** Ответ агента → результат для формы. Невалидные значения заменяются умолчаниями модели; проверка их всё равно называет. */
export function normalizePrompter(output: PrompterOutput, styles: readonly PrompterStyle[]): PrompterResult | null {
  const model = findModel(output.modelId.trim());
  if (model === undefined) return null;
  const given: GenParams = {};
  for (const item of output.params) {
    const def = agentParams(model).find((d) => d.key === item.key);
    const value = def === undefined ? undefined : coerce(def, item.value);
    if (def !== undefined && value !== undefined) given[def.key] = value;
  }
  const style = hasStyles(model) ? findStyle(styles, output.styleName) : undefined;
  if (style !== undefined) given.styleId = style.id;
  return {
    modelId: model.id,
    reasonRu: output.reasonRu.trim(),
    prompt: output.prompt.trim(),
    params: paramsFor(model, given),
    styleName: style?.name ?? '',
    weakSpotsRu: output.weakSpotsRu.map((spot) => spot.trim()).filter((spot) => spot !== ''),
    alternativesRu: output.alternativesRu.trim(),
  };
}

const CYRILLIC = /[Ѐ-ӿ]/u;
/** Текст в кадре по-русски разрешён только в кавычках: "…", «…», “…”. */
const QUOTED = /"[^"]*"|«[^»]*»|“[^”]*”/g;
const IMAGE_REF = /@image\s?\d|\bimages?\s\d\b/i;
const SOUL_MAX_WORDS = 200;
/** «no buildings», «without text»: у Soul 2 нет negative prompt, отрицание в тексте тянет предмет в кадр. */
const SOUL_NEGATIVE = /\b(no|without|avoid|never|don't)\s+[\w-]+/i;

/** Проверки ответа — по-английски, они уходят агенту в ремонтный круг. */
export function validatePrompter(output: PrompterOutput, candidates: readonly GenModel[], styles: readonly PrompterStyle[]): string[] {
  const problems: string[] = [];
  const model = candidates.find((m) => m.id === output.modelId.trim());
  if (model === undefined) return [`modelId must be one of: ${candidates.map((m) => m.id).join(', ')}.`];

  const prompt = output.prompt.trim();
  if (prompt === '') problems.push('prompt is empty.');
  if (prompt.length > model.maxPromptChars) problems.push(`prompt is ${prompt.length} characters; ${model.id} accepts at most ${model.maxPromptChars}.`);
  if (CYRILLIC.test(prompt.replace(QUOTED, ''))) problems.push('prompt: English only; Russian is allowed only for text that must appear in the image, inside double quotes.');
  if (IMAGE_REF.test(prompt)) problems.push('prompt refers to input images, but no images are attached — describe the subject in words.');
  if (model.id === 'higgsfield/soul-2') {
    const words = prompt.split(/\s+/).filter(Boolean).length;
    if (words > SOUL_MAX_WORDS) problems.push(`prompt has ${words} words; Soul 2 distorts long prompts — keep it under ${SOUL_MAX_WORDS} words.`);
    const negative = prompt.match(SOUL_NEGATIVE);
    if (negative !== null) problems.push(`prompt: Soul 2 has no negative prompt — "${negative[0]}" can pull the absent thing in; describe what is in the frame instead.`);
  }

  const defs = agentParams(model);
  const seen = new Set<string>();
  for (const item of output.params) {
    const def = defs.find((d) => d.key === item.key);
    if (def === undefined) problems.push(`params: "${item.key}" is not a parameter you set for ${model.id} (allowed: ${defs.map((d) => d.key).join(', ')}).`);
    else if (coerce(def, item.value) === undefined) problems.push(`params.${item.key}: "${item.value}" is not allowed${def.options !== undefined ? ` (options: ${def.options.join(', ')})` : def.type === 'int' ? ` (integer ${def.min ?? ''}–${def.max ?? ''})` : ' (true or false)'}.`);
    if (seen.has(item.key)) problems.push(`params: "${item.key}" is given twice.`);
    seen.add(item.key);
  }

  const styleName = output.styleName.trim();
  if (styleName !== '' && !hasStyles(model)) problems.push(`styleName: ${model.id} has no moodboards — leave it empty.`);
  else if (styleName !== '' && findStyle(styles, styleName) === undefined) problems.push(`styleName: "${styleName}" is not in styleOptions — use an exact name or leave it empty.`);

  if (!CYRILLIC.test(output.reasonRu)) problems.push('reasonRu: write it in Russian.');
  if (output.weakSpotsRu.length > 4) problems.push(`weakSpotsRu: ${output.weakSpotsRu.length} points; at most 4 that apply to this idea.`);
  if (output.weakSpotsRu.some((spot) => spot.trim() !== '' && !CYRILLIC.test(spot))) problems.push('weakSpotsRu: write them in Russian.');
  return problems;
}
