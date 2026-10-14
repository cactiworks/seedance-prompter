import { create } from 'zustand';
import type { MediaKind } from '../../core/gen/models.ts';
import { EMPTY_SHOT, PROMPTER_MAX_REFS, type PrompterRefRole, type PrompterRequest, type PrompterResult, type PrompterShot, type PrompterTemplate } from '../../core/llm/buildPrompter.ts';
import type { Moodboard, RefSource } from '../../core/model/media.ts';
import { thumbOf, uploadImage } from '../gen/genStore.ts';
import { downscale } from '../store.ts';

const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };
const HISTORY_KEY = 'sp-prompter-history';
const HISTORY_MAX = 20;
const CONSENT_KEY = 'sp-prompter-images-consent-openai-v1';

/** Картинка в форме промптера: откуда она, зачем (роль) и что о ней сказал владелец. */
export interface PrompterFormRef {
  key: string;
  label: string;
  source: RefSource;
  role: PrompterRefRole;
  commentRu: string;
}

/** Одна попытка промптера: форма целиком и ответ агента. Хранится в браузере — это черновики, не данные. */
export interface PrompterEntry {
  id: string;
  createdAt: string;
  ideaRu: string;
  kind: MediaKind;
  /** 'auto' или id модели, выбранной владельцем. */
  choice: string;
  /** id шаблона, '' — свободно. */
  template: string;
  shot: PrompterShot;
  refs: PrompterFormRef[];
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
    // Записи до референсов и секций — без этих полей.
    return Array.isArray(list) ? (list as PrompterEntry[]).slice(0, HISTORY_MAX).map((e) => ({ ...e, template: e.template ?? '', shot: { ...EMPTY_SHOT, ...e.shot }, refs: e.refs ?? [], result: { ...e.result, refs: e.result.refs ?? [] } })) : [];
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

/** Согласие показывать картинки агенту (они уходят в OpenAI через Codex) — до закрытия вкладки. */
export function hasImagesConsent(): boolean {
  try {
    return sessionStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}
export function rememberImagesConsent(): void {
  try {
    sessionStorage.setItem(CONSENT_KEY, '1');
  } catch {
    /* спросим снова */
  }
}

/** Уменьшенная копия ≤1568 px в base64 — как у vision-анализа «Кадров»: меньше токенов, без библиотек на сервере. */
async function visionCopy(source: RefSource): Promise<{ mediaType: 'image/jpeg'; base64: string }> {
  const res = await fetch(thumbOf(source));
  if (!res.ok) throw new Error('Картинка референса не открылась — возможно, файл удалён.');
  const blob = await downscale(new File([await res.blob()], 'ref'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType: 'image/jpeg', base64: btoa(binary) };
}

let seq = 0;
const nextKey = (): string => `pr${Date.now().toString(36)}${(seq += 1)}`;
const defaultRole = (kind: MediaKind, count: number): PrompterRefRole => (kind === 'video' && count === 0 ? 'start' : 'other');

interface PrompterState {
  ideaRu: string;
  kind: MediaKind;
  choice: string;
  template: string;
  templates: PrompterTemplate[];
  moodboards: Moodboard[];
  /** Шаблоны и свои мудборды — один раз при открытии вкладки. */
  loadMeta: () => Promise<void>;
  setTemplate: (id: string) => void;
  /** Картинки мудборда — референсами «Стиль» с комментарием-именем. */
  addMoodboard: (id: string) => void;
  /** Текущие референсы «Стиль» — в новый мудборд. */
  saveMoodboard: (name: string) => Promise<void>;
  deleteMoodboard: (id: string) => Promise<void>;
  shot: PrompterShot;
  refs: PrompterFormRef[];
  history: PrompterEntry[];
  /** Какая запись истории на экране. */
  currentId: string | null;
  running: boolean;
  error: string | null;
  setIdea: (ideaRu: string) => void;
  setKind: (kind: MediaKind) => void;
  setChoice: (choice: string) => void;
  setShot: (patch: Partial<PrompterShot>) => void;
  addFiles: (files: File[]) => Promise<void>;
  addSource: (source: RefSource, label: string) => void;
  patchRef: (key: string, patch: Partial<Pick<PrompterFormRef, 'role' | 'commentRu'>>) => void;
  moveRef: (key: string, delta: -1 | 1) => void;
  removeRef: (key: string) => void;
  /** Начать заново: пустая форма, история остаётся. */
  reset: () => void;
  open: (id: string) => void;
  remove: (id: string) => void;
  /** Только по клику: вызов агента тратит квоту подписки. С `commentRu` — переписать текущую запись. */
  write: (commentRu?: string) => Promise<void>;
  cancel: () => void;
}

let controller: AbortController | null = null;

export const usePrompter = create<PrompterState>((set, get) => {
  const history = readHistory();
  const last = history[0];
  const pushRef = (source: RefSource, label: string): void =>
    set((s) => (s.refs.length >= PROMPTER_MAX_REFS ? { error: `Не больше ${PROMPTER_MAX_REFS} картинок.` } : { refs: [...s.refs, { key: nextKey(), label, source, role: defaultRole(s.kind, s.refs.length), commentRu: '' }], error: null }));
  const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(url, init === undefined ? undefined : { ...init, headers: HEADERS });
    const data = (await res.json().catch(() => ({}))) as T & { messageRu?: string };
    if (!res.ok) throw new Error(data.messageRu ?? `HTTP ${res.status}`);
    return data;
  };
  return {
    ideaRu: last?.ideaRu ?? '',
    kind: last?.kind ?? 'image',
    choice: last?.choice ?? 'auto',
    template: last?.template ?? '',
    templates: [],
    moodboards: [],
    loadMeta: async () => {
      try {
        const [templates, moodboards] = await Promise.all([request<{ templates: PrompterTemplate[] }>('/api/prompter/templates'), request<Moodboard[]>('/api/moodboards')]);
        set({ templates: templates.templates, moodboards });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : 'Шаблоны и мудборды не загрузились.' });
      }
    },
    // Шаблон задаёт формат листа, если владелец его ещё не выбрал.
    setTemplate: (id) =>
      set((s) => {
        const template = s.templates.find((t) => t.id === id);
        return { template: id, shot: template !== undefined && s.shot.aspectRatio === '' ? { ...s.shot, aspectRatio: template.aspectRatio } : s.shot };
      }),
    addMoodboard: (id) => {
      const board = get().moodboards.find((m) => m.id === id);
      if (board === undefined) return;
      const room = PROMPTER_MAX_REFS - get().refs.length;
      const images = board.images.slice(0, Math.max(0, room));
      set((s) => ({
        refs: [...s.refs, ...images.map((image) => ({ key: nextKey(), label: image.label, source: image.source, role: 'style' as const, commentRu: `мудборд «${board.name}»` }))],
        error: images.length < board.images.length ? `Влезло ${images.length} из ${board.images.length} картинок мудборда — лимит ${PROMPTER_MAX_REFS}.` : null,
      }));
    },
    saveMoodboard: async (name) => {
      const images = get()
        .refs.filter((r) => r.role === 'style')
        .map((r) => ({ label: r.label, source: r.source }));
      try {
        set({ moodboards: await request<Moodboard[]>('/api/moodboards', { method: 'POST', body: JSON.stringify({ name, images }) }), error: null });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : 'Мудборд не сохранился.' });
      }
    },
    deleteMoodboard: async (id) => {
      try {
        set({ moodboards: await request<Moodboard[]>(`/api/moodboards/${id}`, { method: 'DELETE' }) });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : 'Мудборд не удалился.' });
      }
    },
    shot: last?.shot ?? EMPTY_SHOT,
    refs: last?.refs ?? [],
    history,
    currentId: last?.id ?? null,
    running: false,
    error: null,
    setIdea: (ideaRu) => set({ ideaRu }),
    // Кадры видео в картинке не бывают: при смене вида они становятся простыми референсами.
    setKind: (kind) => set((s) => ({ kind, choice: 'auto', template: kind === 'image' ? s.template : '', shot: { ...s.shot, aspectRatio: '' }, refs: kind === 'image' ? s.refs.map((r) => (r.role === 'start' || r.role === 'end' ? { ...r, role: 'other' as const } : r)) : s.refs })),
    setChoice: (choice) => set({ choice }),
    setShot: (patch) => set((s) => ({ shot: { ...s.shot, ...patch } })),
    addFiles: async (files) => {
      for (const file of files.filter((f) => f.type.startsWith('image/'))) {
        try {
          pushRef(await uploadImage(file), file.name);
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Не удалось загрузить картинку.' });
        }
      }
    },
    addSource: (source, label) => pushRef(source, label),
    patchRef: (key, patch) => set((s) => ({ refs: s.refs.map((r) => (r.key === key ? { ...r, ...patch } : r)) })),
    moveRef: (key, delta) =>
      set((s) => {
        const i = s.refs.findIndex((r) => r.key === key);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= s.refs.length) return {};
        const refs = [...s.refs];
        [refs[i], refs[j]] = [refs[j] as PrompterFormRef, refs[i] as PrompterFormRef];
        return { refs };
      }),
    removeRef: (key) => set((s) => ({ refs: s.refs.filter((r) => r.key !== key) })),
    reset: () => set({ ideaRu: '', choice: 'auto', template: '', shot: EMPTY_SHOT, refs: [], currentId: null, error: null }),
    open: (id) => {
      const entry = get().history.find((e) => e.id === id);
      if (entry !== undefined) set({ currentId: id, ideaRu: entry.ideaRu, kind: entry.kind, choice: entry.choice, template: entry.template, shot: entry.shot, refs: entry.refs, error: null });
    },
    remove: (id) => {
      const list = get().history.filter((e) => e.id !== id);
      writeHistory(list);
      set((s) => ({ history: list, currentId: s.currentId === id ? (list[0]?.id ?? null) : s.currentId }));
    },
    cancel: () => controller?.abort(),
    write: async (commentRu) => {
      const { ideaRu, kind, choice, template, shot, refs, history: list, currentId } = get();
      const previous = commentRu === undefined ? undefined : list.find((e) => e.id === currentId);
      controller = new AbortController();
      set({ running: true, error: null });
      try {
        const images = await Promise.all(refs.map((r) => visionCopy(r.source)));
        const body: PrompterRequest & { images: typeof images } = {
          ideaRu,
          kind,
          modelId: previous?.choice ?? choice,
          template,
          shot,
          refs: refs.map((r) => ({ role: r.role, commentRu: r.commentRu })),
          images,
          ...(previous !== undefined ? { commentRu, previous: { modelId: previous.result.modelId, prompt: previous.result.prompt, params: previous.result.params, styleName: previous.result.styleName } } : {}),
        };
        const res = await fetch('/api/llm/prompter', { method: 'POST', headers: HEADERS, body: JSON.stringify(body), signal: controller.signal });
        const data = (await res.json().catch(() => ({}))) as { result?: PrompterResult; problems?: string[]; meta?: { model: string | null; durationMs: number }; messageRu?: string; error?: string };
        if (!res.ok || data.result === undefined) throw new Error(data.messageRu ?? data.error ?? `HTTP ${res.status}`);
        const entry: PrompterEntry = {
          id: `p${Date.now().toString(36)}`,
          createdAt: new Date().toISOString(),
          ideaRu,
          kind,
          choice: body.modelId,
          template,
          shot,
          refs,
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
