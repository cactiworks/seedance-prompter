import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const ArtDirectionSchema = z.object({ concept: text(700), visualHook: text(500), captureTexture: text(500) }).strict();
const SceneSchema = z.object({
  title: text(120), location: text(800), subject: text(500), wardrobe: text(500),
  timeOfDay: text(200), weather: text(300), lighting: text(700), palette: text(300),
  continuity: z.array(text(400)).min(1).max(8),
}).strict();
const StorySceneSchema = SceneSchema.extend({ id: text(30) });
export const SceneDraftSchema = z.object({
  contentMode: z.enum(['story', 'broll']).optional(),
  artDirection: ArtDirectionSchema.optional(),
  scene: SceneSchema,
  storyboardVersion: z.literal('events-v1').optional(),
  scenes: z.array(StorySceneSchema).min(1).max(8).optional(),
  shots: z.array(z.object({
    title: text(100), scriptExcerpt: text(1500).optional(), concept: text(700).optional(), intentionalEffect: text(500).optional(), purpose: text(500),
    framing: text(250), action: text(700), camera: text(600), visualAnchor: text(500).optional(),
    sceneId: text(30).optional(), beat: text(500).optional(), startFrame: text(700).optional(),
    subjectVisibility: z.enum(['person', 'detail', 'none']).optional(),
    durationSec: z.number().int().min(4).max(12),
  }).strict()).min(1).max(8),
  assumptions: z.array(text(500)).max(8),
  warnings: z.array(text(500)).max(8),
}).strict();
/** New output has scene-scoped events. `scene` is a stored legacy alias, never authored twice. */
export const GeneratedSceneDraftSchema = SceneDraftSchema.omit({ scene: true }).extend({
  contentMode: z.literal('story').optional(),
  storyboardVersion: z.literal('events-v1'),
  scenes: z.array(StorySceneSchema).min(1).max(8),
  artDirection: ArtDirectionSchema,
  shots: z.array(SceneDraftSchema.shape.shots.element.extend({
    scriptExcerpt: text(1500), visualAnchor: text(500), sceneId: text(30), beat: text(500), startFrame: text(700),
    subjectVisibility: z.enum(['person', 'detail', 'none']),
  })).min(1).max(8),
});
/** Independent concepts have no script quotes or story beats. The image route stays events-v1. */
export const GeneratedBrollDraftSchema = GeneratedSceneDraftSchema.extend({
  contentMode: z.literal('broll'),
  shots: z.array(GeneratedSceneDraftSchema.shape.shots.element.omit({ scriptExcerpt: true, beat: true }).extend({
    concept: text(700), intentionalEffect: text(500),
  })).min(1).max(8),
});
export type GeneratedBrollDraft = z.infer<typeof GeneratedBrollDraftSchema>;
export type SceneDraft = z.infer<typeof SceneDraftSchema>;
export type GeneratedSceneDraft = z.infer<typeof GeneratedSceneDraftSchema>;
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
export const hasStoryEvents = (plan: ScenePlan | undefined): boolean => plan?.storyboardVersion === 'events-v1';
export const sceneForShot = (plan: ScenePlan, shot: PlannedShot) => plan.scenes?.find(s => s.id === shot.sceneId) ?? plan.scene;
const normalized = (value: string) => value.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
export function validateScene(draft: SceneDraft | GeneratedSceneDraft | GeneratedBrollDraft, script: string, brollCount?: number): string[] {
  const broll = draft.contentMode === 'broll';
  const shots: SceneDraft['shots'] = draft.shots;
  const errors: string[] = broll ? [] : shots.flatMap((s, i) => s.scriptExcerpt && script.includes(s.scriptExcerpt) ? [] : [`Кадр ${i + 1}: scriptExcerpt должен быть точной цитатой сценария.`]);
  if (broll && (shots.some(s => s.subjectVisibility === 'none') || shots.filter(s => s.subjectVisibility !== 'person').length > (shots.length >= 4 ? 1 : 0))) errors.push('B-roll: владелец с читаемым лицом — главный герой. Только при 4–8 кадрах допустима одна detail-вставка от первого лица; предметные none запрещены.');
  if (broll && draft.shots.length !== (brollCount ?? 4)) errors.push(`Нужно ровно ${brollCount ?? 4} самостоятельных B-roll.`);
  if (draft.storyboardVersion !== 'events-v1') return errors;
  const scenes = draft.scenes ?? [];
  if (!scenes.length || new Set(scenes.map(s => s.id)).size !== scenes.length) errors.push('Паспорта сцен должны иметь уникальные IDs.');
  const events = new Set<string>(); const frames = new Set<string>(); const concepts = new Set<string>(); const hooks = new Set<string>();
  let previous = 0;
  for (const [i, shot] of shots.entries()) {
    if (!scenes.some(s => s.id === shot.sceneId)) errors.push(`Кадр ${i + 1}: sceneId не связан с паспортом сцены.`);
    if ((!broll && !shot.beat) || !shot.startFrame || !shot.subjectVisibility) errors.push(`Кадр ${i + 1}: нужны смысл, стартовое состояние и видимость персонажа.`);
    if (broll) {
      if (shot.scriptExcerpt || shot.beat) errors.push(`Кадр ${i + 1}: B-roll не должен содержать цитату или смысловой beat сценария.`);
      if (!shot.concept || !shot.intentionalEffect) errors.push(`Кадр ${i + 1}: нужны самостоятельная идея и описание намеренного эффекта.`);
      const concept = normalized(shot.concept ?? ''); const hook = normalized(shot.visualAnchor ?? '');
      if (concepts.has(concept) || hooks.has(hook)) errors.push(`Кадр ${i + 1}: повтор идеи или визуального приёма. Нужен самостоятельный B-roll.`);
      concepts.add(concept); hooks.add(hook);
    } else {
      const position = script.indexOf(shot.scriptExcerpt ?? '', previous);
      if (position < 0) errors.push(`Кадр ${i + 1}: цитаты должны следовать порядку сценария.`);
      else previous = position;
    }
    const event = `${broll ? '' : shot.sceneId}:${normalized(shot.action)}`;
    const frame = normalized(shot.startFrame ?? '');
    if (events.has(event) || frames.has(frame)) errors.push(`Кадр ${i + 1}: повтор события или стартового изображения. Нужен ${broll ? 'самостоятельный B-roll' : 'следующий смысловой момент'}, а не другой ракурс дубля.`);
    events.add(event); frames.add(frame);
  }
  if (scenes.some(s => !draft.shots.some(shot => shot.sceneId === s.id))) errors.push('Каждая сцена должна использоваться в плане кадров.');
  return errors;
}
export function withShotIds(draft: SceneDraft | GeneratedSceneDraft | GeneratedBrollDraft): ScenePlan {
  const scene = SceneSchema.strip().parse('scene' in draft ? draft.scene : draft.scenes[0]);
  return { ...draft, scene, shots: draft.shots.map((s, i) => ({ ...s, id: `shot-${i + 1}` })) };
}
export const IDENTITY_SLOT = '{{identity}}';
export function validatePrompts(plan: PromptPlan, scene: ScenePlan, identityBound = false): string[] {
  const expected = scene.shots.map((s) => s.id);
  const ids = plan.shots.map((s) => s.shotId);
  const errors: string[] = [];
  if (hasStoryEvents(scene) && new Set(plan.shots.map(s => normalized(s.imagePrompt))).size !== plan.shots.length) errors.push('Разные события получили одинаковые imagePrompt. Сохрани отдельное стартовое изображение каждого события.');
  if (ids.length !== expected.length || new Set(ids).size !== ids.length || expected.some((id) => !ids.includes(id))) errors.push('Нужен ровно один набор prompts для каждого ID из shot plan.');
  if (plan.masterPrompt) {
    const words = plan.masterPrompt.split(/\s+/).length;
    if (words < 40 || words > 200 || /[а-яё]|@Image\d|<<<image_/i.test(plan.masterPrompt)) errors.push('masterPrompt: нужен английский prompt 40–200 слов без фиктивных references.');
  }
  if (hasStoryEvents(scene)) {
    for (const entry of [{ id: 'master', value: plan.masterPrompt ?? '', needsIdentity: true }, ...plan.shots.map(s => ({ id: s.shotId, value: s.imagePrompt, needsIdentity: scene.shots.find(shot => shot.id === s.shotId)?.subjectVisibility !== 'none' }))]) {
      const slots = entry.value.split(IDENTITY_SLOT).length - 1;
      if (slots !== Number(!identityBound && entry.needsIdentity)) errors.push(`${entry.id}: нужен ровно один {{identity}} для видимого персонажа и ни одного для предметного кадра; после привязки слоты должны быть заполнены.`);
      if (!identityBound && entry.value.split(/\s+/).length > 125) errors.push(`${entry.id}: оставь место для внешности, до 125 слов в исходном image prompt.`);
      if (/\{\{|\}\}/.test(entry.value.replaceAll(IDENTITY_SLOT, ''))) errors.push(`${entry.id}: неизвестный placeholder.`);
    }
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
    if (/\{\{|\}\}/.test(shot.motionPrompt)) errors.push(`${shot.shotId}: motionPrompt должен быть самостоятельным, без placeholders.`);
  }
  return errors;
}
