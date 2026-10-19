import { studioFetch as fetch } from '../remoteFetch.ts';
import { create } from 'zustand';
import type { CalibrationPack, Learning, Verdict, VerdictEntry } from '../../core/gen/calibration.ts';

const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init === undefined ? undefined : { ...init, headers: HEADERS });
  const data = (await res.json().catch(() => ({}))) as T & { messageRu?: string };
  if (!res.ok) throw new Error(data.messageRu ?? `HTTP ${res.status}`);
  return data;
}

interface JournalState {
  pack: CalibrationPack | null;
  verdicts: VerdictEntry[];
  learnings: Learning[];
  error: string | null;
  loaded: boolean;
  /** Что открыто: id набора или 'journal'; '' — первый набор. */
  selected: string;
  select: (id: string) => void;
  load: () => Promise<void>;
  /** Оценка сохраняется сразу — журнал не требует кнопки «Сохранить». */
  setVerdict: (mediaId: string, patch: { verdict: Verdict; symptoms?: string[]; noteRu?: string }) => Promise<void>;
  clearVerdict: (mediaId: string) => Promise<void>;
  addLearning: (modelId: string, textRu: string, evidence: string[]) => Promise<void>;
  removeLearning: (id: string) => Promise<void>;
}

export const useJournal = create<JournalState>((set, get) => {
  const guard = async (action: () => Promise<Partial<JournalState>>): Promise<void> => {
    try {
      set({ ...(await action()), error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Журнал не ответил.' });
    }
  };
  return {
    pack: null,
    verdicts: [],
    learnings: [],
    error: null,
    loaded: false,
    selected: '',
    select: (selected) => set({ selected }),
    load: () =>
      guard(async () => {
        const [pack, verdicts, learnings] = await Promise.all([request<CalibrationPack>('/api/calibration'), request<VerdictEntry[]>('/api/verdicts'), request<Learning[]>('/api/learnings')]);
        return { pack, verdicts, learnings, loaded: true };
      }),
    setVerdict: (mediaId, patch) =>
      guard(async () => {
        const current = get().verdicts.find((v) => v.mediaId === mediaId);
        // Годно — симптомы не нужны; смена оценки их не теряет, пока владелец сам не снимет.
        const symptoms = patch.verdict === 'good' ? [] : (patch.symptoms ?? current?.symptoms ?? []);
        const body = { verdict: patch.verdict, symptoms, noteRu: patch.noteRu ?? current?.noteRu ?? '' };
        return { verdicts: await request<VerdictEntry[]>(`/api/verdicts/${mediaId}`, { method: 'PUT', body: JSON.stringify(body) }) };
      }),
    clearVerdict: (mediaId) => guard(async () => ({ verdicts: await request<VerdictEntry[]>(`/api/verdicts/${mediaId}`, { method: 'DELETE' }) })),
    addLearning: (modelId, textRu, evidence) => guard(async () => ({ learnings: await request<Learning[]>('/api/learnings', { method: 'POST', body: JSON.stringify({ modelId, textRu, evidence }) }) })),
    removeLearning: (id) => guard(async () => ({ learnings: await request<Learning[]>(`/api/learnings/${id}`, { method: 'DELETE' }) })),
  };
});
