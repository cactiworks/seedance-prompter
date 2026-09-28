import { estimate, findModel, paramsFor, validateGen, type Estimate, type GenParams, type RefRole } from '../gen/models.ts';
import type { CanvasNode, Flow, InputPort } from '../model/canvas.ts';
import type { JobRef } from '../model/media.ts';

/** Что уйдёт в модель при запуске ноды-генератора. Считается из графа, без сети. */
export interface RunPlan {
  modelId: string;
  prompt: string;
  params: GenParams;
  refs: JobRef[];
  estimate: Estimate | null;
  problems: string[];
}

const ROLE_OF: Record<Exclude<InputPort, 'prompt' | 'video'>, RefRole> = { ref: 'ref', start: 'start', end: 'end' };

export const nodeTitle = (node: CanvasNode): string => {
  if (node.type === 'prompt') return 'Промпт';
  if (node.type === 'image') return node.label !== '' ? node.label : 'Картинка';
  if (node.type === 'frame') return node.which === 'last' ? 'Последний кадр видео' : 'Первый кадр видео';
  return `${node.kind === 'image' ? 'Картинка' : 'Видео'} · ${findModel(node.modelId)?.titleRu ?? 'модель'}`;
};

/**
 * `mediaOf(jobId)` — сохранённый файл задачи или null. Генератор выше по графу отдаёт выбранный вариант;
 * если он ещё не запускался — запуск запрещён: сам он не запустится (ниже по графу ничего не стартует
 * без клика), а молча отправить модель без входа значит потратить деньги впустую.
 */
export function planRun(flow: Flow, nodeId: string, mediaOf: (jobId: string) => string | null): RunPlan {
  const node = flow.nodes.find((n) => n.id === nodeId);
  const model = node === undefined ? undefined : findModel(node.modelId);
  if (node === undefined || node.type !== 'generator' || model === undefined) return { modelId: node?.modelId ?? '', prompt: '', params: {}, refs: [], estimate: null, problems: ['Выбери модель в ноде.'] };

  const problems: string[] = [];
  const incoming = flow.edges.filter((e) => e.to === node.id);
  const source = (id: string): CanvasNode | undefined => flow.nodes.find((n) => n.id === id);

  const texts = incoming
    .filter((e) => e.port === 'prompt')
    .map((e) => source(e.from))
    .filter((n): n is CanvasNode => n?.type === 'prompt')
    .map((n) => n.text.trim())
    .filter((t) => t !== '');
  const prompt = [...texts, node.text.trim()].filter((t) => t !== '').join('\n\n');

  const refs: JobRef[] = [];
  for (const edge of incoming) {
    if (edge.port === 'prompt' || edge.port === 'video') continue;
    const from = source(edge.from);
    if (from === undefined) continue;
    const role = ROLE_OF[edge.port];
    if (from.type === 'frame') {
      if (from.mediaId === null) problems.push(`Сначала извлеки кадр в ноде «${nodeTitle(from)}».`);
      else refs.push({ label: nodeTitle(from), source: { type: 'media', mediaId: from.mediaId }, role });
    } else if (from.type === 'image') {
      if (from.source === null) problems.push(`В ноде «${nodeTitle(from)}» нет картинки.`);
      else refs.push({ label: nodeTitle(from), source: from.source, role });
    } else if (from.type === 'generator') {
      if (from.kind === 'video') {
        problems.push(`«${nodeTitle(from)}»: видео на вход генератора пока не подаётся.`);
        continue;
      }
      const jobId = from.jobIds[from.selected];
      const mediaId = jobId === undefined ? null : mediaOf(jobId);
      if (mediaId === null) problems.push(`Сначала запусти «${nodeTitle(from)}» и дождись результата — сам он не запустится.`);
      else refs.push({ label: nodeTitle(from), source: { type: 'media', mediaId }, role });
    }
  }

  const params = paramsFor(model, node.params);
  problems.push(...validateGen(model, prompt, params, refs.map((r) => r.role)));
  return { modelId: model.id, prompt, params, refs, estimate: estimate(model, params, 1, refs.length), problems };
}

/** Видео для ноды «Кадр из видео»: выбранный вариант генератора видео на входе или причина, почему его нет. */
export function frameInput(flow: Flow, nodeId: string, mediaOf: (jobId: string) => string | null): { mediaId: string | null; problemRu: string | null } {
  const edge = flow.edges.find((e) => e.to === nodeId && e.port === 'video');
  const from = edge === undefined ? undefined : flow.nodes.find((n) => n.id === edge.from);
  if (from === undefined) return { mediaId: null, problemRu: 'Подключи ко входу «Видео» генератор видео.' };
  const jobId = from.jobIds[from.selected];
  const mediaId = jobId === undefined ? null : mediaOf(jobId);
  return mediaId === null ? { mediaId: null, problemRu: `У «${nodeTitle(from)}» ещё нет готового видео.` } : { mediaId, problemRu: null };
}

/** Стоимость всех генераторов flow по одному запуску — видна в шапке, запускать всё разом нельзя. */
export function flowCost(flow: Flow): { credits: number; usd: number } {
  let credits = 0;
  let usd = 0;
  for (const node of flow.nodes) {
    if (node.type !== 'generator') continue;
    const model = findModel(node.modelId);
    if (model === undefined) continue;
    const refCount = flow.edges.filter((e) => e.to === node.id && e.port !== 'prompt').length;
    const e = estimate(model, paramsFor(model, node.params), 1, refCount);
    if (e.unitRu === 'кр') credits += e.credits;
    usd += e.usd;
  }
  return { credits: Math.round(credits * 100) / 100, usd: Math.round(usd * 10_000) / 10_000 };
}

/** Ребро не должно замыкать цикл: from не может быть достижим из to. */
export function wouldCycle(flow: Flow, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of flow.edges) if (e.from === id) stack.push(e.to);
  }
  return false;
}
