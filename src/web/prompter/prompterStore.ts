import { create } from 'zustand';
import type { MediaKind } from '../../core/gen/models.ts';
import type { PrompterRequest, PrompterResult } from '../../core/llm/buildPrompter.ts';

const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };
const HISTORY_KEY = 'sp-prompter-history';
const HISTORY_MAX = 20;

/** Одна попытка промптера: что просили и что агент ответил. Хранится в браузере — это черновики, не данные. */
export interface PrompterEntry {
  id: string;
  createdAt: string;
  ideaRu: string;
  kind: MediaKind;
  /** 'auto' или id модели, выбранной владельцем. */
  choice: string;
  commentRu: string;
  result: PrompterResult;
  /** Замечания проверки, которые агент не исправил за ремонтный круг (по-английски, как их видел агент). */
  problems: string[];
  llmModel: string | null;
  durationMs: number;
}

function readHistory(): PrompterEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw === null ? [] : (JSON.parse(raw) as unknown);
    return Array.isArray(list) ? (list as PrompterEntry[]).slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function writeHistory(list: PrompterEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {
    /* не запомним — результат всё равно на экране */
  }
}

interface PrompterState {
  ideaRu: string;
  kind: MediaKind;
  choice: string;
  history: PrompterEntry[];
  /** Какая запись истории на экране. */
  currentId: string | null;
  running: boolean;
  error: string | null;
  setIdea: (ideaRu: string) => void;
  setKind: (kind: MediaKind) => void;
  setChoice: (choice: string) => void;
  open: (id: string) => void;
  remove: (id: string) => void;
  /** Только по клику: вызов агента тратит квоту подписки. С `commentRu` — переписать текущую запись. */
  write: (commentRu?: string) => Promise<void>;
  cancel: () => void;
}

let controller: AbortController | null = null;

export const usePrompter = create<PrompterState>((set, get) => {
  const history = readHistory();
  return {
    ideaRu: history[0]?.ideaRu ?? '',
    kind: history[0]?.kind ?? 'image',
    choice: history[0]?.choice ?? 'auto',
    history,
    currentId: history[0]?.id ?? null,
    running: false,
    error: null,
    setIdea: (ideaRu) => set({ ideaRu }),
    setKind: (kind) => set({ kind, choice: 'auto' }),
    setChoice: (choice) => set({ choice }),
    open: (id) => {
      const entry = get().history.find((e) => e.id === id);
      if (entry !== undefined) set({ currentId: id, ideaRu: entry.ideaRu, kind: entry.kind, choice: entry.choice, error: null });
    },
    remove: (id) => {
      const list = get().history.filter((e) => e.id !== id);
      writeHistory(list);
      set((s) => ({ history: list, currentId: s.currentId === id ? (list[0]?.id ?? null) : s.currentId }));
    },
    cancel: () => controller?.abort(),
    write: async (commentRu) => {
      const { ideaRu, kind, choice, history: list, currentId } = get();
      const previous = commentRu === undefined ? undefined : list.find((e) => e.id === currentId);
      const body: PrompterRequest = {
        ideaRu,
        kind: previous?.kind ?? kind,
        modelId: previous?.choice ?? choice,
        ...(previous !== undefined ? { commentRu, previous: { modelId: previous.result.modelId, prompt: previous.result.prompt, params: previous.result.params, styleName: previous.result.styleName } } : {}),
      };
      controller = new AbortController();
      set({ running: true, error: null });
      try {
        const res = await fetch('/api/llm/prompter', { method: 'POST', headers: HEADERS, body: JSON.stringify(body), signal: controller.signal });
        const data = (await res.json().catch(() => ({}))) as { result?: PrompterResult; problems?: string[]; meta?: { model: string | null; durationMs: number }; messageRu?: string; error?: string };
        if (!res.ok || data.result === undefined) throw new Error(data.messageRu ?? data.error ?? `HTTP ${res.status}`);
        const entry: PrompterEntry = {
          id: `p${Date.now().toString(36)}`,
          createdAt: new Date().toISOString(),
          ideaRu: body.ideaRu,
          kind: body.kind,
          choice: body.modelId,
          commentRu: commentRu ?? '',
          result: data.result,
          problems: data.problems ?? [],
          llmModel: data.meta?.model ?? null,
          durationMs: data.meta?.durationMs ?? 0,
        };
        const next = [entry, ...get().history];
        writeHistory(next);
        set({ history: next.slice(0, HISTORY_MAX), currentId: entry.id, running: false });
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        set({ running: false, error: aborted ? null : error instanceof Error ? error.message : 'Промптер не сработал.' });
      } finally {
        controller = null;
      }
    },
  };
});
