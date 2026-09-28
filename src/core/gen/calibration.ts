import { estimate, findModel, paramsFor, UNIT, validateGen, type GenParams, type ParamValue, type ProviderId } from './models.ts';

/**
 * Калибровка (этап 4, решение 33): наборы тестов проверяют то, чего нет в открытых данных, — одинаковый промпт на
 * несколько моделей или одна модель с разными seed. Данные — packs/prompter/calibration.json; оценки владельца —
 * журнал; правило в промптер — с третьего повтора одной ошибки у одной модели.
 */

export interface CalibrationCase {
  id: string;
  labelRu: string;
  prompt: string;
  params: Record<string, ParamValue>;
}

export interface CalibrationModel {
  key: string;
  labelRu: string;
  modelId: string;
  params: Record<string, ParamValue>;
}

export interface CalibrationSuite {
  id: string;
  titleRu: string;
  questionRu: string;
  whyRu: string;
  cases: CalibrationCase[];
  models: CalibrationModel[];
}

export interface CalibrationPack {
  version: number;
  sourceRu: string;
  suites: CalibrationSuite[];
}

/** Одна задача набора: случай × модель с конкретными параметрами. */
export interface CalibrationJob {
  caseId: string;
  modelKey: string;
  modelId: string;
  prompt: string;
  params: GenParams;
  credits: number;
}

export function expandSuite(suite: CalibrationSuite): CalibrationJob[] {
  return suite.cases.flatMap((c) =>
    suite.models.flatMap((m) => {
      const model = findModel(m.modelId);
      if (model === undefined) return [];
      const params = paramsFor(model, { ...m.params, ...c.params });
      return [{ caseId: c.id, modelKey: m.key, modelId: model.id, prompt: c.prompt, params, credits: estimate(model, params).credits }];
    }),
  );
}

/** Цена набора по провайдерам: KIE — кредиты, Higgsfield — доллары; у каждого свой баланс. */
export function suiteCost(suite: CalibrationSuite): { provider: ProviderId; credits: number; usd: number; unitRu: string }[] {
  const out = new Map<ProviderId, number>();
  for (const job of expandSuite(suite)) {
    const provider = findModel(job.modelId)?.provider;
    if (provider !== undefined) out.set(provider, (out.get(provider) ?? 0) + job.credits);
  }
  return [...out].map(([provider, credits]) => ({ provider, credits: Math.round(credits * 10_000) / 10_000, usd: Math.round(credits * UNIT[provider].usd * 10_000) / 10_000, unitRu: UNIT[provider].labelRu }));
}

/** Метка задачи набора: `cal:<запуск>:<набор>:<случай>:<модель>`. По ней сетка находит свои результаты. */
export const calibrationTag = (runId: string, suiteId: string, caseId: string, modelKey: string): string => `cal:${runId}:${suiteId}:${caseId}:${modelKey}`;

export function parseCalibrationTag(tag: string | null): { runId: string; suiteId: string; caseId: string; modelKey: string } | null {
  const parts = tag?.split(':') ?? [];
  if (parts.length !== 5 || parts[0] !== 'cal') return null;
  const [, runId = '', suiteId = '', caseId = '', modelKey = ''] = parts;
  return { runId, suiteId, caseId, modelKey };
}

/** Проверка набора (тест): модели есть, параметры и промпты проходят проверку отправки, id уникальны. */
export function validateCalibration(pack: CalibrationPack): string[] {
  const problems: string[] = [];
  const suites = new Set<string>();
  for (const suite of pack.suites) {
    if (suites.has(suite.id)) problems.push(`${suite.id}: повторяется id набора.`);
    suites.add(suite.id);
    if (new Set(suite.cases.map((c) => c.id)).size !== suite.cases.length) problems.push(`${suite.id}: повторяются id случаев.`);
    if (new Set(suite.models.map((m) => m.key)).size !== suite.models.length) problems.push(`${suite.id}: повторяются ключи моделей.`);
    for (const m of suite.models) {
      const model = findModel(m.modelId);
      if (model === undefined) {
        problems.push(`${suite.id}: нет модели ${m.modelId}.`);
        continue;
      }
      for (const c of suite.cases) {
        const merged = { ...m.params, ...c.params };
        const params = paramsFor(model, merged);
        for (const [key, value] of Object.entries(merged)) if (params[key] !== value) problems.push(`${suite.id}/${c.id}/${m.key}: ${key}=${String(value)} модель не принимает.`);
        problems.push(...validateGen(model, c.prompt, params, []).map((p) => `${suite.id}/${c.id}/${m.key}: ${p}`));
      }
    }
  }
  return problems;
}

// ——— журнал оценок ———

export const VERDICTS = ['good', 'almost', 'bad'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VERDICT_RU: Record<Verdict, string> = { good: 'Годно', almost: 'Почти', bad: 'Мимо' };

/** Что не так — те же слова, что у рецептов починки, плюс то, что правкой не чинится. */
export const VERDICT_SYMPTOMS: readonly { id: string; labelRu: string }[] = [
  { id: 'text', labelRu: 'текст' },
  { id: 'face', labelRu: 'лицо' },
  { id: 'hands', labelRu: 'руки' },
  { id: 'count', labelRu: 'количество' },
  { id: 'skin', labelRu: 'пластик' },
  { id: 'physics', labelRu: 'физика' },
  { id: 'prompt', labelRu: 'не по промпту' },
  { id: 'crop', labelRu: 'кадрирование' },
  { id: 'style', labelRu: 'не тот стиль' },
];

export interface VerdictEntry {
  mediaId: string;
  verdict: Verdict;
  symptoms: string[];
  noteRu: string;
  at: string;
}

export interface Repeat {
  modelId: string;
  symptom: string;
  count: number;
  /** Из скольких оценок этой модели. */
  of: number;
  mediaIds: string[];
}

/** Правило в промптер — с третьего повтора одной ошибки у одной модели (как в harness Сцены). */
export function repeatedSymptoms(verdicts: readonly VerdictEntry[], modelOf: (mediaId: string) => string | undefined, threshold = 3): Repeat[] {
  const byModel = new Map<string, VerdictEntry[]>();
  for (const v of verdicts) {
    const modelId = modelOf(v.mediaId);
    if (modelId !== undefined) byModel.set(modelId, [...(byModel.get(modelId) ?? []), v]);
  }
  const out: Repeat[] = [];
  for (const [modelId, list] of byModel) {
    for (const { id } of VERDICT_SYMPTOMS) {
      const hits = list.filter((v) => v.symptoms.includes(id));
      if (hits.length >= threshold) out.push({ modelId, symptom: id, count: hits.length, of: list.length, mediaIds: hits.map((v) => v.mediaId) });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

export interface Learning {
  id: string;
  modelId: string;
  textRu: string;
  evidence: string[];
  at: string;
}

/** Правила владельца дописываются в карточку модели промптера — отдельным разделом с пометкой [owner]. */
export function withLearnings(card: string, learnings: readonly Learning[]): string {
  if (learnings.length === 0) return card;
  const lines = learnings.map((l) => `- ${l.textRu.trim()} [owner, ${l.at.slice(0, 10)}, ${l.evidence.length} runs]`);
  return `${card.trim()}\n\n## From the owner's own runs [owner] — these override vendor claims\n${lines.join('\n')}`;
}
