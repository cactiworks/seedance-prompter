import { z } from 'zod';
import { GeneratedPromptPlanSchema, validatePrompts } from './plan.ts';
import type { ProductionRun } from './model.ts';

export const MAX_IDENTITY_REFS = 6;
const text = (max: number) => z.string().trim().min(1).max(max);
export const AppearanceProfileSchema = z.object({
  anchorEn: text(700), summaryRu: text(1200),
  traits: z.object({
    presentation: text(300), face: text(400), hair: text(300), build: text(400),
  }).strict(),
  evidence: z.array(z.object({ imageIndex: z.number().int().min(1).max(MAX_IDENTITY_REFS), observation: text(400) }).strict()).min(1).max(12),
  unknowns: z.array(text(300)).max(6), usable: z.boolean(),
}).strict();
export const AppearanceOutputSchema = z.object({ profile: AppearanceProfileSchema, prompts: GeneratedPromptPlanSchema }).strict();
export const AppearanceStateSchema = z.object({
  status: z.enum(['pending', 'running', 'complete', 'failed', 'interrupted']), requestId: z.uuid(), consentedAt: z.string(),
  characterId: z.string(), referenceId: z.string(), uploadIds: z.array(z.string()).max(MAX_IDENTITY_REFS),
  output: AppearanceOutputSchema.nullable(), error: z.string().nullable(),
  model: z.string().nullable(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable(),
});
export type AppearanceState = z.infer<typeof AppearanceStateSchema>;
export type AppearanceOutput = z.infer<typeof AppearanceOutputSchema>;
export function pendingAppearance(run: ProductionRun, requestId: string, now: number): AppearanceState {
  return { status: 'pending', requestId, consentedAt: new Date(now).toISOString(), characterId: run.character!.id,
    referenceId: run.character!.referenceId, uploadIds: [], output: null, error: null, model: null, inputTokens: null, outputTokens: null };
}
export function appearanceReady(run: ProductionRun): boolean {
  if (!run.character) return true;
  const state = run.appearance;
  return state?.status === 'complete' && state.output?.profile.usable === true && state.uploadIds.length > 0
    && state.characterId === run.character.id && state.referenceId === run.character.referenceId
    && (!run.photos || state.referenceId === run.photos.identityId);
}
export const boundPrompts = (run: ProductionRun) => run.character && appearanceReady(run) ? run.appearance!.output!.prompts : run.promptPlan;
/** One exact identity anchor in every sent image prompt; no LLM can silently omit it. */
export function validateAppearance(output: AppearanceOutput, run: ProductionRun, imageCount: number): void {
  const { profile, prompts } = output;
  if (!profile.usable) throw new Error('Референсов недостаточно для фиксации внешности. Нужны отчётливые фото лица, причёски и телосложения.');
  if (!imageCount || profile.evidence.some(e => e.imageIndex > imageCount)) throw new Error('Описание внешности не связано с доступными референсами.');
  if (/[а-яё]/i.test(profile.anchorEn) || profile.anchorEn.split(/\s+/).length > 75) throw new Error('Некорректный якорь внешности.');
  if (prompts.shots.some(s => s.motionPrompt !== run.promptPlan?.shots.find(original => original.shotId === s.shotId)?.motionPrompt)) throw new Error('Привязка внешности изменила сохранённый motion prompt.');
  const errors = validatePrompts(prompts, run.scenePlan!);
  if (errors.length || [prompts.masterPrompt, ...prompts.shots.map(s => s.imagePrompt)].some(p => !p.includes(profile.anchorEn))) throw new Error('Prompts не закрепили внешность или не прошли проверку плана.');
}
