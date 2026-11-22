import { z } from 'zod';

export const REFERENCE_FOLDERS = {
  portrait: 'Портрет и герой',
  details: 'Детали и макро',
  fashion: 'Fashion и стайлинг',
  camera: 'Камера и фрейминг',
  space: 'Space и 3D',
  graphics: 'Графика и коллаж',
  motion: 'Motion и ритм',
  ai: 'AI, VFX и Tutorials',
} as const;

export type ReferenceFolder = keyof typeof REFERENCE_FOLDERS;
export const ReferenceFolderSchema = z.enum(Object.keys(REFERENCE_FOLDERS) as ReferenceFolder[]);
export const MAX_REFERENCE_SELECTIONS = 4;
export const ReferenceSelectionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  version: z.number().int().positive(),
  role: z.string().trim().min(1).max(240),
});
export type ReferenceSelection = z.infer<typeof ReferenceSelectionSchema>;

export interface ReferenceAnalysis {
  visible: string;
  technique: string;
  transfer: string;
  subject: string;
  pose: string;
  composition: string;
  angle: string;
  lighting: string;
  color: string;
  texture: string;
  styling: string;
}

export interface ReferenceCard {
  id: string;
  sourceName: string;
  timeMs: number | null;
  version: number;
  folder: ReferenceFolder | null;
  tags: string[];
  analysis: ReferenceAnalysis | null;
  quality?: {
    status: 'pending' | 'keep' | 'reject' | 'uncertain';
    reason: string;
    duplicateOf?: string;
    retainedBecauseReferenced?: boolean;
  };
  eligible?: boolean;
  dedup?: ReferenceDedupDecision;
}

export interface ReferenceDedupDecision {
  status: 'pending' | 'keep' | 'duplicate';
  reason: string;
  duplicateOf?: string;
  method?: string;
  retainedBecauseReferenced?: boolean;
}

export interface ReferenceAnalysisJob {
  status: 'running' | 'done' | 'stopped' | 'error';
  total: number;
  completed: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  phase?: 'quality' | 'dedup' | 'analysis';
  reviewed?: number;
  kept?: number;
  rejected?: number;
  uncertain?: number;
  duplicates?: number;
  dedupTotal?: number;
  dedupCompleted?: number;
}

export interface ReferenceQualityAudit {
  total: number;
  pending: number;
  kept: number;
  rejected: number;
  uncertain: number;
  analyzed: number;
  eligible: number;
  retainedReferenced: number;
  pendingWork: number;
  scopeDigest: string;
  reasons: { reason: string; count: number }[];
  decisions: {
    id: string;
    sourceName: string;
    timeMs: number | null;
    status: 'pending' | 'keep' | 'reject' | 'uncertain';
    reason: string;
    duplicateOf?: string;
    criteriaVersion?: number;
    imageSha256?: string;
    promptHash?: string;
    model?: string | null;
    at?: string;
    retainedBecauseReferenced?: boolean;
    dedup?: ReferenceDedupDecision;
  }[];
  duplicates?: number;
  dedupPending?: number;
}

export const isReferenceEligible = (card: ReferenceCard | undefined): card is ReferenceCard =>
  card?.eligible === true && card.quality?.status === 'keep' && card.analysis !== null;

export interface ReferenceMatch {
  refId: string;
  role: string;
  reason: string;
}

export interface ReferenceTurn {
  id: string;
  brief: string;
  query: string;
  summary: string;
  matches: ReferenceMatch[];
}

export interface ReferenceThread {
  turns: ReferenceTurn[];
  selection: ReferenceSelection[];
}
