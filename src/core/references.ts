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
}

export interface ReferenceAnalysisJob {
  status: 'running' | 'done' | 'stopped' | 'error';
  total: number;
  completed: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

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
