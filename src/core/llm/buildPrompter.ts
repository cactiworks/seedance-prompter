import { findModel, paramsFor, type GenModel, type GenParams, type MediaKind, type ParamDef, type ParamValue, type RefRole } from '../gen/models.ts';

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
  /** Какие картинки владельца уходят в модель и в какой роли — в этом порядке их ставит «В студию». */
  refs: { index: number; role: RefRole }[];
}

export interface PrompterStyle {
  id: string;
  name: string;
}

/**
 * Зачем владелец прикрепил картинку. Агенту это смысл («это я», «взять только свет»), модели — роль ref / start / end:
 * start и end — кадры видео, остальные уходят референсами с номером.
 */
export const PROMPTER_REF_ROLES = ['character', 'style', 'location', 'object', 'other', 'start', 'end'] as const;
export type PrompterRefRole = (typeof PROMPTER_REF_ROLES)[number];
export const PROMPTER_REF_ROLE_RU: Record<PrompterRefRole, string> = { character: 'Персонаж', style: 'Стиль', location: 'Локация', object: 'Предмет', other: 'Референс', start: 'Первый кадр', end: 'Последний кадр' };
export const PROMPTER_MAX_REFS = 8;

export interface PrompterRef {
  role: PrompterRefRole;
  commentRu: string;
}

/**
 * Секции формы, как в «Кадрах»: как снято, место и свет, текст в кадре. Всё по-русски и необязательно;
 * пустое поле — решает агент.
 */
export interface PrompterShot {
  /** '' — формат выбирает агент по идее. */
  aspectRatio: string;
  /** Комплект камеры из packs/cinema-doc/kits, 'custom' — своими словами, '' — агент решает. */
  cameraKitId: string;
  cameraRu: string;
  placeRu: string;
  lightRu: string;
  /** Надпись в кадре (картинка) или реплика (видео) — попадает в промпт буква в букву. */
  textRu: string;
}

export const EMPTY_SHOT: PrompterShot = { aspectRatio: '', cameraKitId: '', cameraRu: '', placeRu: '', lightRu: '', textRu: '' };

/** Комплект камеры, раскрытый сервером: английский характер картинки из pack «Кадров». */
export interface PrompterCamera {
  titleRu: string;
  anchor: string;
  look: string;
}

/** Шаблон повторяющейся задачи (packs/prompter/templates.json): раскладка, формат, маршрут, что назвать в промпте. */
export interface PrompterTemplate {
  id: string;
  titleRu: string;
  kind: MediaKind;
  noteRu: string;
  aspectRatio: string;
  /** Слова, без которых раскладка не собрана; «profile|side» — любое из. */
  mustMention: string[];
  instructions: string;
}

export interface PrompterRequest {
  ideaRu: string;
  kind: MediaKind;
  /** 'auto' — модель выбирает агент; иначе id модели, выбранной владельцем. */
  modelId: string;
  /** id шаблона; '' или нет — свободная задача. */
  template?: string;
  /** Картинки владельца в его порядке; сами картинки идут агенту вложениями в том же порядке. */
  refs?: PrompterRef[];
  shot?: PrompterShot;
  commentRu?: string;
  previous?: { modelId: string; prompt: string; params: GenParams; styleName: string };
}

/** Как картинка владельца доходит до модели: номером в промпте (`n`), кадром видео или только словами (`sentAs: null`). */
export interface RefRoute {
  index: number;
  role: PrompterRefRole;
  sentAs: RefRole | null;
  n: number | null;
}

/**
 * Какие картинки получит модель — детерминированно, агент это не выбирает, а получает готовым: номер в промпте
 * должен совпасть с порядком картинок в задаче. Soul 2 принимает один reference; Kling — только кадры;
 * у Seedance кадры и референсы не смешиваются (есть кадр — референсы описываются словами); финальный кадр
 * без стартового модель не примет. Сверх лимита модели — словами.
 */
export function routeRefs(model: GenModel, refs: readonly PrompterRef[]): RefRoute[] {
  const accepts = (role: RefRole): boolean => model.refs.roles.includes(role);
  // Кадры уходят, только если есть стартовый: финальный без него не принимается.
  const hasStart = accepts('start') && refs.some((r) => r.role === 'start');
  let total = 0;
  let n = 0;
  const used = new Set<RefRole>();
  return refs.map((ref, index) => {
    const words: RefRoute = { index, role: ref.role, sentAs: null, n: null };
    if (total >= model.refs.max) return words;
    if (ref.role === 'start' || ref.role === 'end') {
      if (!accepts(ref.role) || used.has(ref.role) || (ref.role === 'end' && !hasStart)) return words;
      used.add(ref.role);
      total += 1;
      return { index, role: ref.role, sentAs: ref.role, n: null };
    }
    if (!accepts('ref') || (model.refs.framesExclusive === true && hasStart)) return words;
    total += 1;
    n += 1;
    return { index, role: ref.role, sentAs: 'ref', n };
  });
}

const refLabel = (model: GenModel, n: number): string => (model.promptRefs === 'at-image' ? `@Image${n}` : `image ${n}`);

function routeText(model: GenModel, route: RefRoute): string {
  if (route.sentAs === 'ref' && route.n !== null) return `sent — call it ${refLabel(model, route.n)} in the prompt`;
  if (route.sentAs === 'start') return 'sent as the first frame — describe what happens from it, no number';
  if (route.sentAs === 'end') return 'sent as the last frame — the clip lands on it, no number';
  return 'NOT sent to this model — carry what matters from it in words';
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

/** Текст владельца без внешних кавычек: «Привет» и "Привет" — одна и та же надпись. */
export const ownerText = (shot: PrompterShot): string =>
  shot.textRu
    .trim()
    .replace(/^["«“]+|["»”]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ');

/** Только заполненное: пустые поля агенту не показываем, чтобы он не придумывал к ним ответ. */
function shotInput(shot: PrompterShot | undefined, camera: PrompterCamera | null, kind: MediaKind): Record<string, unknown> | null {
  if (shot === undefined) return null;
  const out: Record<string, unknown> = {};
  if (shot.aspectRatio !== '') out.aspectRatio = shot.aspectRatio;
  if (camera !== null) out.camera = { kit: camera.titleRu, anchor: camera.anchor, look: camera.look };
  else if (shot.cameraKitId === 'custom' && shot.cameraRu.trim() !== '') out.cameraRu = shot.cameraRu.trim();
  if (shot.placeRu.trim() !== '') out.placeRu = shot.placeRu.trim();
  if (shot.lightRu.trim() !== '') out.lightRu = shot.lightRu.trim();
  if (ownerText(shot) !== '') out[kind === 'image' ? 'textInImage' : 'spokenLine'] = ownerText(shot);
  return Object.keys(out).length === 0 ? null : out;
}

export function buildPrompterUser(request: PrompterRequest, candidates: readonly GenModel[], styles: readonly PrompterStyle[], camera: PrompterCamera | null = null, template: PrompterTemplate | null = null): string {
  const refs = request.refs ?? [];
  const shot = shotInput(request.shot, camera, request.kind);
  const input = {
    ideaRu: request.ideaRu.trim(),
    kind: request.kind,
    mode: request.modelId === 'auto' ? 'auto' : 'fixed',
    ...(template !== null ? { template: { title: template.titleRu, instructions: template.instructions } } : {}),
    ...(shot !== null ? { shot } : {}),
    ...(refs.length > 0 ? { refs: refs.map((ref, i) => ({ ref: i + 1, role: ref.role, commentRu: ref.commentRu.trim() })) } : {}),
    candidates: candidates.map((model) => ({
      id: model.id,
      title: model.titleRu,
      maxPromptChars: model.maxPromptChars,
      params: agentParams(model).map(describeParam),
      moodboards: hasStyles(model),
      ...(refs.length > 0 ? { images: routeRefs(model, refs).map((route) => ({ ref: route.index + 1, how: routeText(model, route) })) } : {}),
    })),
    styleOptions: candidates.some(hasStyles) ? styles.map((style) => style.name) : [],
    ...(request.previous !== undefined ? { previous: request.previous, commentRu: request.commentRu?.trim() ?? '' } : {}),
  };
  const task = request.previous !== undefined ? 'Rewrite the previous prompt following the comment.' : 'Write the prompt for this idea.';
  const attached = refs.length > 0 ? `\n\nThe owner's ${refs.length} reference image(s) are attached after this message in the order of \`refs\`: the first image is ref 1.` : '';
  return `${task}${attached}\n\n\`\`\`json\n${JSON.stringify(input, null, 1)}\n\`\`\``;
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
const aspectOptions = (model: GenModel): readonly string[] => model.params.find((d) => d.key === 'aspectRatio')?.options ?? [];

export function normalizePrompter(output: PrompterOutput, styles: readonly PrompterStyle[], refs: readonly PrompterRef[] = [], shot: PrompterShot = EMPTY_SHOT): PrompterResult | null {
  const model = findModel(output.modelId.trim());
  if (model === undefined) return null;
  const given: GenParams = {};
  for (const item of output.params) {
    const def = agentParams(model).find((d) => d.key === item.key);
    const value = def === undefined ? undefined : coerce(def, item.value);
    if (def !== undefined && value !== undefined) given[def.key] = value;
  }
  // Формат, выбранный владельцем, главнее выбора агента — если модель его умеет.
  if (shot.aspectRatio !== '' && aspectOptions(model).includes(shot.aspectRatio)) given.aspectRatio = shot.aspectRatio;
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
    refs: routeRefs(model, refs).flatMap((route) => (route.sentAs === null ? [] : [{ index: route.index, role: route.sentAs }])),
  };
}

/** «2, 3 and 5» → [2, 3, 5]; «2–5» / «2 to 5» → [2, 3, 4, 5]. */
function expandNumbers(list: string): number[] {
  const out: number[] = [];
  for (const part of list.split(/\s*(?:,|\band\b|&)\s*/i)) {
    const range = /^(\d+)\s*(?:[-–—]|to)\s*(\d+)$/i.exec(part.trim());
    if (range !== null) for (let n = Number(range[1]); n <= Number(range[2]) && n - Number(range[1]) < 50; n += 1) out.push(n);
    else if (/^\d+$/.test(part.trim())) out.push(Number(part.trim()));
  }
  return out;
}

/** Номера картинок, которые упомянуты в промпте, и в какой записи: `@Image2` или «image 2» / «images 2–5». */
function mentionedImages(prompt: string): { at: number[]; plain: number[] } {
  const at = [...prompt.matchAll(/@image\s?(\d+)/gi)].map((m) => Number(m[1]));
  // \b после числа: «image 1, 35mm lens» — 35 не номер картинки; больше 30 картинок модели не берут.
  const plain = [...prompt.replace(/@image\s?\d+/gi, '').matchAll(/\bimages?\s(\d+\b(?:\s*(?:,|\band\b|&|[-–—]|\bto\b)\s*\d+\b)*)/gi)].flatMap((m) => expandNumbers(m[1] ?? '')).filter((n) => n >= 1 && n <= 30);
  return { at, plain };
}

const CYRILLIC = /[Ѐ-ӿ]/u;
/** Текст в кадре по-русски разрешён только в кавычках: "…", «…», “…”. */
const QUOTED = /"[^"]*"|«[^»]*»|“[^”]*”/g;
const SOUL_MAX_WORDS = 200;
/** «no buildings», «without text»: у Soul 2 нет negative prompt, отрицание в тексте тянет предмет в кадр. */
const SOUL_NEGATIVE = /\b(no|without|avoid|never|don't)\s+[\w-]+/i;

/** Проверки ответа — по-английски, они уходят агенту в ремонтный круг. */
export function validatePrompter(output: PrompterOutput, candidates: readonly GenModel[], styles: readonly PrompterStyle[], refs: readonly PrompterRef[] = [], shot: PrompterShot = EMPTY_SHOT, template: PrompterTemplate | null = null): string[] {
  const problems: string[] = [];
  const model = candidates.find((m) => m.id === output.modelId.trim());
  if (model === undefined) return [`modelId must be one of: ${candidates.map((m) => m.id).join(', ')}.`];

  const prompt = output.prompt.trim();
  if (prompt === '') problems.push('prompt is empty.');
  if (prompt.length > model.maxPromptChars) problems.push(`prompt is ${prompt.length} characters; ${model.id} accepts at most ${model.maxPromptChars}.`);
  if (CYRILLIC.test(prompt.replace(QUOTED, ''))) problems.push('prompt: English only; Russian is allowed only for text that must appear in the image, inside double quotes.');
  const sent = routeRefs(model, refs).filter((route) => route.sentAs === 'ref');
  const { at, plain } = mentionedImages(prompt);
  const mentioned = new Set([...at, ...plain]);
  if (sent.length === 0 && mentioned.size > 0) problems.push(`prompt refers to input images, but no images reach ${model.id} — describe what matters in words.`);
  else {
    for (const n of mentioned) if (!sent.some((route) => route.n === n)) problems.push(`prompt mentions image ${n}, but ${model.id} receives only ${sent.map((route) => refLabel(model, route.n ?? 0)).join(', ')}.`);
    for (const route of sent) if (!mentioned.has(route.n ?? 0)) problems.push(`${refLabel(model, route.n ?? 0)} (ref ${route.index + 1}, ${route.role}) is sent to the model, but the prompt never says what it is for — name it and its purpose.`);
    if (model.promptRefs === 'at-image' && plain.length > 0) problems.push(`${model.id} refers to images as @Image1, @Image2 — not "image 1".`);
  }
  if (template !== null) {
    const lower = prompt.toLowerCase();
    const missing = template.mustMention.filter((alternatives) => !alternatives.split('|').some((word) => lower.includes(word)));
    if (missing.length > 0) problems.push(`template "${template.titleRu}": the layout is incomplete — the prompt must name these views: ${missing.map((m) => m.replace('|', ' or ')).join(', ')}.`);
  }
  // Надпись и реплика — буква в букву, как реплики в «Кадрах». Soul 2 текст не рисует: его в промпт не несём.
  const text = ownerText(shot);
  if (text !== '' && model.id !== 'higgsfield/soul-2' && !prompt.replace(/\s+/g, ' ').includes(text)) problems.push(`prompt must contain the owner's ${model.kind === 'image' ? 'text' : 'spoken line'} exactly, letter for letter, inside quotes: "${text}".`);
  if (shot.aspectRatio !== '' && aspectOptions(model).includes(shot.aspectRatio)) {
    const given = output.params.find((item) => item.key === 'aspectRatio')?.value.trim();
    if (given !== undefined && given !== shot.aspectRatio) problems.push(`params.aspectRatio: the owner chose ${shot.aspectRatio}.`);
  }
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
