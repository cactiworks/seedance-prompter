import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
export const SceneDraftSchema = z.object({
  scene: z.object({
    title: text(120), location: text(800), subject: text(500), wardrobe: text(500),
    timeOfDay: text(200), weather: text(300), lighting: text(700), palette: text(300),
    continuity: z.array(text(400)).min(1).max(8),
  }).strict(),
  shots: z.array(z.object({
    title: text(100), scriptExcerpt: text(1500), purpose: text(500),
    framing: text(250), action: text(700), camera: text(600),
    durationSec: z.number().int().min(4).max(12),
  }).strict()).min(1).max(8),
  assumptions: z.array(text(500)).max(8),
  warnings: z.array(text(500)).max(8),
}).strict();
export type SceneDraft = z.infer<typeof SceneDraftSchema>;
export type PlannedShot = SceneDraft['shots'][number] & { id: string };
export type ScenePlan = Omit<SceneDraft, 'shots'> & { shots: PlannedShot[] };
export const PromptPlanSchema = z.object({
  masterPrompt: text(2400).optional(),
  shots: z.array(z.object({ shotId: text(30), imagePrompt: text(1800), motionPrompt: text(3000) }).strict()).min(1).max(8),
  warnings: z.array(text(500)).max(8),
}).strict();
export const GeneratedPromptPlanSchema = PromptPlanSchema.extend({ masterPrompt: text(2400) });
export type PromptPlan = z.infer<typeof PromptPlanSchema>;
export type PreparationStage = 'scene' | 'prompts';
export interface PreparationCall {
  stage: PreparationStage; at: string; status: 'accepted' | 'rejected' | 'failed';
  model: string | null; durationMs: number; inputTokens: number | null; outputTokens: number | null;
  message: string | null;
}
export interface PreparationState {
  status: 'running' | 'failed' | 'interrupted' | 'complete'; stage: PreparationStage;
  attempt: number; startedAt: string; error: string | null; calls: PreparationCall[];
}
export function validateScene(draft: SceneDraft, script: string): string[] {
  return draft.shots.flatMap((s, i) => script.includes(s.scriptExcerpt) ? [] : [`Кадр ${i + 1}: scriptExcerpt должен быть точной цитатой сценария.`]);
}
export function withShotIds(draft: SceneDraft): ScenePlan {
  return { ...draft, shots: draft.shots.map((s, i) => ({ ...s, id: `shot-${i + 1}` })) };
}
export function validatePrompts(plan: PromptPlan, scene: ScenePlan): string[] {
  const expected = scene.shots.map((s) => s.id);
  const ids = plan.shots.map((s) => s.shotId);
  const errors: string[] = [];
  if (ids.length !== expected.length || new Set(ids).size !== ids.length || expected.some((id) => !ids.includes(id))) errors.push('Нужен ровно один набор prompts для каждого ID из shot plan.');
  if (plan.masterPrompt) {
    const words = plan.masterPrompt.split(/\s+/).length;
    if (words < 40 || words > 200 || /[а-яё]|@Image\d|<<<image_/i.test(plan.masterPrompt)) errors.push('masterPrompt: нужен английский prompt 40–200 слов без фиктивных references.');
  }
  for (const shot of plan.shots) {
    const words = shot.imagePrompt.split(/\s+/).length;
    if (words < 40) errors.push(`${shot.shotId}: imagePrompt должен содержать 40–200 слов, включая сцену, действие и свет.`);
    for (const [name, value] of [['imagePrompt', shot.imagePrompt], ['motionPrompt', shot.motionPrompt]]) {
      const prose = (value ?? '').replace(/"[^"]*"|«[^»]*»/g, '');
      if (/[а-яё]/i.test(prose) || !/[a-z]{3}/i.test(prose)) errors.push(`${shot.shotId}: ${name} должен быть на английском; текст в кадре можно оставить в кавычках.`);
    }
    const expectedShot = scene.shots.find((item) => item.id === shot.shotId);
    const intervals = [...shot.motionPrompt.matchAll(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*(?:s\b|sec(?:onds)?\b)/gi)].map((match) => [Number(match[1]), Number(match[2])] as const);
    if (expectedShot && (intervals.length === 0 || intervals[0]?.[0] !== 0 || intervals.at(-1)?.[1] !== expectedShot.durationSec || intervals.some(([start, end], i) => end <= start || (i > 0 && intervals[i - 1]?.[1] !== start)))) errors.push(`${shot.shotId}: интервалы motionPrompt должны непрерывно покрывать 0–${expectedShot.durationSec} s без изменения длительности.`);
    if (words > 200) errors.push(`${shot.shotId}: imagePrompt длиннее 200 слов.`);
    if (/@Image\d|<<<image_|\{\{(?:ref|intro):/.test(`${shot.imagePrompt} ${shot.motionPrompt}`)) errors.push(`${shot.shotId}: ссылки на неподключённые references запрещены.`);
  }
  return errors;
}
