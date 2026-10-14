import type { GenJob, JobRef, MediaItem } from '../model/media.ts';
import { awaitingFiles } from './jobStatus.ts';

export function parentMediaId(refs: readonly JobRef[]): string | null {
  const ref = refs.find((r) => r.source.type === 'media');
  return ref?.source.type === 'media' ? ref.source.mediaId : null;
}

/** Follow the whole edit family, including edits of edits and failed attempts. */
export function mediaVersions(item: MediaItem, library: readonly MediaItem[], jobs: readonly GenJob[]): { done: MediaItem[]; pending: GenJob[] } {
  const byId = new Map([...library, item].map((m) => [m.id, m]));
  let root = item;
  const visited = new Set<string>();
  while (!visited.has(root.id)) {
    visited.add(root.id);
    const parent = parentMediaId(root.refs);
    const next = parent === null ? undefined : byId.get(parent);
    if (next === undefined || visited.has(next.id)) break;
    root = next;
  }
  const family = new Set([root.id, item.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of byId.values()) if (!family.has(m.id) && family.has(parentMediaId(m.refs) ?? '')) { family.add(m.id); changed = true; }
  }
  return {
    done: [...byId.values()].filter((m) => family.has(m.id)).sort((a, b) => a.savedAt.localeCompare(b.savedAt)),
    pending: jobs.filter((j) => (j.status !== 'saved' || awaitingFiles(j, library)) && family.has(parentMediaId(j.refs) ?? '')),
  };
}
