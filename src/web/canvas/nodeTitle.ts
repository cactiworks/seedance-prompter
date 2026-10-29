import type { CanvasNode } from '../../core/model/canvas.ts';
import { nodeTitle as sourceTitle } from '../../core/canvas/plan.ts';
import { findModel, paramsFor, upscaleModelOf } from '../../core/gen/models.ts';
import { ui } from '../language.ts';

/** Translate tool names, retaining creator-supplied image/video labels verbatim. */
export function nodeTitle(node: CanvasNode): string {
  if ((node.type === 'image' || node.type === 'video') && node.label) return node.label;
  if (node.type === 'resize') return `${ui('Размер')} · ${node.width}×${node.height}`;
  if (node.type === 'upscale') return `${ui('Апскейл Topaz')} · ${String(paramsFor(upscaleModelOf(node.kind), node.params).upscaleFactor)}×`;
  if (node.type === 'generator') return `${ui(node.kind === 'image' ? 'Картинка' : 'Видео')} · ${findModel(node.modelId)?.titleRu ?? 'model'}`;
  return ui(sourceTitle(node));
}
