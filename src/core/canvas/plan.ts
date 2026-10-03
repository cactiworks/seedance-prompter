import { estimate, findModel, paramsFor, upscaleModelOf, validateGen, type Estimate, type GenModel, type GenParams, type RefRole } from '../gen/models.ts';
import { isJobNode, outputOf, type CanvasNode, type Flow, type InputPort } from '../model/canvas.ts';
import type { JobRef, RefSource } from '../model/media.ts';

/** Что уйдёт в модель при запуске ноды-генератора. Считается из графа, без сети. */
export interface RunPlan {
  modelId: string;
  prompt: string;
  params: GenParams;
  refs: JobRef[];
  estimate: Estimate | null;
  problems: string[];
}

const ROLE_OF: Record<Exclude<InputPort, 'prompt' | 'video' | 'media'>, RefRole> = { ref: 'ref', start: 'start', end: 'end' };

export const nodeTitle = (node: CanvasNode): string => {
  if (node.type === 'prompt') return 'Промпт';
  if (node.type === 'image') return node.label !== '' ? node.label : 'Картинка';
  if (node.type === 'frame') return node.which === 'last' ? 'Последний кадр видео' : 'Первый кадр видео';
  if (node.type === 'trim') return 'Обрезка видео';
  if (node.type === 'video') return node.label !== '' ? node.label : 'Видео';
  if (node.type === 'resize') return `Размер · ${node.width}×${node.height}`;
  if (node.type === 'seedance') return 'Seedance-промптер';
  if (node.type === 'upscale') return `Апскейл Topaz · ${String(paramsFor(upscaleModelOf(node.kind), node.params).upscaleFactor)}×`;
  return `${node.kind === 'image' ? 'Картинка' : 'Видео'} · ${findModel(node.modelId)?.titleRu ?? 'модель'}`;
};

/** Модель ноды: у генератора — выбранная, у апскейла — Topaz для вида входа. */
export const modelOfNode = (node: CanvasNode): GenModel | undefined => (node.type === 'upscale' ? upscaleModelOf(node.kind) : node.type === 'generator' ? findModel(node.modelId) : undefined);

/** Ключ источника, для которого нода апскейла хранит замер (`params.measuredFor`): сменился вход — мерить заново. */
export const sourceKey = (source: RefSource): string => JSON.stringify(source);

/**
 * Апскейл (решение 39): вход «Файл» → Topaz для картинки или видео. Длинную сторону / секунды мерит сервер, нода хранит
 * замер в params вместе с ключом источника; пока замера для текущего входа нет — запуск закрыт (цена была бы выдумана).
 */
function planUpscale(flow: Flow, node: CanvasNode, mediaOf: (jobId: string) => string | null): RunPlan {
  const model = upscaleModelOf(node.kind);
  const input = mediaInput(flow, node.id, mediaOf);
  const params = paramsFor(model, node.params);
  if (input.source === null) return { modelId: model.id, prompt: '', params, refs: [], estimate: estimate(model, params), problems: [input.problemRu ?? 'Подключи ко входу «Файл» картинку или видео.'] };
  const refs: JobRef[] = [{ label: 'Апскейл', source: input.source, role: 'ref' }];
  const problems = node.params.measuredFor === sourceKey(input.source) ? [] : ['Меряю исходник…'];
  problems.push(...validateGen(model, '', params, ['ref']));
  return { modelId: model.id, prompt: '', params, refs, estimate: estimate(model, params, 1, 1), problems };
}

/**
 * `mediaOf(jobId)` — сохранённый файл задачи или null. Генератор выше по графу отдаёт выбранный вариант;
 * если он ещё не запускался — запуск запрещён: сам он не запустится (ниже по графу ничего не стартует
 * без клика), а молча отправить модель без входа значит потратить деньги впустую.
 */
export function planRun(flow: Flow, nodeId: string, mediaOf: (jobId: string) => string | null): RunPlan {
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (node?.type === 'upscale') return planUpscale(flow, node, mediaOf);
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
    if (edge.port === 'prompt' || edge.port === 'video' || edge.port === 'media') continue;
    const from = source(edge.from);
    if (from === undefined) continue;
    const role = ROLE_OF[edge.port];
    if (from.type === 'frame' || from.type === 'resize') {
      // «Размер» мог сменить вид после того, как связь провели (импортированный flow): видео во вход картинки не идёт.
      if (outputOf(from) === 'video') problems.push(`«${nodeTitle(from)}» отдаёт видео — во вход картинки оно не подаётся.`);
      else if (from.mediaId === null) problems.push(from.type === 'frame' ? `Сначала извлеки кадр в ноде «${nodeTitle(from)}».` : `Сначала подгони размер в ноде «${nodeTitle(from)}».`);
      else refs.push({ label: nodeTitle(from), source: { type: 'media', mediaId: from.mediaId }, role });
    } else if (from.type === 'image') {
      if (from.source === null) problems.push(`В ноде «${nodeTitle(from)}» нет картинки.`);
      else refs.push({ label: nodeTitle(from), source: from.source, role });
    } else if (isJobNode(from)) {
      if (from.type === 'seedance' || from.kind === 'video') {
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

/**
 * Видео на входе «Видео» (кадр и обрезка): выбранный вариант генератора видео или готовый файл обрезки выше по
 * графу — либо причина, почему его нет.
 */
export function frameInput(flow: Flow, nodeId: string, mediaOf: (jobId: string) => string | null): { mediaId: string | null; problemRu: string | null } {
  const edge = flow.edges.find((e) => e.to === nodeId && e.port === 'video');
  const from = edge === undefined ? undefined : flow.nodes.find((n) => n.id === edge.from);
  if (from === undefined) return { mediaId: null, problemRu: 'Подключи ко входу «Видео» генератор видео или обрезку.' };
  if (outputOf(from) !== 'video') return { mediaId: null, problemRu: `«${nodeTitle(from)}» отдаёт картинку, а сюда нужно видео.` };
  if (from.type === 'trim') return from.mediaId === null ? { mediaId: null, problemRu: `Сначала обрежь видео в ноде «${nodeTitle(from)}».` } : { mediaId: from.mediaId, problemRu: null };
  if (from.type === 'video') return from.mediaId === null ? { mediaId: null, problemRu: `Выбери видео в ноде «${nodeTitle(from)}».` } : { mediaId: from.mediaId, problemRu: null };
  if (from.type === 'resize') return from.mediaId === null ? { mediaId: null, problemRu: `Сначала подгони размер в ноде «${nodeTitle(from)}».` } : { mediaId: from.mediaId, problemRu: null };
  const jobId = from.jobIds[from.selected];
  const mediaId = jobId === undefined ? null : mediaOf(jobId);
  return mediaId === null ? { mediaId: null, problemRu: `У «${nodeTitle(from)}» ещё нет готового видео.` } : { mediaId, problemRu: null };
}

/**
 * Что пришло во вход «Файл» ноды «Размер»: источник для ffmpeg (картинка с диска, файл библиотеки, выбранный вариант
 * генератора) и его вид — от вида зависит выход ноды.
 */
export function mediaInput(flow: Flow, nodeId: string, mediaOf: (jobId: string) => string | null): { source: RefSource | null; kind: 'image' | 'video'; problemRu: string | null } {
  const edge = flow.edges.find((e) => e.to === nodeId && e.port === 'media');
  const from = edge === undefined ? undefined : flow.nodes.find((n) => n.id === edge.from);
  if (from === undefined) return { source: null, kind: 'image', problemRu: 'Подключи ко входу «Файл» картинку или видео.' };
  const kind = outputOf(from) === 'video' ? 'video' : 'image';
  if (from.type === 'image') return from.source === null ? { source: null, kind, problemRu: `В ноде «${nodeTitle(from)}» нет картинки.` } : { source: from.source, kind, problemRu: null };
  if (isJobNode(from)) {
    const jobId = from.jobIds[from.selected];
    const mediaId = jobId === undefined ? null : mediaOf(jobId);
    return mediaId === null ? { source: null, kind, problemRu: `Сначала запусти «${nodeTitle(from)}» и дождись результата.` } : { source: { type: 'media', mediaId }, kind, problemRu: null };
  }
  return from.mediaId === null ? { source: null, kind, problemRu: `В ноде «${nodeTitle(from)}» ещё нет файла.` } : { source: { type: 'media', mediaId: from.mediaId }, kind, problemRu: null };
}

/** Отрезок обрезки: конец 0 — до конца видео. Проверки — по-русски, для подписи в ноде. */
export function trimProblems(start: number, end: number, duration: number | null): string[] {
  const problems: string[] = [];
  if (start < 0 || end < 0) problems.push('Время не бывает отрицательным.');
  if (end !== 0 && end - start < 0.2) problems.push('Конец должен быть позже начала хотя бы на 0.2 с.');
  if (duration !== null && start >= duration) problems.push(`Начало за концом видео (${duration.toFixed(1)} с).`);
  if (duration !== null && end > duration + 0.05) problems.push(`Конец за концом видео (${duration.toFixed(1)} с).`);
  return problems;
}

/** Стоимость всех генераторов flow по одному запуску — видна в шапке, запускать всё разом нельзя. */
export function flowCost(flow: Flow): { credits: number; usd: number } {
  let credits = 0;
  let usd = 0;
  for (const node of flow.nodes) {
    // Апскейл считается по последнему замеру входа (до замера — по умолчанию модели: 1024 px / 5 с).
    const model = modelOfNode(node);
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
