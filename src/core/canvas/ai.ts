import { findModel } from '../gen/models.ts';
import { isJobNode, outputOf, type CanvasNode, type Flow } from '../model/canvas.ts';
import type { JobRef } from '../model/media.ts';
import { inputFingerprint } from './freshness.ts';

export interface CanvasAiInputContext {
  target: CanvasNode | null;
  contexts: { nodeId: string; text: string }[];
  refs: JobRef[];
  inputFingerprint: string;
  problems: string[];
}

/** A visible prompt block is managed as soon as an idea is connected, before compilation. */
export function promptIdeaSource(flow: Flow, prompt: CanvasNode): CanvasNode | undefined {
  if (prompt.type !== 'prompt') return;
  const edge = flow.edges.find(e => e.to === prompt.id && e.port === 'idea');
  return flow.nodes.find(n => n.id === edge?.from && n.type === 'ai');
}

export const isAiPromptNode = (flow: Flow, prompt: CanvasNode): boolean =>
  prompt.type === 'prompt' && (prompt.aiSource !== undefined || promptIdeaSource(flow, prompt) !== undefined);

/** Server and UI resolve the same graph inputs; no model calls or provider requests. */
export function aiInputContext(flow: Flow, nodeId: string, mediaOf: (jobId: string) => string | null): CanvasAiInputContext {
  const node = flow.nodes.find(n => n.id === nodeId && n.type === 'ai');
  const target = flow.nodes.find(n => n.id === node?.targetGeneratorId && n.type === 'generator') ?? null;
  const result: CanvasAiInputContext = { target, contexts: [], refs: [], inputFingerprint: inputFingerprint(flow, nodeId), problems: [] };
  if (!node) { result.problems.push('AI-нода не найдена.'); return result; }
  if (!target || !findModel(target.modelId)) result.problems.push('Выбери генератор с моделью для этой AI-ноды.');
  for (const edge of flow.edges.filter(e => e.to === nodeId)) {
    const source = flow.nodes.find(n => n.id === edge.from);
    if (!source) { result.problems.push('Источник AI-ноды отсутствует.'); continue; }
    if (edge.port === 'context') {
      if (source.type !== 'comment') { result.problems.push('Во вход «Контекст» подключи комментарий.'); continue; }
      if (source.text.trim()) result.contexts.push({ nodeId: source.id, text: source.text.trim() });
      continue;
    }
    if (edge.port !== 'ref') { result.problems.push('Неподдерживаемый вход AI-ноды.'); continue; }
    if (source.stale) { result.problems.push('Входное изображение устарело. Обнови результат.'); continue; }
    if (outputOf(source) !== 'image') { result.problems.push('AI-нода принимает только изображения в качестве референсов.'); continue; }
    const label = source.label || 'Референс';
    if (source.type === 'image') {
      if (source.source) result.refs.push({ label, source: source.source, role: 'ref' });
      else result.problems.push('В ноде референса нет изображения.');
    } else if (isJobNode(source)) {
      const jobId = source.jobIds[source.selected];
      const mediaId = jobId === undefined ? null : mediaOf(jobId);
      if (!mediaId) result.problems.push('Сначала дождись сохранённого изображения.');
      else if (target?.kind === 'video' && flow.edges.some(e => e.from === source.id && e.to === target.id && e.port === 'start') && (source.acceptedJobId !== jobId || source.acceptedMediaId !== mediaId)) result.problems.push('Сначала прими выбранное фото для видео.');
      else result.refs.push({ label, source: { type: 'media', mediaId }, role: 'ref' });
    } else if (source.mediaId) result.refs.push({ label, source: { type: 'media', mediaId: source.mediaId }, role: 'ref' });
    else result.problems.push('Сначала сохрани результат обработки изображения.');
  }
  if (!result.contexts.length && !node.text.trim()) result.problems.push('Добавь комментарий с идеей или опиши задачу в AI-ноде.');
  return result;
}

/** Persisted approval is a projection; this gate only checks its current graph binding. */
export function aiPromptProblems(flow: Flow, prompt: CanvasNode, targetGeneratorId?: string): string[] {
  if (!isAiPromptNode(flow, prompt)) return [];
  if (!prompt.aiSource) return ['Сначала собери и одобри промпт в ноде AI · промпт.'];
  const source = promptIdeaSource(flow, prompt);
  const version = source?.ai?.prompt;
  const approval = prompt.aiApproval;
  if (!source || source.id !== prompt.aiSource.aiNodeId || !version) return ['Связанный AI-промпт недоступен. Подготовь его заново.'];
  if (source.stale || prompt.stale || prompt.aiSource.inputFingerprint !== inputFingerprint(flow, source.id)) return ['Входы AI-промпта изменились. Перепроверь и одобри его заново.'];
  if (targetGeneratorId !== undefined && source.targetGeneratorId !== targetGeneratorId) return ['AI-промпт подготовлен для другого генератора.'];
  const idea = source.ai?.idea;
  if (!idea?.approval || idea.approval.versionId !== idea.id || idea.approval.inputFingerprint !== prompt.aiSource.inputFingerprint || idea.inputFingerprint !== prompt.aiSource.inputFingerprint || version.parentVersionId !== idea.id) return ['Текущая идея не одобрена или промпт собран по прежней версии идеи. Одобри идею и собери промпт заново.'];
  if (version.id !== prompt.aiSource.versionId || version.inputFingerprint !== prompt.aiSource.inputFingerprint || version.text !== prompt.text) return ['AI-промпт изменён после подготовки. Перепроверь и одобри его заново.'];
  if (!approval || !version.approval || approval.versionId !== version.id || approval.inputFingerprint !== version.inputFingerprint || approval.approvedAt !== version.approval.approvedAt || version.approval.versionId !== version.id || version.approval.inputFingerprint !== version.inputFingerprint) return ['Одобри точную версию AI-промпта перед генерацией.'];
  return [];
}

export const aiApprovalCurrent = (flow: Flow, prompt: CanvasNode, targetGeneratorId?: string): boolean => aiPromptProblems(flow, prompt, targetGeneratorId).length === 0;
