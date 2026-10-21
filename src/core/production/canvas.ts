import { CanvasNodeSchema, canvasRefKey, seedanceSlug, type Flow } from '../model/canvas.ts';
import { ASPECT_RATIOS, newProject, type AspectRatio, type Project } from '../model/project.ts';
import type { ProductionRun, Artifact } from './model.ts';

export function acceptedPhotos(run: ProductionRun): Artifact[] {
  return run.shots.flatMap(s => { const a = run.artifacts.find(a => a.id === s.acceptedPhotoId && a.kind === 'photo' && a.mediaId); return a ? [a] : []; });
}
/** Repeated handoffs add only newly accepted versions; existing nodes/layout/drafts are untouched. */
export function extendProductionFlow(flow: Flow, run: ProductionRun, newId: () => string): Flow {
  const nodes = [...flow.nodes]; const edges = [...flow.edges];
  for (const a of acceptedPhotos(run)) {
    if (nodes.some(n => n.production?.artifactId === a.id)) continue;
    const shot = run.shots.find(s => s.id === a.shotId)!;
    const suffix = newId();
    const imageId = `pi-${suffix}`; const nodeId = `ps-${suffix}`;
    const y = nodes.length ? Math.max(...nodes.map(n => n.y)) + 420 : 80;
    const production = { runId: run.id, shotId: a.shotId, artifactId: a.id };
    nodes.push(CanvasNodeSchema.parse({ id: imageId, type: 'image', x: 80, y, label: shot.title, source: { type: 'media', mediaId: a.mediaId }, production }));
    nodes.push(CanvasNodeSchema.parse({ id: nodeId, type: 'seedance', x: 440, y, label: shot.title, slug: seedanceSlug(nodeId), shotId: 'shot-1', production }));
    edges.push({ id: `e-${suffix}`, from: imageId, to: nodeId, port: 'ref' });
  }
  return { ...flow, production: { runId: run.id, title: run.title }, nodes, edges };
}
export function productionDraft(flow: Flow, nodeId: string, run: ProductionRun, file: string): Project {
  const node = flow.nodes.find(n => n.id === nodeId)!;
  const image = flow.nodes.find(n => flow.edges.some(e => e.to === nodeId && e.from === n.id))!;
  const key = canvasRefKey(image.id);
  const project = newProject(node.slug, `${run.title} · ${node.label}`);
  const planned = run.scenePlan?.shots.find(s => s.id === node.production?.shotId);
  const aspect = run.aspectRatio ?? '9:16';
  if (!ASPECT_RATIOS.includes(aspect as AspectRatio)) throw new Error(`Формат фото ${aspect} пока не поддержан Prompter.`);
  return { ...project, aspectRatio: aspect as AspectRatio, durationSec: planned?.durationSec ?? 5,
    production: { ...node.production!, flowId: flow.id, nodeId },
    refs: [{ key, label: node.label, kind: 'frame', file, note: run.promptPlan?.shots.find(s => s.shotId === planned?.id)?.imagePrompt ?? '', flags: { hasPeople: planned?.subjectVisibility !== 'none', hasText: false, studioBackdrop: false } }],
    shots: [{ ...project.shots[0]!, panel: [key], durationSec: planned?.durationSec ?? 5, title: node.label }],
  };
}
