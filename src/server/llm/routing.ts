import type { Effort } from './codexCli/args.ts';

export const DEFAULT_LLM_MODEL = 'gpt-6-luna';
export const LLM_ROUTING_POLICY_VERSION = 'economical-v1';

interface Profile {
  model: string;
  effort: Effort;
  env: readonly string[];
  reason: string;
}

const extraction = 'Извлечение, перевод или ранжирование по заданной структуре.';
const vision = 'Проверка визуальных признаков и полезности изображения.';
const composition = 'Содержательная сценарная работа и согласование ограничений.';

const PROFILES = {
  fields: { model: DEFAULT_LLM_MODEL, effort: 'low', env: ['SP_FIELDS_MODEL'], reason: extraction },
  edit: { model: DEFAULT_LLM_MODEL, effort: 'low', env: ['SP_EDIT_MODEL'], reason: extraction },
  'reference-plan': { model: DEFAULT_LLM_MODEL, effort: 'low', env: ['SP_REFERENCE_MODEL'], reason: extraction },
  'reference-rank': { model: DEFAULT_LLM_MODEL, effort: 'low', env: ['SP_REFERENCE_MODEL'], reason: extraction },
  'reference-analysis': { model: DEFAULT_LLM_MODEL, effort: 'low', env: ['SP_VISION_MODEL'], reason: extraction },
  vision: { model: 'gpt-6.1-terra', effort: 'medium', env: ['SP_VISION_MODEL'], reason: vision },
  'reference-quality': { model: 'gpt-6.1-terra', effort: 'medium', env: ['SP_REFERENCE_QUALITY_MODEL', 'SP_VISION_MODEL'], reason: vision },
  'reference-dedup': { model: 'gpt-6.1-terra', effort: 'medium', env: ['SP_REFERENCE_QUALITY_MODEL', 'SP_VISION_MODEL'], reason: vision },
  appearance: { model: 'gpt-6.1-terra', effort: 'medium', env: ['SP_PRODUCTION_MODEL'], reason: vision },
  'photo-review': { model: 'gpt-6.1-terra', effort: 'medium', env: ['SP_PRODUCTION_CRITIC_MODEL'], reason: vision },
  retouch: { model: 'gpt-6.1-terra', effort: 'medium', env: ['SP_PRODUCTION_CRITIC_MODEL'], reason: vision },
  writer: { model: 'gpt-6.1-sol', effort: 'medium', env: ['SP_WRITER_MODEL'], reason: composition },
  planner: { model: 'gpt-6.1-sol', effort: 'medium', env: ['SP_WRITER_MODEL'], reason: composition },
  'text-critic': { model: 'gpt-6.1-sol', effort: 'medium', env: ['SP_CRITIC_MODEL'], reason: composition },
  prompter: { model: 'gpt-6.1-sol', effort: 'medium', env: ['SP_PROMPTER_MODEL'], reason: composition },
  'canvas-idea': { model: 'gpt-6.1-sol', effort: 'medium', env: ['SP_CANVAS_AI_MODEL'], reason: composition },
  'canvas-prompt': { model: 'gpt-6.1-sol', effort: 'medium', env: ['SP_CANVAS_AI_MODEL'], reason: composition },
  'production-director': { model: 'gpt-6.1-sol', effort: 'medium', env: ['SP_PRODUCTION_MODEL'], reason: composition },
  'production-prompts': { model: 'gpt-6.1-sol', effort: 'medium', env: ['SP_PRODUCTION_MODEL'], reason: composition },
  'series-prompter': { model: 'gpt-6.1-sol', effort: 'medium', env: ['SP_PRODUCTION_MODEL'], reason: composition },
  'series-critic': { model: 'gpt-6.1-sol', effort: 'medium', env: ['SP_CRITIC_MODEL'], reason: composition },
} as const satisfies Record<string, Profile>;

export type LlmTask = keyof typeof PROFILES;
export const LLM_TASKS: readonly LlmTask[] = Object.keys(PROFILES) as LlmTask[];
export interface LlmRoute {
  model: string;
  effort: Effort;
  source: 'explicit' | 'role-env' | 'global-env' | 'profile';
  reason: string;
  policyVersion: string;
}

const configured = (value: string | undefined) => value?.trim() || undefined;

export function selectLlmRoute(task: LlmTask, options: { explicitModel?: string; detailedInspection?: boolean } = {}): LlmRoute {
  const profile = PROFILES[task];
  if (!profile) throw new Error('Неизвестная задача маршрутизации LLM.');
  const explicit = configured(options.explicitModel);
  const role = profile.env.map(name => ({ name, value: configured(process.env[name]) })).find(item => item.value);
  const global = configured(process.env.SP_LLM_MODEL);
  const source = explicit ? 'explicit' : role ? 'role-env' : global ? 'global-env' : 'profile';
  const reason = source === 'explicit' ? 'Модель задана явно.'
    : source === 'role-env' ? `Модель задана настройкой ${role!.name}.`
      : source === 'global-env' ? 'Модель задана общей настройкой SP_LLM_MODEL.' : profile.reason;
  return {
    model: explicit ?? role?.value ?? global ?? profile.model,
    effort: task === 'photo-review' && options.detailedInspection ? 'high' : profile.effort,
    source, reason, policyVersion: LLM_ROUTING_POLICY_VERSION,
  };
}
