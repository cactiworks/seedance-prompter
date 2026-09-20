import { create } from 'zustand';
import type { Project, Shot } from '../core/model/project.ts';
import type { PackBundle } from '../core/pipeline.ts';

const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { messageRu?: string; error?: string };
    throw new Error(body.messageRu ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface ProjectListItem {
  slug: string;
  title: string;
  shots: number;
  updatedAt: number;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

interface State {
  pack: PackBundle | null;
  projects: ProjectListItem[];
  project: Project | null;
  shotId: string | null;
  save: SaveState;
  error: string | null;
  loadPack: () => Promise<void>;
  loadProjects: () => Promise<void>;
  createProject: (title: string) => Promise<void>;
  openProject: (slug: string) => Promise<void>;
  closeProject: () => void;
  /** Единственный способ менять проект: чистая функция над документом, автосейв сам. */
  update: (recipe: (project: Project) => Project) => void;
  updateShot: (recipe: (shot: Shot) => Shot) => void;
  uploadRef: (file: File, fileName: string) => Promise<void>;
}

let timer: ReturnType<typeof setTimeout> | null = null;

const TRANSLIT: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

export function slugify(text: string): string {
  const base = [...text.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base === '' ? `project-${Date.now().toString(36)}` : base;
}

export const useStore = create<State>((set, get) => {
  const flush = async (): Promise<void> => {
    const { project } = get();
    if (project === null) return;
    set({ save: 'saving' });
    try {
      const res = await fetch(`/api/projects/${project.slug}`, { method: 'PUT', headers: { ...HEADERS, 'if-match': String(project.rev) }, body: JSON.stringify(project) });
      if (res.status === 409) {
        set({ save: 'conflict', error: 'Проект изменён в другом окне. Перезагрузи страницу, чтобы не затереть правки.' });
        return;
      }
      const saved = await json<Project>(res);
      // Пока шёл запрос, пользователь мог печатать дальше: берём с сервера только rev.
      const current = get().project;
      if (current !== null) set({ project: { ...current, rev: saved.rev }, save: get().save === 'dirty' ? 'dirty' : 'saved', error: null });
      if (get().save === 'dirty') schedule();
    } catch (cause) {
      set({ save: 'error', error: String(cause instanceof Error ? cause.message : cause) });
    }
  };
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 800);
  };

  return {
    pack: null,
    projects: [],
    project: null,
    shotId: null,
    save: 'saved',
    error: null,

    loadPack: async () => set({ pack: await json<PackBundle>(await fetch('/api/packs/cinema-doc')) }),
    loadProjects: async () => set({ projects: await json<ProjectListItem[]>(await fetch('/api/projects')) }),

    createProject: async (title) => {
      const taken = new Set(get().projects.map((p) => p.slug));
      let slug = slugify(title);
      for (let n = 2; taken.has(slug); n += 1) slug = `${slugify(title)}-${n}`;
      const project = await json<Project>(await fetch('/api/projects', { method: 'POST', headers: HEADERS, body: JSON.stringify({ slug, title }) }));
      set({ project, shotId: project.shots[0]?.id ?? null, save: 'saved', error: null });
    },

    openProject: async (slug) => {
      const project = await json<Project>(await fetch(`/api/projects/${slug}`));
      set({ project, shotId: project.shots[0]?.id ?? null, save: 'saved', error: null });
    },

    closeProject: () => {
      set({ project: null, shotId: null });
      void get().loadProjects();
    },

    update: (recipe) => {
      const { project, save } = get();
      if (project === null || save === 'conflict') return;
      set({ project: recipe(project), save: 'dirty' });
      schedule();
    },

    updateShot: (recipe) => {
      const { shotId } = get();
      get().update((project) => ({ ...project, shots: project.shots.map((shot) => (shot.id === shotId ? recipe(shot) : shot)) }));
    },

    uploadRef: async (file, fileName) => {
      const { project } = get();
      if (project === null) return;
      const res = await fetch(`/api/projects/${project.slug}/refs/${fileName}`, { method: 'PUT', headers: { 'x-sp-client': '1' }, body: file });
      await json<{ ok: boolean }>(res);
    },
  };
});

export const currentShot = (state: State): Shot | null => state.project?.shots.find((shot) => shot.id === state.shotId) ?? null;
