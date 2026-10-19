import { z } from 'zod';
import { GeneratedPromptPlanSchema, IDENTITY_SLOT, hasStoryEvents, validatePrompts } from './plan.ts';
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
  codexAccountId: z.uuid().optional(),
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
export const boundPrompts = (run: ProductionRun) => {
  if (run.character && appearanceReady(run)) return run.appearance!.output!.prompts;
  const plan = run.promptPlan;
  if (!plan || !hasStoryEvents(run.scenePlan) || run.character) return plan;
  // An explicitly unbound series still needs valid, self-contained provider text.
  return { ...plan, masterPrompt: plan.masterPrompt?.replace(IDENTITY_SLOT, 'Natural human proportions'),
    shots: plan.shots.map(s => ({ ...s, imagePrompt: s.imagePrompt.replace(IDENTITY_SLOT, 'Natural human proportions') })) };
};
/** Filling an identity slot cannot rewrite the already planned event, crop, or location. */
function identityInsertion(original: string, bound: string): string | null {
  const parts = original.split(IDENTITY_SLOT);
  if (parts.length !== 2) return null;
  const [before, after] = parts as [string, string];
  if (!bound.startsWith(before) || !bound.endsWith(after) || bound.length <= before.length + after.length) return null;
  return bound.slice(before.length, bound.length - after.length).trim();
}
export function validateAppearance(output: AppearanceOutput, run: ProductionRun, imageCount: number): void {
  const { profile, prompts } = output;
  if (!profile.usable) throw new Error('Референсов недостаточно для фиксации внешности. Нужны отчётливые фото лица, причёски и телосложения.');
  if (!imageCount || profile.evidence.some(e => e.imageIndex > imageCount)) throw new Error('Описание внешности не связано с доступными референсами.');
  if (/[а-яё]/i.test(profile.anchorEn) || profile.anchorEn.split(/\s+/).length > 75) throw new Error('Некорректный якорь внешности.');
  if (prompts.shots.some(s => s.motionPrompt !== run.promptPlan?.shots.find(original => original.shotId === s.shotId)?.motionPrompt)) throw new Error('Привязка внешности изменила сохранённый motion prompt.');
  const errors = validatePrompts(prompts, run.scenePlan!, true);
  if (errors.length) throw new Error('Prompts не закрепили внешность или не прошли проверку плана.');
  if (!hasStoryEvents(run.scenePlan)) {
    if ([prompts.masterPrompt, ...prompts.shots.map(s => s.imagePrompt)].some(p => !p.includes(profile.anchorEn))) throw new Error('Prompts не закрепили внешность или не прошли проверку плана.');
    return;
  }
  if (identityInsertion(run.promptPlan!.masterPrompt!, prompts.masterPrompt) !== profile.anchorEn) throw new Error('В master можно только заполнить слот внешности, сохранив композицию.');
  for (const shot of prompts.shots) {
    const original = run.promptPlan!.shots.find(s => s.shotId === shot.shotId)!.imagePrompt;
    const visibility = run.scenePlan!.shots.find(s => s.id === shot.shotId)!.subjectVisibility;
    if (visibility === 'none') {
      if (shot.imagePrompt !== original) throw new Error('Предметный кадр не должен меняться при привязке внешности.');
      continue;
    }
    const insertion = identityInsertion(original, shot.imagePrompt);
    if (!insertion || (visibility === 'person' ? insertion !== profile.anchorEn : insertion.split(/\s+/).length > 35 || insertion.includes(profile.anchorEn))) throw new Error('Привязка внешности изменила событие/композицию или добавила полный портрет в деталь.');
  }
}
