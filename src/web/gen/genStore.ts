import { confirmGenerationQuote } from './GenerationQuote.tsx';
import { remoteStudio, downloadFile } from '../download.ts';
import { studioFetch as fetch } from '../remoteFetch.ts';
import { create } from 'zustand';
import { estimate, findModel, modelsOf, paramsFor, validateGen, type GenParams, type MediaKind, type ParamValue, type ProviderId, type RefRole } from '../../core/gen/models.ts';
import type { Folder, GenJob, MediaItem, RefSource, StudioSession } from '../../core/model/media.ts';
import { forgetMedia } from '../../core/model/canvas.ts';
import { isActive, mergeJobs, submissionIssue } from '../../core/gen/jobStatus.ts';
import { useCanvas } from '../canvas/canvasStore.ts';

const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };
export { isActive } from '../../core/gen/jobStatus.ts';

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
const SOUL_ID_KEY = 'sp-studio-soul-id';

function rememberedSoulId(): string {
  try { return localStorage.getItem(SOUL_ID_KEY) ?? ''; }
  catch { return ''; }
}

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
  return { modelId: model?.id ?? '', params: model === undefined ? {} : paramsFor(model, { soulId: rememberedSoulId() }), prompt: '', refs: [], count: 1, error: null, sending: false };
};

let refSeq = 0;
const nextKey = (): string => `r${Date.now().toString(36)}${(refSeq += 1)}`;

interface GenState {
  jobsLoading: boolean;
  jobsError: string | null;
  libraryError: string | null;
  jobsCheckedAt: string | null;
  submitting: number;
  submissionError: string | null;
  tasksVisit: number;
  openTasks: () => void;
  watchJobs: () => () => void;
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
  exportMedia: (mediaIds: string[]) => Promise<{ dir: string; files: string[]; downloadUrl?: string }>;
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
  run: (body: Record<string, unknown>, beforeSubmit?: () => void) => Promise<GenJob[]>;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let watchers = 0;
let jobsRequest: Promise<void> | null = null;
let libraryRequest: Promise<void> | null = null;
let jobsRevision = 0;

export const useGen = create<GenState>((set, get) => {
  const patchComposer = (kind: MediaKind, patch: Partial<Composer> | ((c: Composer) => Partial<Composer>)): void => {
    const previous = get().composer[kind];
    const next = { ...previous, ...(typeof patch === 'function' ? patch(previous) : patch) };
    if (typeof next.params.soulId === 'string' && (next.params.soulId !== previous.params.soulId || next.modelId !== previous.modelId)) {
      try { localStorage.setItem(SOUL_ID_KEY, next.params.soulId); }
      catch { /* In private mode the current form still keeps the selection. */ }
    }
    set((s) => ({ composer: { ...s.composer, [kind]: next } }));
  };

  /** Опрос ленты, пока есть незаконченные задачи: сервер сам доводит их до файла, мы только показываем. */
  const schedulePoll = (): void => {
    if (pollTimer !== null) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void get().loadJobs();
    }, get().jobs.some(isActive) || get().jobsError !== null || get().libraryError !== null || get().submitting > 0 ? 2000 : 10000);
  };

  const post = async <T>(url: string, body: unknown): Promise<T> => json<T>(await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) }));

  return {
    jobsLoading: false, jobsError: null, libraryError: null, jobsCheckedAt: null,
    submitting: 0, submissionError: null,
    tasksVisit: 0,
    openTasks: () => { set((s) => ({ tasksVisit: s.tasksVisit + 1 })); window.location.hash = '/library'; },
    watchJobs: () => {
      watchers += 1;
      void get().loadJobs();
      return () => {
        watchers = Math.max(0, watchers - 1);
        if (watchers === 0 && pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
      };
    },
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
      if (jobsRequest !== null) return jobsRequest;
      const revision = jobsRevision;
      const before = new Map(get().jobs.map((job) => [job.id, job.updatedAt]));
      set({ jobsLoading: true });
      jobsRequest = (async () => {
        try {
          const jobs = await json<GenJob[]>(await fetch('/api/gen/jobs', { signal: AbortSignal.timeout(10000) }));
          if (revision === jobsRevision) set((state) => {
            const ids = new Set(jobs.map((job) => job.id));
            // The endpoint includes every unfinished job; missing unchanged entries were removed elsewhere.
            const retained = state.jobs.filter((job) => job.status === 'saved' || ids.has(job.id) || before.get(job.id) !== job.updatedAt);
            return { jobs: mergeJobs(retained, jobs), jobsError: null, jobsCheckedAt: new Date().toISOString() };
          });
          await get().loadLibrary();
        } catch {
          set({ jobsError: 'Не удалось обновить задачи. Показаны последние полученные статусы; проверка повторится автоматически.' });
        } finally {
          jobsRequest = null;
          set({ jobsLoading: false });
          if (watchers > 0 || get().jobs.some(isActive) || get().submitting > 0 || get().jobsError !== null || get().libraryError !== null) schedulePoll();
        }
      })();
      return jobsRequest;
    },
    loadLibrary: async () => {
      if (libraryRequest !== null) return libraryRequest;
      libraryRequest = (async () => {
        try {
          const body = await json<{ items: MediaItem[]; favorites: string[]; folders: Folder[] }>(await fetch('/api/library', { signal: AbortSignal.timeout(10000) }));
          set({ library: body.items, favorites: body.favorites, folders: body.folders, libraryError: null });
        } catch { set({ libraryError: 'Не удалось обновить список файлов. Уже созданные результаты могут пока не отображаться.' }); }
        finally { libraryRequest = null; }
      })();
      return libraryRequest;
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
      if (remoteStudio) { downloadFile(mediaUrl(mediaId)); return; }
      await post(`/api/library/${mediaId}/reveal`, {});
    },
    deleteMedia: async (mediaIds) => {
      for (const id of mediaIds) await json(await fetch(`/api/library/${id}`, { method: 'DELETE', headers: HEADERS }));
      jobsRevision += 1;
      set((s) => ({ library: s.library.filter((m) => !mediaIds.includes(m.id)), jobs: s.jobs.filter((j) => j.status !== 'saved' || j.mediaIds.some((id) => id !== null && !mediaIds.includes(id))) }));
      forgetInOpenFlow(mediaIds);
      await Promise.all([get().loadLibrary(), get().loadJobs()]);
    },
    deleteJob: async (jobId) => {
      const removed = (get().jobs.find((j) => j.id === jobId)?.mediaIds ?? []).filter((m): m is string => m !== null);
      await json(await fetch(`/api/gen/jobs/${jobId}`, { method: 'DELETE', headers: HEADERS }));
      jobsRevision += 1;
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== jobId) }));
      forgetInOpenFlow(removed);
      await Promise.all([get().loadLibrary(), get().loadJobs()]);
    },
    exportMedia: async (mediaIds) => {
      const result = await post<{ dir: string; files: string[]; downloadUrl?: string }>('/api/library/export', { mediaIds });
      if (result.downloadUrl) downloadFile(result.downloadUrl);
      return result;
    },
    retry: async (jobId) => {
      await post(`/api/gen/jobs/${jobId}/retry`, {});
      await get().loadJobs();
    },

    setModel: (kind, modelId) => {
      const model = findModel(modelId);
      if (model === undefined) return;
      // Общие параметры (формат, разрешение, длительность) переживают смену модели, если новой подходят.
      patchComposer(kind, (c) => ({ modelId, params: paramsFor(model, { soulId: rememberedSoulId(), ...c.params }), error: null }));
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
      patchComposer(kind, (c) => ({ modelId: model.id, params: paramsFor(model, { soulId: rememberedSoulId(), ...c.params, ...params }), prompt, refs: refs.map((r) => ({ ...r, key: nextKey(), thumb: thumbOf(r.source) })), error: null }));
    },

    submit: async (kind, consent = false) => {
      const c = get().composer[kind];
      if (c.sending) return 'error';
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
        const created = await get().run({
          modelId: model.id,
          prompt: c.prompt,
          params,
          refs: c.refs.map((r) => ({ label: r.label, source: r.source, role: r.role })),
          count: c.count,
          confirmCredits: estimate(model, params, c.count, c.refs.length).credits,
          refsConsent: c.refs.length > 0 ? true : undefined,
          sessionId: sessionId ?? undefined,
        });
        const issue = submissionIssue(created);
        // Как в connxn: в картинках форма остаётся для быстрых правок, в видео — очищается.
        patchComposer(kind, kind === 'video' && issue === null ? { prompt: '', refs: [], sending: false } : { sending: false, error: issue });
        schedulePoll();
        void get().loadSessions(kind);
        return issue === null ? 'ok' : 'error';
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
      await get().run({
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
      }).catch(() => { /* run exposes the error in the shared task status. */ });
    },

    run: async (body, beforeSubmit) => {
      const model = findModel(String(body.modelId));
      if (model?.quoteRequired) body = await confirmGenerationQuote({ ...body, modelId: model.id });
      beforeSubmit?.();
      if (body.refsConsent === true) rememberConsent();
      set((s) => ({ submitting: s.submitting + 1, submissionError: null }));
      // Start observing before submit returns: the server may already have a submitting job.
      void get().loadJobs();
      try {
        const result = await post<{ jobs: GenJob[] }>('/api/gen/jobs', body);
        set((s) => ({ jobs: mergeJobs(s.jobs, result.jobs), submissionError: submissionIssue(result.jobs) }));
        return result.jobs;
      } catch (error) {
        const message = error instanceof TypeError ? 'Ответ на отправку не получен. Проверь задачи в «Материалах» перед повтором: генерация могла начаться.' : error instanceof Error ? error.message : 'Не удалось получить ответ на отправку. Проверь задачи в «Материалах».';
        set({ submissionError: message });
        throw new Error(message);
      } finally {
        set((s) => ({ submitting: Math.max(0, s.submitting - 1) }));
        if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
        schedulePoll();
      }
    },
  };
});
