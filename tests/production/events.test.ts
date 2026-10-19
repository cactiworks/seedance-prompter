import { describe, expect, it } from 'vitest';
import { newRun } from '../../src/core/production/engine.ts';
import { DEMO_INPUT } from '../../src/core/production/model.ts';
import { GeneratedSceneDraftSchema, GeneratedPromptPlanSchema, validatePrompts, validateScene, withShotIds, sceneForShot } from '../../src/core/production/plan.ts';
import { validateAppearance, boundPrompts } from '../../src/core/production/appearance.ts';
import { StoredRunSchema } from '../../src/core/production/persistence.ts';
import { appearanceOutput, promptPlan, sceneDraft, SCRIPT } from './fixtures.ts';

function example() {
  const draft = sceneDraft(3);
  draft.scenes.push({ ...draft.scenes[0]!, id: 'street', title: 'На улице', location: 'Перекрёсток с широким тротуаром', lighting: 'Тёплый вечерний боковой свет' });
  draft.shots[0]!.action = 'Владелец открывает блокнот';
  draft.shots[0]!.startFrame = 'Пальцы приподнимают обложку закрытого блокнота';
  draft.shots[1]!.subjectVisibility = 'detail';
  draft.shots[1]!.action = 'Рука пишет одну мысль';
  draft.shots[1]!.startFrame = 'Перо касается пустой страницы, видны только кисть и бумага';
  draft.shots[2]!.sceneId = 'street'; draft.shots[2]!.subjectVisibility = 'none';
  draft.shots[2]!.action = 'Закрытый блокнот лежит на скамье, ветер шевелит закладку';
  draft.shots[2]!.startFrame = 'Предметный кадр закрытого блокнота на уличной скамье';
  const plan = withShotIds(GeneratedSceneDraftSchema.parse(draft));
  const prompts = promptPlan(3);
  prompts.shots[1]!.imagePrompt = 'Extreme close detail of a right hand and paper, a pen touching the blank notebook page at the start of a written thought. The entire frame contains the fingers, pen tip and rough paper on a wooden table under warm side light from a nearby window. {{identity}}.';
  prompts.shots[2]!.imagePrompt = 'A closed notebook rests alone on a rough wooden street bench, with a loose fabric bookmark extending beyond the cover. Warm late evening light crosses the paper edges and bench slats. The close object composition looks down toward the book, ready for a breeze to lift its bookmark.';
  const output = appearanceOutput(3);
  output.prompts = { ...prompts, masterPrompt: prompts.masterPrompt!.replace('{{identity}}', output.profile.anchorEn), shots: prompts.shots.map((shot, i) => ({ ...shot, imagePrompt: shot.imagePrompt.replace('{{identity}}', i === 1 ? 'The visible hand has natural proportions and light skin matching the supplied references' : output.profile.anchorEn) })) };
  const run = newRun('pr-events-test', { ...DEMO_INPUT, script: SCRIPT }, 0, 1);
  run.scenePlan = plan; run.promptPlan = prompts;
  return { draft, plan, prompts, output, run };
}

describe('event storyboard and identity composition boundary', () => {
  it('keeps twelve explicitly requested scenes, quotes and prompt positions through persistence', () => {
    const draft = sceneDraft(12);
    const instructions = Array.from({ length: 12 }, (_, i) => `Сцена ${i + 1}: показать действие ${i + 1} с нужным предметом.`);
    const script = instructions.join('\n');
    draft.scenes = instructions.map((_, i) => ({ ...draft.scenes[0]!, id: `scene-${i + 1}` }));
    draft.shots.forEach((shot, i) => Object.assign(shot, { scriptExcerpt: instructions[i], scriptInstruction: instructions[i], sceneId: `scene-${i + 1}` }));
    const plan = withShotIds(GeneratedSceneDraftSchema.parse(draft));
    const prompts = GeneratedPromptPlanSchema.parse(promptPlan(12));
    expect(validateScene(draft, script)).toEqual([]);
    expect(validatePrompts(prompts, plan)).toEqual([]);
    const run = newRun('pr-twelve', { ...DEMO_INPUT, script }, 0, 1);
    run.scenePlan = plan; run.promptPlan = prompts;
    expect(StoredRunSchema.parse(run).scenePlan!.shots.map(s => s.scriptInstruction)).toEqual(instructions);
    expect(StoredRunSchema.parse(run).promptPlan!.shots).toHaveLength(12);
    draft.shots[0]!.scriptInstruction = 'Выдуманное указание';
    expect(validateScene(draft, script).join(' ')).toContain('дословно');
    prompts.shots.pop();
    expect(validatePrompts(prompts, plan).join(' ')).toContain('каждого ID');
  });
  it('preserves two explicitly requested framings of one event in a shared script phrase', () => {
    const script = 'Два кадра: говорю в микрофон — общий план, затем крупный план лица.';
    const draft = sceneDraft(2);
    draft.shots.forEach(shot => Object.assign(shot, { scriptExcerpt: script, scriptInstruction: script, action: 'Говорю в микрофон' }));
    expect(validateScene(draft, script)).toEqual([]);
    draft.shots.forEach(shot => { shot.scriptInstruction = ''; });
    expect(validateScene(draft, script).join(' ')).toContain('повтор события');
  });
  it('persists scene-scoped events and keeps a compatible first-scene alias', () => {
    const { draft, plan, prompts, run } = example();
    expect(validateScene(draft, SCRIPT)).toEqual([]);
    expect(validatePrompts(prompts, plan)).toEqual([]);
    expect(sceneForShot(plan, plan.shots[2]!).location).toContain('Перекрёсток');
    expect(plan.scene).toEqual(expect.objectContaining({ location: draft.scenes[0]!.location }));
    expect(StoredRunSchema.parse(run).scenePlan).toEqual(plan);
  });
  it('rejects repeated events despite different shot sizes, missing scenes and reversed script order', () => {
    const { draft } = example();
    draft.shots[1]!.action = draft.shots[0]!.action;
    draft.shots[1]!.scriptExcerpt = draft.shots[0]!.scriptExcerpt;
    expect(validateScene(draft, SCRIPT).join(' ')).toContain('повтор события');
    draft.shots[2]!.sceneId = 'invented';
    expect(validateScene(draft, SCRIPT).join(' ')).toContain('не связан');
    draft.shots.reverse();
    expect(validateScene(draft, SCRIPT).join(' ')).toContain('порядку сценария');
  });
  it('rejects repeated photo prompts, missing identity slots and accidental placeholders in motion', () => {
    const { plan, prompts } = example();
    prompts.shots[1]!.imagePrompt = prompts.shots[0]!.imagePrompt;
    prompts.shots[2]!.imagePrompt += ' {{identity}}';
    prompts.shots[0]!.motionPrompt += ' {{identity}}';
    const errors = validatePrompts(prompts, plan).join(' ');
    expect(errors).toContain('одинаковые imagePrompt');
    expect(errors).toContain('предметного кадра');
    expect(errors).toContain('motionPrompt должен быть самостоятельным');
  });
  it('binds the whole person only where visible, a local detail in close-up, and nothing in object b-roll', () => {
    const { run, output } = example();
    expect(() => validateAppearance(output, run, 3)).not.toThrow();
    expect(output.prompts.shots[0]!.imagePrompt).toContain(output.profile.anchorEn);
    expect(output.prompts.shots[1]!.imagePrompt).not.toContain(output.profile.anchorEn);
    expect(output.prompts.shots[2]!.imagePrompt).toBe(run.promptPlan!.shots[2]!.imagePrompt);
  });
  it.each(['crop', 'detail', 'object', 'motion'] as const)('blocks appearance rewriting %s before media can start', kind => {
    const { run, output } = example();
    if (kind === 'crop') output.prompts.shots[0]!.imagePrompt = output.prompts.shots[0]!.imagePrompt.replace('phone photograph', 'full length standing portrait');
    if (kind === 'detail') output.prompts.shots[1]!.imagePrompt = run.promptPlan!.shots[1]!.imagePrompt.replace('{{identity}}', output.profile.anchorEn);
    if (kind === 'object') output.prompts.shots[2]!.imagePrompt += ' The man stands behind it.';
    if (kind === 'motion') output.prompts.shots[0]!.motionPrompt += ' He walks into a different room.';
    expect(() => validateAppearance(output, run, 3)).toThrow();
  });
  it('removes unbound slots for an explicitly character-free series', () => {
    const { run } = example();
    const prompts = boundPrompts(run)!;
    expect(JSON.stringify(prompts)).not.toContain('{{identity}}');
    expect(prompts.shots[2]).toEqual(run.promptPlan!.shots[2]);
  });
});
