import type { Project } from '../../core/model/project.ts';
import type { Inspection } from './api.ts';

/** A completed batch may finish in an already-open editor, including after reload.
 * Adopt only a newer committed revision while the local editor has no work in flight.
 */
export function preparedProject(local: { project: Project | null; save: string; composing: string | null; critiquing: boolean; planning?: boolean; fixing?: boolean; analyzing?: string | null }, data: Inspection | null): Project | null {
  if (!data?.state || data.state.status === 'running' || !local.project || local.project.slug !== data.project.slug
    || local.save !== 'saved' || local.composing !== null || local.critiquing || local.planning || local.fixing || local.analyzing || data.project.rev <= local.project.rev) return null;
  return data.project;
}
