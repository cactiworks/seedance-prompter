import { studioFetch as fetch } from '../remoteFetch.ts';
import { inputFingerprint } from '../../core/canvas/freshness.ts';
import { applySeedanceInputs, inputsToUpload, nextRefSync, seedanceInputs, seedanceSummary, type JobLookup, type SeedanceInput } from '../../core/canvas/seedance.ts';
import { seedanceSlug, type CanvasNode } from '../../core/model/canvas.ts';
import { durationOf, shootingOf, type Project } from '../../core/model/project.ts';
import { CUSTOM_KIT, shootingModeOf } from '../../core/pipeline.ts';
import { savedMediaOf, thumbOf, useGen } from '../gen/genStore.ts';
import { downscale, useStore } from '../store.ts';
import { useCanvas } from './canvasStore.ts';

const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { messageRu?: string; error?: string };
    throw new Error(body.messageRu ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Задача генератора → файл и промпт: из ленты задач, которую canvas уже держит. */
export const jobLookup: JobLookup = (jobId) => {
  const { jobs } = useGen.getState();
  const job = jobs.find((j) => j.id === jobId);
  if (job === undefined) return null;
  return { mediaId: savedMediaOf(jobs, jobId), prompt: job.prompt };
};

/**
 * Черновик ноды: есть — читаем. Нет — создаём; у копии ноды (⌘D, ⌘C/⌘V) — копия черновика оригинала, а если
 * оригинала уже нет на диске — чистый ролик.
 */
async function ensureDraft(node: CanvasNode, flowName: string): Promise<Project> {
  const slug = node.slug !== '' ? node.slug : seedanceSlug(node.id);
  const found = await fetch(`/api/projects/${slug}`);
  if (found.ok) return (await found.json()) as Project;
  if (found.status !== 404) return json<Project>(found);
  const title = `Canvas · ${flowName.trim() === '' ? 'flow' : flowName.trim()}`;
  if (node.copyFrom !== '') {
    const copied = await fetch('/api/projects', { method: 'POST', headers: HEADERS, body: JSON.stringify({ slug, title, copyFrom: node.copyFrom }) });
    if (copied.ok) return (await copied.json()) as Project;
  }
  return json<Project>(await fetch('/api/projects', { method: 'POST', headers: HEADERS, body: JSON.stringify({ slug, title }) }));
}

/** Картинка входа → файл панели черновика (+ уменьшенная копия для vision, как при загрузке в «Кадрах»). */
async function uploadInput(slug: string, input: SeedanceInput): Promise<string> {
  const res = await fetch(thumbOf(input.source));
  if (!res.ok) throw new Error(`«${input.label}»: картинка не читается (HTTP ${res.status}).`);
  const blob = await res.blob();
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  const file = `${input.key}.${ext}`;
  await json(await fetch(`/api/projects/${slug}/refs/${file}`, { method: 'PUT', headers: { 'x-sp-client': '1' }, body: blob }));
  const small = await downscale(new File([blob], file, { type: blob.type })).catch(() => null);
  if (small !== null) await fetch(`/api/projects/${slug}/refs/${input.key}-vision.jpg`, { method: 'PUT', headers: { 'x-sp-client': '1' }, body: small }).catch(() => undefined);
  return `${file}?v=${Date.now()}`;
}

/**
 * Открыть Seedance-промптер ноды: черновик, картинки с проводков в панель кадра, редактор поверх холста.
 * Ничего не генерирует и не зовёт LLM — только локальные файлы. Возвращает, что не удалось взять с входов.
 */
export async function openSeedanceNode(nodeId: string): Promise<string[]> {
  const canvas = useCanvas.getState();
  const flow = canvas.flow;
  const node = flow?.nodes.find((n) => n.id === nodeId);
  if (flow === null || node === undefined || node.type !== 'seedance') return ['Нода не найдена.'];

  const fingerprint = inputFingerprint(flow, node.id);
  const draft = await ensureDraft(node, flow.name);
  const shotId = node.shotId !== '' && draft.shots.some((s) => s.id === node.shotId) ? node.shotId : (draft.shots[0]?.id ?? '');
  const { inputs, problems } = seedanceInputs(flow, node.id, jobLookup);

  const files: Record<string, string> = {};
  const failed = new Set<string>();
  for (const input of inputsToUpload(inputs, node.refSync, draft)) {
    try {
      files[input.key] = await uploadInput(draft.slug, input);
    } catch (error) {
      failed.add(input.key);
      problems.push(error instanceof Error ? error.message : `«${input.label}» не загрузилась.`);
    }
  }
  // Не залилась — при следующем открытии попробуем снова: отпечаток остаётся прежним.
  const refSync = nextRefSync(node.refSync, inputs, failed, draft.refs.map((r) => r.key));
  const current = useCanvas.getState().flow;
  if (current?.id !== flow.id || inputFingerprint(current, node.id) !== fingerprint) return ['Вход или холст изменился во время подготовки. Открой промптер заново.'];
  canvas.patchNode(node.id, { slug: draft.slug, shotId, copyFrom: '', refSync, runInputFingerprint: fingerprint }, false);

  useStore.getState().openInHost(draft, shotId, { kind: 'canvas', flowId: flow.id, nodeId: node.id }, (project) => applySeedanceInputs(project, shotId, inputs, files, Object.keys(node.refSync)));
  return problems;
}

/** После закрытия промптера: подпись ноды по сохранённому черновику и свежая лента задач (новые генерации — выход ноды). */
export async function afterSeedanceClose(nodeId: string): Promise<void> {
  void useGen.getState().loadJobs();
  const captured = useCanvas.getState().flow;
  const node = captured?.nodes.find((n) => n.id === nodeId);
  const pack = useStore.getState().pack;
  if (node === undefined || node.slug === '' || pack === null) return;
  const res = await fetch(`/api/projects/${node.slug}`);
  if (!res.ok) return;
  const project = (await res.json()) as Project;
  const shot = project.shots.find((s) => s.id === node.shotId) ?? project.shots[0];
  if (shot === undefined) return;
  const mode = shootingModeOf(shot, pack).mode;
  const kit = shot.kitId === CUSTOM_KIT ? 'своя камера' : (pack.kits[shot.kitId]?.titleRu.split(' — ')[0] ?? '');
  const text = seedanceSummary({
    shootingRu: mode?.titleRu ?? shootingOf(shot).mode,
    kitRu: kit,
    durationSec: durationOf(project, shot),
    aspect: project.aspectRatio,
    shots: shot.segments.filter((s) => s.beatsRu.trim() !== '' || s.text.en.trim() !== '').length,
    cuts: shootingOf(shot).structure === 'cuts',
    synopsisRu: shot.synopsisRu,
  });
  if (useCanvas.getState().flow?.id !== captured?.id) return;
  if (text !== node.text) useCanvas.getState().patchNode(nodeId, { text }, false);
}
