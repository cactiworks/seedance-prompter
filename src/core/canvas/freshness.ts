import type { CanvasNode, Flow } from '../model/canvas.ts';

const config = (n: CanvasNode): string => JSON.stringify([n.type, n.type === 'seedance' ? null : n.text, n.source, n.modelId, n.params, n.which, n.start, n.end, n.width, n.height, n.fit, n.kind]);
const output = (n: CanvasNode): string => JSON.stringify([config(n), n.mediaId, n.jobIds[n.selected], n.stale]);
const processed = (n: CanvasNode): boolean => !['prompt', 'image', 'video'].includes(n.type);

/** Keep old files as history, but never pass them downstream as a current result. */
export function invalidateChanged(previous: Flow, next: Flow): Flow {
  const stale = new Set<string>();
  const changed = new Set<string>();
  for (const node of next.nodes) {
    const old = previous.nodes.find((n) => n.id === node.id);
    if (old === undefined) continue;
    if (config(old) !== config(node) && processed(node)) stale.add(node.id);
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
  return JSON.stringify([node === undefined ? null : config(node), flow.edges.filter((e) => seen.has(e.to) || e.to === id), upstream.sort()]);
}
