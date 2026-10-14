import { create } from 'zustand';
import { estimate, findModel, modelsOf, paramsFor, validateGen, type GenParams, type MediaKind, type ParamValue, type ProviderId, type RefRole } from '../../core/gen/models.ts';
import type { Folder, GenJob, MediaItem, RefSource, StudioSession } from '../../core/model/media.ts';
import { forgetMedia } from '../../core/model/canvas.ts';
import { useCanvas } from '../canvas/canvasStore.ts';

const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };
const ACTIVE = new Set<GenJob['status']>(['submitting', 'queued', 'running', 'downloading']);

/**
 * Сервер уже вычистил удалённые файлы из сохранённых flows; открытый flow держит клиент — его чистим здесь, иначе
 * автосейв вернул бы ссылки в никуда обратно на диск.
 */
function forgetInOpenFlow(mediaIds: readonly string[]): void {
  const canvas = useCanvas.getState();
  if (canvas.flow === null || mediaIds.length === 0) return;
  const next = forgetMedia(canvas.flow, mediaIds);
  if (next !== canvas.flow) canvas.update(() => next, false);
}

/** Файл выбранного варианта задачи — когда она сохранена в библиотеку; иначе null. */
export function savedMediaOf(jobs: readonly GenJob[], jobId: string): string | null {
  const job = jobs.find((j) => j.id === jobId);
  return job?.status === 'saved' ? (job.mediaIds.find((id): id is string => id !== null) ?? null) : null;
}
const CONSENT_KEY = 'sp-refs-consent';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { messageRu?: string; error?: string };
    throw new Error(body.messageRu ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Картинка в composer: откуда она, роль и превью. */
export interface ComposerRef {
  key: string;
  label: string;
  source: RefSource;
  role: RefRole;
  thumb: string;
}

export interface Composer {
  modelId: string;
  params: GenParams;
  prompt: string;
  refs: ComposerRef[];
  count: number;
  error: string | null;
  sending: boolean;
}

/** Готовый мудборд провайдера (Soul 2 — стиль Higgsfield). */
export interface StyleOption {
  id: string;
  name: string;
  description: string;
  previewUrl: string | null;
}

export interface ProviderStatus {
  hasKey: boolean;
  /** Что не так с ключом (без значения): нет записи или в ней не ключ. */
  keyProblem?: string;
  balance?: number;
  balanceError?: string;
}

export const thumbOf = (source: RefSource): string => {
  switch (source.type) {
    case 'upload':
      return `/api/uploads/${source.uploadId}`;
    case 'media':
      return `/api/library/${source.mediaId}/file`;
    case 'projectRef':
      return `/api/projects/${source.slug}/refs/${source.file}`;
  }
};

export const mediaUrl = (id: string): string => `/api/library/${id}/file`;

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Первый / последний кадр видео библиотеки → новая картинка библиотеки (локально, ffmpeg). */
export async function extractFrame(videoMediaId: string, which: 'first' | 'last'): Promise<MediaItem> {
  return json<MediaItem>(await fetch(`/api/library/${videoMediaId}/frame`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ which }) }));
}

/** Свой файл (съёмка, картинка) → библиотека: дальше его можно резать, брать кадр, отдавать в canvas. */
export async function importMedia(file: File): Promise<MediaItem> {
  return json<MediaItem>(await fetch(`/api/library/import?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'x-sp-client': '1', 'content-type': file.type }, body: file }));
}

/** Картинка или видео под размер площадки (ffmpeg, локально) → новый файл библиотеки. */
export async function resizeMedia(source: RefSource, width: number, height: number, fit: 'cover' | 'contain'): Promise<MediaItem> {
  return json<MediaItem>(await fetch('/api/media/resize', { method: 'POST', headers: HEADERS, body: JSON.stringify({ source, width, height, fit }) }));
}

/** Что сервер намерил во входе апскейла: параметры цены (длинная сторона, секунды) и размер / длительность для подписи. */
export interface MeasuredInput {
  params: GenParams;
  info: { width: number | null; height: number | null; durationSec: number | null; bytes: number } | null;
}

/** Замер входа апскейла тем же кодом, что при запуске, — цена на кнопке совпадёт с гейтом. Локально, бесплатно. */
export async function measureInput(modelId: string, source: RefSource): Promise<MeasuredInput> {
  return json<MeasuredInput>(await fetch('/api/gen/measure', { method: 'POST', headers: HEADERS, body: JSON.stringify({ modelId, refs: [{ source }] }) }));
}

/** Отрезок видео библиотеки → новое видео (ffmpeg, локально, бесплатно). `end` 0 — до конца. */
export async function trimVideo(videoMediaId: string, start: number, end: number): Promise<MediaItem> {
  return json<MediaItem>(await fetch(`/api/library/${videoMediaId}/trim`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ start, end }) }));
}

/** Картинка с диска → data/uploads; возвращает источник для задачи. */
export async function uploadImage(file: File): Promise<RefSource> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error(`«${file.name}»: подходят только JPG, PNG и WebP.`);
  const upload = await json<{ id: string }>(await fetch('/api/uploads', { method: 'POST', headers: { 'x-sp-client': '1', 'content-type': file.type }, body: file }));
  return { type: 'upload', uploadId: upload.id };
}
export const isActive = (job: GenJob): boolean => ACTIVE.has(job.status);

/** Согласие отправлять картинки провайдеру — на сессию браузера, как у vision-анализа. */
export function hasRefsConsent(): boolean {
  try {
    return sessionStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}
function rememberConsent(): void {
  try {
    sessionStorage.setItem(CONSENT_KEY, '1');
  } catch {
    /* приватный режим — спросим снова */
  }
}

const emptyComposer = (kind: MediaKind): Composer => {
  const model = modelsOf(kind)[0];
  return { modelId: model?.id ?? '', params: model === undefined ? {} : paramsFor(model, {}), prompt: '', refs: [], count: 1, error: null, sending: false };
};

let refSeq = 0;
const nextKey = (): string => `r${Date.now().toString(36)}${(refSeq += 1)}`;

interface GenState {
  status: Record<string, ProviderStatus>;
  sessions: Record<MediaKind, StudioSession[]>;
  activeSession: Record<MediaKind, string | null>;
  jobs: GenJob[];
  library: MediaItem[];
  favorites: string[];
  folders: Folder[];
  /** Мудборды по провайдеру; undefined — ещё не загружены. */
  styles: Partial<Record<ProviderId, StyleOption[]>>;
  loadStyles: (provider: ProviderId) => Promise<void>;
  composer: Record<MediaKind, Composer>;

  loadStatus: (withBalance?: boolean) => Promise<void>;
  loadSessions: (kind: MediaKind) => Promise<void>;
  newSession: (kind: MediaKind) => Promise<void>;
  selectSession: (kind: MediaKind, id: string) => void;
  renameSession: (id: string, title: string) => Promise<void>;
  pinSession: (id: string, pinned: boolean) => Promise<void>;
  deleteSession: (kind: MediaKind, id: string) => Promise<void>;

  loadJobs: () => Promise<void>;
  loadLibrary: () => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  createFolder: (name: string) => Promise<Folder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  /** Положить / убрать файлы из папки. */
  fileTo: (folderId: string, mediaIds: string[], on: boolean) => Promise<void>;
  reveal: (mediaId: string) => Promise<void>;
  /** Удалить файлы навсегда (с диска); задачи без файлов уходят из ленты. */
  deleteMedia: (mediaIds: string[]) => Promise<void>;
  /** Убрать задачу из ленты вместе с её файлами (неудачную — просто убрать). */
  deleteJob: (jobId: string) => Promise<void>;
  /** Копии в data/exports/<дата> с понятными именами + Finder; возвращает папку. */
  exportMedia: (mediaIds: string[]) => Promise<{ dir: string; files: string[] }>;
  retry: (jobId: string) => Promise<void>;

  setModel: (kind: MediaKind, modelId: string) => void;
  setParam: (kind: MediaKind, key: string, value: ParamValue) => void;
  setPrompt: (kind: MediaKind, prompt: string) => void;
  setCount: (kind: MediaKind, count: number) => void;
  addFiles: (kind: MediaKind, files: File[]) => Promise<void>;
  addRef: (kind: MediaKind, ref: Omit<ComposerRef, 'key' | 'thumb' | 'role'> & { role?: RefRole }) => void;
  removeRef: (kind: MediaKind, key: string) => void;
  setRole: (kind: MediaKind, key: string, role: RefRole) => void;
  moveRef: (kind: MediaKind, key: string, delta: -1 | 1) => void;
  /** Remix: промпт, модель, параметры и картинки задачи — обратно в форму. */
  remix: (job: GenJob) => void;
  /**
   * Промпт из «Промптера» — в форму. `params` — только то, что выбрал агент: seed и Soul ID владельца в форме
   * не трогаются. Картинки заменяются целиком: номера image N / @ImageN в промпте — это их порядок.
   */
  applyPrompt: (kind: MediaKind, modelId: string, params: GenParams, prompt: string, refs: { label: string; source: RefSource; role: RefRole }[]) => void;
  /**
   * Запуск по клику. `consent` — владелец подтвердил отправку картинок в этом окне. Возвращает
   * 'needs-consent', если картинки есть, а согласия ещё не было.
   */
  submit: (kind: MediaKind, consent?: boolean) => Promise<'ok' | 'needs-consent' | 'error'>;
  /** «Ещё раз» — тот же запрос одной генерацией; цена видна на кнопке. */
  regenerate: (job: GenJob) => Promise<void>;
  /** Запуск из canvas: готовое тело запроса (промпт, параметры, картинки и подтверждённая цена). */
  run: (body: Record<string, unknown>) => Promise<GenJob[]>;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export const useGen = create<GenState>((set, get) => {
  const patchComposer = (kind: MediaKind, patch: Partial<Composer> | ((c: Composer) => Partial<Composer>)): void =>
    set((s) => ({ composer: { ...s.composer, [kind]: { ...s.composer[kind], ...(typeof patch === 'function' ? patch(s.composer[kind]) : patch) } } }));

  /** Опрос ленты, пока есть незаконченные задачи: сервер сам доводит их до файла, мы только показываем. */
  const schedulePoll = (): void => {
    if (pollTimer !== null) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void get()
        .loadJobs()
        .then(() => {
          if (get().jobs.some(isActive)) schedulePoll();
        });
    }, 2000);
  };

  const post = async <T>(url: string, body: unknown): Promise<T> => json<T>(await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) }));

  return {
    status: {},
    sessions: { image: [], video: [] },
    activeSession: { image: null, video: null },
    jobs: [],
    library: [],
    favorites: [],
    folders: [],
    styles: {},
    loadStyles: async (provider) => {
      try {
        const list = await json<StyleOption[]>(await fetch(`/api/gen/styles?provider=${provider}`));
        set((s) => ({ styles: { ...s.styles, [provider]: list } }));
      } catch {
        set((s) => ({ styles: { ...s.styles, [provider]: [] } }));
      }
    },
    composer: { image: emptyComposer('image'), video: emptyComposer('video') },

    loadStatus: async (withBalance = false) => {
      try {
        set({ status: await json<Record<string, ProviderStatus>>(await fetch(`/api/gen/status${withBalance ? '?balance=1' : ''}`)) });
      } catch {
        /* статус — подсказка, не блокер */
      }
    },

    loadSessions: async (kind) => {
      const list = await json<StudioSession[]>(await fetch(`/api/studio/sessions?kind=${kind}`));
      set((s) => ({ sessions: { ...s.sessions, [kind]: list }, activeSession: { ...s.activeSession, [kind]: s.activeSession[kind] !== null && list.some((x) => x.id === s.activeSession[kind]) ? s.activeSession[kind] : (list[0]?.id ?? null) } }));
    },
    newSession: async (kind) => {
      const session = await post<StudioSession>('/api/studio/sessions', { kind });
      set((s) => ({ sessions: { ...s.sessions, [kind]: [session, ...s.sessions[kind]] }, activeSession: { ...s.activeSession, [kind]: session.id } }));
    },
    selectSession: (kind, id) => set((s) => ({ activeSession: { ...s.activeSession, [kind]: id } })),
    renameSession: async (id, title) => {
      await json(await fetch(`/api/studio/sessions/${id}`, { method: 'PATCH', headers: HEADERS, body: JSON.stringify({ title }) }));
      await Promise.all([get().loadSessions('image'), get().loadSessions('video')]);
    },
    pinSession: async (id, pinned) => {
      await json(await fetch(`/api/studio/sessions/${id}`, { method: 'PATCH', headers: HEADERS, body: JSON.stringify({ pinned }) }));
      await Promise.all([get().loadSessions('image'), get().loadSessions('video')]);
    },
    deleteSession: async (kind, id) => {
      await json(await fetch(`/api/studio/sessions/${id}`, { method: 'DELETE', headers: HEADERS }));
      set((s) => ({ activeSession: { ...s.activeSession, [kind]: s.activeSession[kind] === id ? null : s.activeSession[kind] } }));
      await get().loadSessions(kind);
    },

    loadJobs: async () => {
      const before = new Set(get().jobs.filter((j) => j.status === 'saved').map((j) => j.id));
      const jobs = await json<GenJob[]>(await fetch('/api/gen/jobs'));
      set((state) => ({ jobs: [...new Map([...state.jobs, ...jobs].map((job) => [job.id, job])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }));
      if (jobs.some((j) => j.status === 'saved' && !before.has(j.id))) void get().loadLibrary();
      if (jobs.some(isActive)) schedulePoll();
    },
    loadLibrary: async () => {
      const body = await json<{ items: MediaItem[]; favorites: string[]; folders: Folder[] }>(await fetch('/api/library'));
      set({ library: body.items, favorites: body.favorites, folders: body.folders });
    },
    createFolder: async (name) => {
      const folder = await post<Folder>('/api/library/folders', { name });
      set((s) => ({ folders: [...s.folders, folder] }));
      return folder;
    },
    renameFolder: async (id, name) => {
      const body = await json<{ folders: Folder[] }>(await fetch(`/api/library/folders/${id}`, { method: 'PATCH', headers: HEADERS, body: JSON.stringify({ name }) }));
      set({ folders: body.folders });
    },
    deleteFolder: async (id) => {
      const body = await json<{ folders: Folder[] }>(await fetch(`/api/library/folders/${id}`, { method: 'DELETE', headers: HEADERS }));
      set({ folders: body.folders });
    },
    fileTo: async (folderId, mediaIds, on) => {
      const body = await post<{ folders: Folder[] }>(`/api/library/folders/${folderId}/items`, { mediaIds, on });
      set({ folders: body.folders });
    },
    toggleFavorite: async (id) => {
      const on = !get().favorites.includes(id);
      set((s) => ({ favorites: on ? [...s.favorites, id] : s.favorites.filter((f) => f !== id) }));
      await post(`/api/library/${id}/favorite`, { on });
    },
    reveal: async (mediaId) => {
      await post(`/api/library/${mediaId}/reveal`, {});
    },
    deleteMedia: async (mediaIds) => {
      for (const id of mediaIds) await json(await fetch(`/api/library/${id}`, { method: 'DELETE', headers: HEADERS }));
      forgetInOpenFlow(mediaIds);
      await Promise.all([get().loadLibrary(), get().loadJobs()]);
    },
    deleteJob: async (jobId) => {
      const removed = (get().jobs.find((j) => j.id === jobId)?.mediaIds ?? []).filter((m): m is string => m !== null);
      await json(await fetch(`/api/gen/jobs/${jobId}`, { method: 'DELETE', headers: HEADERS }));
      forgetInOpenFlow(removed);
      await Promise.all([get().loadLibrary(), get().loadJobs()]);
    },
    exportMedia: (mediaIds) => post<{ dir: string; files: string[] }>('/api/library/export', { mediaIds }),
    retry: async (jobId) => {
      await post(`/api/gen/jobs/${jobId}/retry`, {});
      await get().loadJobs();
    },

    setModel: (kind, modelId) => {
      const model = findModel(modelId);
      if (model === undefined) return;
      // Общие параметры (формат, разрешение, длительность) переживают смену модели, если новой подходят.
      patchComposer(kind, (c) => ({ modelId, params: paramsFor(model, c.params), error: null }));
    },
    setParam: (kind, key, value) => patchComposer(kind, (c) => ({ params: { ...c.params, [key]: value }, error: null })),
    setPrompt: (kind, prompt) => patchComposer(kind, { prompt, error: null }),
    setCount: (kind, count) => patchComposer(kind, { count: Math.min(4, Math.max(1, count)) }),

    addFiles: async (kind, files) => {
      for (const file of files) {
        try {
          get().addRef(kind, { label: file.name, source: await uploadImage(file) });
        } catch (error) {
          patchComposer(kind, { error: error instanceof Error ? error.message : 'Не удалось загрузить картинку.' });
        }
      }
    },
    addRef: (kind, ref) => patchComposer(kind, (c) => ({ refs: [...c.refs, { ...ref, key: nextKey(), role: ref.role ?? 'ref', thumb: thumbOf(ref.source) }], error: null })),
    removeRef: (kind, key) => patchComposer(kind, (c) => ({ refs: c.refs.filter((r) => r.key !== key) })),
    setRole: (kind, key, role) => patchComposer(kind, (c) => ({ refs: c.refs.map((r) => (r.key === key ? { ...r, role } : r)), error: null })),
    moveRef: (kind, key, delta) =>
      patchComposer(kind, (c) => {
        const i = c.refs.findIndex((r) => r.key === key);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= c.refs.length) return {};
        const refs = [...c.refs];
        [refs[i], refs[j]] = [refs[j] as ComposerRef, refs[i] as ComposerRef];
        return { refs };
      }),

    remix: (job) => {
      const model = findModel(job.modelId);
      if (model === undefined) return;
      patchComposer(job.kind, {
        modelId: model.id,
        params: paramsFor(model, job.params),
        prompt: job.prompt,
        refs: job.refs.map((r) => ({ key: nextKey(), label: r.label, source: r.source, role: r.role, thumb: thumbOf(r.source) })),
        error: null,
      });
    },

    applyPrompt: (kind, modelId, params, prompt, refs) => {
      const model = findModel(modelId);
      if (model === undefined) return;
      patchComposer(kind, (c) => ({ modelId: model.id, params: paramsFor(model, { ...c.params, ...params }), prompt, refs: refs.map((r) => ({ ...r, key: nextKey(), thumb: thumbOf(r.source) })), error: null }));
    },

    submit: async (kind, consent = false) => {
      const c = get().composer[kind];
      const model = findModel(c.modelId);
      if (model === undefined) return 'error';
      const params = paramsFor(model, c.params);
      const problems = validateGen(model, c.prompt, params, c.refs.map((r) => r.role));
      if (problems.length > 0) {
        patchComposer(kind, { error: problems.join(' ') });
        return 'error';
      }
      if (c.refs.length > 0 && !consent && !hasRefsConsent()) return 'needs-consent';
      if (consent) rememberConsent();

      patchComposer(kind, { sending: true, error: null });
      try {
        let sessionId = get().activeSession[kind];
        if (sessionId === null) {
          await get().newSession(kind);
          sessionId = get().activeSession[kind];
        }
        const result = await post<{ jobs: GenJob[] }>('/api/gen/jobs', {
          modelId: model.id,
          prompt: c.prompt,
          params,
          refs: c.refs.map((r) => ({ label: r.label, source: r.source, role: r.role })),
          count: c.count,
          confirmCredits: estimate(model, params, c.count, c.refs.length).credits,
          refsConsent: c.refs.length > 0 ? true : undefined,
          sessionId: sessionId ?? undefined,
        });
        set((s) => ({ jobs: [...result.jobs, ...s.jobs.filter((j) => !result.jobs.some((n) => n.id === j.id))] }));
        const failed = result.jobs.find((j) => j.status === 'failed');
        // Как в connxn: в картинках форма остаётся для быстрых правок, в видео — очищается.
        patchComposer(kind, kind === 'video' && failed === undefined ? { prompt: '', refs: [], sending: false } : { sending: false, error: failed?.error?.messageRu ?? null });
        schedulePoll();
        void get().loadSessions(kind);
        return failed === undefined ? 'ok' : 'error';
      } catch (error) {
        patchComposer(kind, { sending: false, error: error instanceof Error ? error.message : 'Генерация не запустилась.' });
        return 'error';
      }
    },

    regenerate: async (job) => {
      const model = findModel(job.modelId);
      if (model === undefined) return;
      // «Ещё раз» — новый вариант: seed случайный (тот же seed дал бы почти тот же кадр за деньги).
      // Повторить кадр — «Использовать настройки»: remix переносит seed как есть.
      const seedKey = model.params.find((d) => d.type === 'seed')?.key;
      const params = paramsFor(model, seedKey === undefined ? job.params : { ...job.params, [seedKey]: 0 });
      const result = await post<{ jobs: GenJob[] }>('/api/gen/jobs', {
        modelId: model.id,
        prompt: job.prompt,
        params,
        refs: job.refs.map((r) => ({ label: r.label, source: r.source, role: r.role })),
        count: 1,
        confirmCredits: estimate(model, params, 1, job.refs.length).credits,
        // Картинки этой задачи уже уходили провайдеру с согласия владельца.
        refsConsent: job.refs.length > 0 ? true : undefined,
        sessionId: job.sessionId ?? undefined,
        origin: job.origin ?? undefined,
      });
      set((s) => ({ jobs: [...result.jobs, ...s.jobs] }));
      schedulePoll();
    },

    run: async (body) => {
      if (body.refsConsent === true) rememberConsent();
      const result = await post<{ jobs: GenJob[] }>('/api/gen/jobs', body);
      set((s) => ({ jobs: [...result.jobs, ...s.jobs.filter((j) => !result.jobs.some((n) => n.id === j.id))] }));
      schedulePoll();
      return result.jobs;
    },
  };
});
