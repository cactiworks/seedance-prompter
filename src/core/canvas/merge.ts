import type { CanvasEdge, CanvasNode, CanvasSection, Flow } from '../model/canvas.ts';

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Apply only the caller's changes; fields received from the server in the meantime survive. */
function fields<T extends object>(base: T, desired: T, current: T): T {
  const next = { ...current } as Record<string, unknown>;
  const before = base as Record<string, unknown>; const after = desired as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (equal(before[key], after[key])) continue;
    if (Object.hasOwn(after, key)) next[key] = after[key]; else delete next[key];
  }
  return next as T;
}

function mergeNode(base: CanvasNode, desired: CanvasNode, current: CanvasNode): CanvasNode {
  const next = fields(base, desired, current);
  next.params = fields(base.params, desired.params, current.params);
  next.refSync = fields(base.refSync, desired.refSync, current.refSync);
  const removed = new Set(base.jobIds.filter(id => !desired.jobIds.includes(id)));
  next.jobIds = [...new Set([...current.jobIds.filter(id => !removed.has(id)), ...desired.jobIds.filter(id => !base.jobIds.includes(id))])];
  const beforeJob = base.jobIds[base.selected]; const desiredJob = desired.jobIds[desired.selected];
  const selectedJob = desiredJob !== beforeJob ? desiredJob : current.jobIds[current.selected];
  next.selected = Math.max(0, selectedJob === undefined ? 0 : next.jobIds.indexOf(selectedJob));
  return next;
}

function entities<T extends { id: string }>(base: T[], desired: T[], current: T[], merge: (before: T, after: T, latest: T) => T): T[] {
  const before = new Map(base.map(value => [value.id, value]));
  const after = new Map(desired.map(value => [value.id, value]));
  const latest = new Map(current.map(value => [value.id, value]));
  for (const value of base) if (!after.has(value.id)) latest.delete(value.id);
  for (const value of desired) {
    const old = before.get(value.id); const present = latest.get(value.id);
    if (old === undefined) {
      // A replayed addition must not replace a node that has since received AI results.
      if (present === undefined) latest.set(value.id, value);
    } else if (present !== undefined) latest.set(value.id, merge(old, value, present));
    // Concurrent deletion wins; an old tab cannot resurrect a removed entity.
  }
  const retainedBefore = base.filter(value => after.has(value.id)).map(value => value.id);
  const retainedAfter = desired.filter(value => before.has(value.id)).map(value => value.id);
  const reordered = !equal(retainedBefore, retainedAfter);
  const ordered = reordered ? [...desired, ...current] : [...current, ...desired];
  const seen = new Set<string>();
  return ordered.flatMap(value => {
    const result = latest.get(value.id);
    if (result === undefined || seen.has(value.id)) return [];
    seen.add(value.id); return [result];
  });
}

/**
 * Three-way merge for server saves and acknowledgements. Pure and browser safe.
 * Deletions win over concurrent edits. Same-field edits use the caller's value;
 * the storage layer retains the previous revisions and conflicting submission.
 * Callers validate the resulting graph and recompute freshness before saving.
 */
export function mergeCanvasFlow(base: Flow, desired: Flow, current: Flow): Flow {
  const next = fields(base, desired, current);
  next.id = current.id; next.rev = current.rev; next.createdAt = current.createdAt; next.updatedAt = current.updatedAt;
  next.viewport = fields(base.viewport, desired.viewport, current.viewport);
  next.nodes = entities(base.nodes, desired.nodes, current.nodes, mergeNode);
  next.edges = entities<CanvasEdge>(base.edges, desired.edges, current.edges, fields);
  // A deleted node also removes any concurrently attached edges.
  const nodeIds = new Set(next.nodes.map(node => node.id));
  next.edges = next.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const sections = entities<CanvasSection>(base.sections ?? [], desired.sections ?? [], current.sections ?? [], fields);
  const sectionIds = new Set(sections.map(section => section.id));
  for (const [index, node] of next.nodes.entries()) {
    if (node.sectionId !== undefined && !sectionIds.has(node.sectionId)) next.nodes[index] = { ...node, sectionId: undefined };
  }
  const occupiedSections = new Set(next.nodes.map(node => node.sectionId));
  const retainedSections = sections.filter(section => occupiedSections.has(section.id));
  if (retainedSections.length > 0) next.sections = retainedSections;
  else delete next.sections;
  return next;
}

/** Deleted groups and removed members can discard an edit that should be recoverable. */
export function canvasSectionEditsLost(base: Flow, desired: Flow, merged: Flow): boolean {
  const oldSections = new Map(base.sections?.map(section => [section.id, section.title]));
  const mergedSections = new Map(merged.sections?.map(section => [section.id, section.title]));
  if (desired.sections?.some(section => oldSections.get(section.id) !== section.title && mergedSections.get(section.id) !== section.title)) return true;
  const oldMembership = new Map(base.nodes.map(node => [node.id, node.sectionId]));
  const mergedMembership = new Map(merged.nodes.map(node => [node.id, node.sectionId]));
  return desired.nodes.some(node => oldMembership.get(node.id) !== node.sectionId && mergedMembership.get(node.id) !== node.sectionId);
}
