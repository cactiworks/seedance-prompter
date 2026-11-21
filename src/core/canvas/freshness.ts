import type { CanvasNode, Flow } from '../model/canvas.ts';

const config = (n: CanvasNode): string => {
  const fields = [n.type, n.type === 'seedance' ? null : n.text, n.source, n.modelId, n.params, n.which, n.start, n.end, n.width, n.height, n.fit, n.kind, n.type === 'ai' ? n.targetGeneratorId : null, n.aiSource];
  return JSON.stringify(n.type === 'references' ? [...fields, n.libraryRefs ?? []] : fields);
};
const output = (n: CanvasNode): string => JSON.stringify([config(n), n.mediaId, n.jobIds[n.selected], n.stale, n.acceptedMediaId, n.acceptedJobId, n.ai?.idea, n.ai?.prompt, n.aiApproval]);
const processed = (n: CanvasNode): boolean => !['comment', 'prompt', 'image', 'video', 'references'].includes(n.type);
/** Settings are a dependency, while the target's generated result is not an AI input. */
const targetConfig = (flow: Flow, node: CanvasNode): string => {
  if (node.type !== 'ai') return '';
  const target = flow.nodes.find(n => n.id === node.targetGeneratorId && n.type === 'generator');
  if (!target) return 'null';
  // Only provider-bound media inputs are reverse dependencies. Following the
  // target's prompt edge would include this AI's own result and form a cycle.
  const edges = flow.edges.filter(e => e.to === target.id && ['ref', 'start', 'end'].includes(e.port));
  const queue = edges.map(e => e.from);
  const seen = new Set<string>();
  const sources: string[] = [];
  const upstreamEdges = [...edges];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    if (seen.has(id) || id === node.id || id === target.id) continue;
    seen.add(id);
    const source = flow.nodes.find(n => n.id === id);
    if (source) sources.push(`${id}:${output(source)}`);
    for (const edge of flow.edges.filter(e => e.to === id)) {
      if (edge.from === node.id || edge.from === target.id) continue;
      upstreamEdges.push(edge); queue.push(edge.from);
    }
  }
  return JSON.stringify([target.id, target.kind, target.modelId, target.params, target.text, upstreamEdges, sources.sort()]);
};

/** Keep old files as history, but never pass them downstream as a current result. */
export function invalidateChanged(previous: Flow, next: Flow): Flow {
  const stale = new Set<string>();
  const changed = new Set<string>();
  for (const node of next.nodes) {
    const old = previous.nodes.find((n) => n.id === node.id);
    if (old === undefined) continue;
    if (config(old) !== config(node) && processed(node)) stale.add(node.id);
    if (targetConfig(previous, old) !== targetConfig(next, node)) stale.add(node.id);
    if (output(old) !== output(node)) changed.add(node.id);
  }
  for (const edge of [...previous.edges, ...next.edges]) {
    const other = (previous.edges.includes(edge) ? next.edges : previous.edges);
    if (!other.some((e) => e.from === edge.from && e.to === edge.to && e.port === edge.port)) stale.add(edge.to);
  }
  const queue = [...changed, ...stale];
  const seen = new Set<string>();
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i] as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of next.edges) if (edge.from === id) { stale.add(edge.to); queue.push(edge.to); }
  }
  return { ...next, nodes: next.nodes.map((n) => stale.has(n.id) ? { ...n, stale: true } : n) };
}

/** Captured before an async operation; excludes its own result, includes all upstream versions. */
export function inputFingerprint(flow: Flow, id: string): string {
  const node = flow.nodes.find((n) => n.id === id);
  const seen = new Set<string>();
  const queue = [id];
  const upstream: string[] = [];
  for (let i = 0; i < queue.length; i += 1) {
    for (const edge of flow.edges.filter((e) => e.to === queue[i])) {
      const from = flow.nodes.find((n) => n.id === edge.from);
      if (from !== undefined && !seen.has(from.id)) { seen.add(from.id); upstream.push(`${from.id}:${output(from)}`); queue.push(from.id); }
    }
  }
  return JSON.stringify([node === undefined ? null : config(node), flow.edges.filter((e) => seen.has(e.to) || e.to === id), upstream.sort(), node === undefined ? '' : targetConfig(flow, node)]);
}
