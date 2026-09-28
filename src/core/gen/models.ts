/**
 * Каталог моделей генерации — один источник для формы, оценки цены, проверки до отправки и тела запроса.
 * Форма студии и canvas строятся из `params` и `refs`, сервер сверяет по ним же — расхождения «в форме
 * можно, в API нельзя» быть не может. Набор моделей — выбор владельца 27.09.2026: GPT Image 2.5,
 * Seedream 5 Pro, Kling 3.0, Seedance 2.5 (KIE) и Soul 2 (официальный API Higgsfield).
 * Схемы и цены сверены 27.09.2026 — docs/research/kie-models.md. Цена здесь — оценка для гейта;
 * фактическое списание приходит от провайдера и пишется в задачу.
 */

export type ProviderId = 'kie' | 'higgsfield';
export type MediaKind = 'image' | 'video';
export type ParamValue = string | number | boolean;
export type GenParams = Record<string, ParamValue>;

/** Общие ключи: resolution, aspectRatio, durationSec, audio. Остальные — свои у модели. */
export interface ParamDef {
  key: string;
  labelRu: string;
  type: 'enum' | 'int' | 'bool' | 'text';
  options?: readonly string[];
  /** Подписи вариантов, если значение само по себе непонятно (std → «Стандарт · 720p»). */
  optionLabelsRu?: Readonly<Record<string, string>>;
  min?: number;
  max?: number;
  /** Для text: чем должно быть непустое значение. */
  pattern?: RegExp;
  hintRu?: string;
  default: ParamValue;
}

/** ref — референс; start / end — первый и последний кадр видео. */
export type RefRole = 'ref' | 'start' | 'end';
export const REF_ROLE_RU: Record<RefRole, string> = { ref: 'Реф', start: 'Старт', end: 'Финал' };

export interface RefSpec {
  /** Всего картинок. 0 — модель без входных картинок. */
  max: number;
  roles: readonly RefRole[];
  /** Кадры (start/end) и референсы нельзя смешивать в одной задаче. */
  framesExclusive?: boolean;
}

export interface SentRef {
  url: string;
  role: RefRole;
}

export interface GenModel {
  /** Внутренний id: `<провайдер>/<модель>`. */
  id: string;
  provider: ProviderId;
  kind: MediaKind;
  titleRu: string;
  /** Короткая подсказка в выборе модели. */
  noteRu: string;
  maxPromptChars: number;
  params: readonly ParamDef[];
  refs: RefSpec;
  /** Как модель понимает ссылки на картинки в тексте: `@Image1` или «image 1». */
  promptRefs: 'at-image' | 'image-n';
  /** Цена одной задачи в единицах провайдера (у KIE — кредиты, у Higgsfield API — доллары). */
  credits: (p: GenParams, refCount: number) => number;
  /** id модели у провайдера; может зависеть от входов (text-to-image → image-to-image). */
  target: (p: GenParams, roles: readonly RefRole[]) => string;
  /** Тело запроса. Промпт уже в диалекте провайдера (`forProvider`). */
  input: (prompt: string, p: GenParams, refs: readonly SentRef[]) => Record<string, unknown>;
}

/** Сколько стоит единица провайдера в долларах и как её писать. */
export const UNIT: Record<ProviderId, { usd: number; labelRu: string }> = { kie: { usd: 0.005, labelRu: 'кр' }, higgsfield: { usd: 1, labelRu: '$' } };

// ——— общие определения параметров ———

const enumParam = (key: string, labelRu: string, options: readonly string[], def: string, optionLabelsRu?: Record<string, string>): ParamDef => ({ key, labelRu, type: 'enum', options, default: def, optionLabelsRu });
const resolution = (options: readonly string[], def: string, labels?: Record<string, string>): ParamDef => enumParam('resolution', 'Разрешение', options, def, labels);
const aspect = (options: readonly string[], def: string): ParamDef => enumParam('aspectRatio', 'Формат', options, def);
const duration = (min: number, max: number, def: number): ParamDef => ({ key: 'durationSec', labelRu: 'Длительность', type: 'int', min, max, default: def });
const audio = (def: boolean): ParamDef => ({ key: 'audio', labelRu: 'Звук', type: 'bool', default: def });

const str = (p: GenParams, key: string): string => String(p[key]);
const num = (p: GenParams, key: string): number => Number(p[key]);
const priceOf = (table: Record<string, number>, key: string): number => {
  const value = table[key];
  if (value === undefined) throw new Error(`Нет цены для «${key}».`);
  return value;
};
const urls = (refs: readonly SentRef[], role: RefRole): string[] => refs.filter((r) => r.role === role).map((r) => r.url);
const withRefs = (roles: readonly RefRole[]): boolean => roles.length > 0;

/** Seedance: кадры (first/last) или референсы — взаимоисключающие режимы входа. */
function seedanceMedia(refs: readonly SentRef[]): Record<string, unknown> {
  const [start] = urls(refs, 'start');
  const [end] = urls(refs, 'end');
  const references = urls(refs, 'ref');
  return {
    ...(start !== undefined ? { first_frame_url: start } : {}),
    ...(end !== undefined ? { last_frame_url: end } : {}),
    ...(references.length > 0 ? { reference_image_urls: references } : {}),
  };
}

const KLING_RATE: Record<string, [number, number]> = { std: [14, 20], pro: [18, 27], '4K': [67, 67] };

// ——— модели ———

export const GEN_MODELS: readonly GenModel[] = [
  {
    id: 'higgsfield/soul-2',
    provider: 'higgsfield',
    kind: 'image',
    titleRu: 'Soul 2',
    noteRu: 'Higgsfield API · фотореализм, Soul ID',
    maxPromptChars: 5_000,
    params: [
      resolution(['720p', '1080p'], '1080p'),
      aspect(['9:16', '3:4', '2:3', '1:1', '4:3', '3:2', '16:9'], '9:16'),
      { key: 'soulId', labelRu: 'Soul ID', type: 'text', default: '', pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, hintRu: 'UUID персонажа из аккаунта API (обучается там же, model_version v2). Пусто — без персонажа.' },
      { key: 'enhancePrompt', labelRu: 'Улучшать промпт', type: 'bool', default: false },
    ],
    refs: { max: 0, roles: [] },
    promptRefs: 'image-n',
    // POST /estimate на аккаунте владельца, 27.09.2026: 720p — $0.004, 1080p — $0.006 (формат и enhance_prompt
    // на цену не влияют, batch_size 4 — ×4). Страница модели пишет $0.0032 / $0.0057 — это без округления вверх.
    credits: (p) => priceOf({ '720p': 0.004, '1080p': 0.006 }, str(p, 'resolution')),
    target: () => 'higgsfield-ai/soul/v2/standard',
    // Seed не передаём: явный null API не принимает. Поля с расходящимися умолчаниями — явно.
    input: (prompt, p) => ({
      prompt,
      aspect_ratio: str(p, 'aspectRatio'),
      resolution: str(p, 'resolution'),
      enhance_prompt: p.enhancePrompt === true,
      batch_size: 1,
      ...(str(p, 'soulId') !== '' ? { custom_reference_id: str(p, 'soulId'), custom_reference_strength: 1 } : {}),
    }),
  },
  {
    id: 'kie/gpt-image-2-5',
    provider: 'kie',
    kind: 'image',
    titleRu: 'GPT Image 2.5',
    noteRu: 'OpenAI · текст на картинке, правка по 16 рефам',
    maxPromptChars: 20_000,
    params: [
      enumParam('variant', 'Вариант', ['flare', 'sunburst'], 'flare', { flare: 'Flare · быстрее', sunburst: 'Sunburst · тщательнее' }),
      resolution(['1K', '2K', '4K'], '1K'),
      aspect(['9:16', '3:4', '2:3', '1:1', '4:3', '3:2', '16:9', '21:9'], '9:16'),
      enumParam('background', 'Фон', ['auto', 'opaque', 'transparent'], 'auto', { auto: 'Авто', opaque: 'Сплошной', transparent: 'Прозрачный' }),
    ],
    refs: { max: 16, roles: ['ref'] },
    promptRefs: 'image-n',
    credits: (p) => priceOf({ '1K': 6, '2K': 10, '4K': 16 }, str(p, 'resolution')),
    target: (p, roles) => `gpt-image-2-5-${str(p, 'variant')}-${withRefs(roles) ? 'image' : 'text'}-to-image`,
    input: (prompt, p, refs) => ({
      prompt,
      aspect_ratio: str(p, 'aspectRatio'),
      resolution: str(p, 'resolution'),
      background: str(p, 'background'),
      ...(refs.length > 0 ? { input_urls: urls(refs, 'ref') } : {}),
    }),
  },
  {
    id: 'kie/seedream-5-pro',
    provider: 'kie',
    kind: 'image',
    titleRu: 'Seedream 5 Pro',
    noteRu: 'ByteDance · до 10 рефов, 1K / 2K',
    maxPromptChars: 5_000,
    params: [resolution(['1K', '2K'], '2K'), aspect(['9:16', '3:4', '2:3', '1:1', '4:3', '3:2', '16:9', '21:9'], '9:16')],
    refs: { max: 10, roles: ['ref'] },
    promptRefs: 'image-n',
    // Каждая входная картинка после первой — +0.5 кр.
    credits: (p, refCount) => priceOf({ '1K': 7, '2K': 14 }, str(p, 'resolution')) + 0.5 * Math.max(0, refCount - 1),
    target: (_p, roles) => `seedream/5-pro-${withRefs(roles) ? 'image' : 'text'}-to-image`,
    input: (prompt, p, refs) => ({
      prompt,
      aspect_ratio: str(p, 'aspectRatio'),
      quality: str(p, 'resolution') === '1K' ? 'basic' : 'high',
      output_format: 'png',
      ...(refs.length > 0 ? { image_urls: urls(refs, 'ref') } : {}),
    }),
  },
  {
    id: 'kie/kling-3',
    provider: 'kie',
    kind: 'video',
    titleRu: 'Kling 3.0',
    noteRu: 'Kuaishou · 3–15 с, старт / финал-кадр, звук',
    maxPromptChars: 2_500,
    params: [
      enumParam('mode', 'Режим', ['std', 'pro', '4K'], 'std', { std: 'Стандарт · 720p', pro: 'Pro · 1080p', '4K': '4K' }),
      aspect(['9:16', '1:1', '16:9'], '9:16'),
      duration(3, 15, 5),
      audio(false),
    ],
    refs: { max: 2, roles: ['start', 'end'] },
    promptRefs: 'image-n',
    credits: (p) => (KLING_RATE[str(p, 'mode')] ?? [0, 0])[p.audio === true ? 1 : 0] * num(p, 'durationSec'),
    target: () => 'kling-3.0/video',
    // Умолчания доки и Playground расходятся — mode, sound и aspect_ratio передаём всегда. duration — строкой.
    input: (prompt, p, refs) => {
      const frames = [...urls(refs, 'start'), ...urls(refs, 'end')];
      return { prompt, mode: str(p, 'mode'), aspect_ratio: str(p, 'aspectRatio'), duration: String(num(p, 'durationSec')), sound: p.audio === true, multi_shots: false, ...(frames.length > 0 ? { image_urls: frames } : {}) };
    },
  },
  {
    id: 'kie/seedance-2-5',
    provider: 'kie',
    kind: 'video',
    titleRu: 'Seedance 2.5',
    noteRu: 'ByteDance · до 30 с, звук · кадры или до 30 рефов',
    maxPromptChars: 30_000,
    params: [resolution(['480p', '720p', '1080p'], '720p'), aspect(['9:16', '3:4', '1:1', '4:3', '16:9', '21:9'], '9:16'), duration(4, 30, 5), audio(true)],
    refs: { max: 30, roles: ['ref', 'start', 'end'], framesExclusive: true },
    promptRefs: 'at-image',
    // Кредиты в секунду без входного видео (видео-рефы пока не поддержаны); звук на цену не влияет.
    credits: (p) => priceOf({ '480p': 28, '720p': 63, '1080p': 158 }, str(p, 'resolution')) * num(p, 'durationSec'),
    target: () => 'bytedance/seedance-2-5',
    input: (prompt, p, refs) => ({ prompt, resolution: str(p, 'resolution'), aspect_ratio: str(p, 'aspectRatio'), duration: num(p, 'durationSec'), generate_audio: p.audio === true, ...seedanceMedia(refs) }),
  },
];

export const findModel = (id: string): GenModel | undefined => GEN_MODELS.find((m) => m.id === id);
export const modelsOf = (kind: MediaKind): GenModel[] => GEN_MODELS.filter((m) => m.kind === kind);

const fits = (def: ParamDef, value: ParamValue | undefined): boolean =>
  value !== undefined &&
  ((def.type === 'enum' && typeof value === 'string' && (def.options ?? []).includes(value)) ||
    (def.type === 'int' && typeof value === 'number' && Number.isInteger(value) && value >= (def.min ?? -Infinity) && value <= (def.max ?? Infinity)) ||
    (def.type === 'bool' && typeof value === 'boolean') ||
    (def.type === 'text' && typeof value === 'string'));

/**
 * Параметры поверх умолчаний модели. Чужие для модели ключи отбрасываются; значения, которых у новой
 * модели нет (переключили модель в форме), заменяются на её умолчания.
 */
export function paramsFor(model: GenModel, given: Partial<GenParams>): GenParams {
  const out: GenParams = {};
  for (const def of model.params) {
    const value = given[def.key];
    out[def.key] = fits(def, value) ? (value as ParamValue) : def.default;
  }
  return out;
}

// Компилятор пишет ссылки в диалекте проекта: <<<image_N>>> или @Image N (lint/rules/refs.ts).
const ANY_REF_RE = /<<<image_(\d+)>>>|@image\s?_?(\d+)/gi;

/**
 * Промпт в диалекте модели. Seedance через KIE → fal ждёт `@Image1` без пробела, порядок URL задаёт N
 * (решение 23); остальные модели своего синтаксиса не имеют — им «image 1» словами.
 */
export function forProvider(model: GenModel, prompt: string): { prompt: string; maxRef: number } {
  let maxRef = 0;
  const rewritten = prompt.replace(ANY_REF_RE, (_m, chip: string | undefined, at: string | undefined) => {
    const n = Number(chip ?? at);
    maxRef = Math.max(maxRef, n);
    return model.promptRefs === 'at-image' ? `@Image${n}` : `image ${n}`;
  });
  return { prompt: rewritten, maxRef };
}

/** Проверки до отправки: каждая ошибка здесь — сэкономленные деньги. Сообщения по-русски. */
export function validateGen(model: GenModel, prompt: string, params: GenParams, roles: readonly RefRole[]): string[] {
  const problems: string[] = [];
  const { prompt: sent, maxRef } = forProvider(model, prompt);
  if (sent.trim() === '') problems.push('Пустой промпт.');
  if (sent.length > model.maxPromptChars) problems.push(`Промпт длиннее ${model.maxPromptChars} знаков — ${model.titleRu} его не примет.`);
  for (const def of model.params) {
    const value = params[def.key];
    if (!fits(def, value)) {
      if (def.type === 'int') problems.push(`${def.labelRu} — целое число от ${def.min ?? '…'} до ${def.max ?? '…'}.`);
      else if (def.type === 'bool') problems.push(`${def.labelRu}: нужно да или нет.`);
      else problems.push(`${def.labelRu}: «${String(value)}» недоступно для ${model.titleRu}.`);
    } else if (def.type === 'text' && def.pattern !== undefined && value !== '' && !def.pattern.test(String(value))) {
      problems.push(`${def.labelRu}: неверный формат. ${def.hintRu ?? ''}`.trim());
    }
  }

  const count = (role: RefRole): number => roles.filter((r) => r === role).length;
  if (roles.length > model.refs.max) problems.push(model.refs.max === 0 ? `${model.titleRu} не принимает картинки.` : `Картинок ${roles.length}, а ${model.titleRu} принимает не больше ${model.refs.max}.`);
  for (const role of new Set(roles)) if (!model.refs.roles.includes(role)) problems.push(`Роль «${REF_ROLE_RU[role]}» не поддерживается ${model.titleRu}.`);
  if (count('start') > 1 || count('end') > 1) problems.push('Стартовый и финальный кадр — не больше одного каждый.');
  if (count('end') > 0 && count('start') === 0) problems.push('Финальный кадр без стартового модель не примет.');
  if (model.refs.framesExclusive === true && count('ref') > 0 && count('start') + count('end') > 0) problems.push('Кадры (старт / финал) и референсы нельзя смешивать в одной задаче — выбери что-то одно.');
  if (model.promptRefs === 'at-image' && maxRef > count('ref')) problems.push(`В промпте есть ссылка на картинку ${maxRef}, а референсов прикреплено ${count('ref')}.`);
  return problems;
}

export interface Estimate {
  /** В единицах провайдера (кредиты KIE или доллары Higgsfield API). */
  credits: number;
  usd: number;
  unitRu: string;
}

const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;

export function estimate(model: GenModel, params: GenParams, count = 1, refCount = 0): Estimate {
  const unit = UNIT[model.provider];
  const credits = round(model.credits(params, refCount) * count, 4);
  return { credits, usd: round(credits * unit.usd, 4), unitRu: unit.labelRu };
}

/** «8 кр ≈ $0.04» или «$0.0057» — одна запись цены на весь интерфейс. */
export function formatCost(e: Estimate): string {
  const usd = `$${e.usd < 0.1 ? String(e.usd) : e.usd.toFixed(2)}`;
  return e.unitRu === '$' ? usd : `${e.credits} ${e.unitRu} ≈ ${usd}`;
}
