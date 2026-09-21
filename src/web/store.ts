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
  selectShot: (shotId: string) => void;
  /** Новый кадр наследует комплект, правила и панель текущего: мир ролика общий. */
  addShot: () => void;
  /** Единственный способ менять проект: чистая функция над документом, автосейв сам. */
  update: (recipe: (project: Project) => Project) => void;
  updateShot: (recipe: (shot: Shot) => Shot) => void;
  uploadRef: (file: File, fileName: string) => Promise<void>;
  /** Писатель: запускается только по клику. */
  writing: boolean;
  writeReport: WriteReport | null;
  writeShot: () => Promise<void>;
  cancelWrite: () => void;
  /** Планировщик: синопсис кадра → отрезки. Непустые отрезки заменяются только с согласия владельца. */
  planning: boolean;
  planReport: { ok: boolean; messageRu: string } | null;
  planShot: () => Promise<void>;
}

interface PlanResponse {
  plan: { segments: { titleRu: string; beatsRu: string }[]; placeEn: string; weatherEn: string; notesRu: string };
  newLines: { id: string; ru: string }[];
  problems: string[];
  meta: { durationMs: number; model: string | null };
}

export interface WriteReport {
  ok: boolean;
  messageRu: string;
  notes: Record<string, string>;
  warningsRu: string[];
  remainingRu: string[];
}

interface WriteResponse {
  blocks: { segmentId: string; en: string; notesRu: string }[];
  warningsRu: string[];
  remaining: { violations: { segmentId: string; messageEn: string }[]; lintRu: string[] };
  rounds: number;
  meta: { durationMs: number; model: string | null; inputTokens: number; outputTokens: number };
}

let writeAbort: AbortController | null = null;

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

    selectShot: (shotId) => set({ shotId, writeReport: null }),

    addShot: () => {
      const { project, shotId } = get();
      if (project === null) return;
      const base = project.shots.find((shot) => shot.id === shotId) ?? project.shots.at(-1);
      const id = `shot-${Date.now().toString(36)}`;
      get().update((p) => ({
        ...p,
        shots: [
          ...p.shots,
          {
            id,
            title: `Кадр ${p.shots.length + 1}`,
            kitId: base?.kitId ?? 'arri-alexa35-cooke-s4i',
            defects: null,
            behavior: base?.behavior ?? ['real-human', 'no-staged', 'micro-expressions', 'subtle-movement'],
            operatorRule: base?.operatorRule ?? 'long',
            locationRule: base?.locationRule ?? 'short',
            panel: base?.panel ?? [],
            locationRefs: base?.locationRefs ?? [],
            roleSplit: null,
            synopsisRu: '',
            segments: [{ id: `seg-${Date.now().toString(36)}`, titleRu: '', beatsRu: '', text: { ru: '', en: '', source: 'empty', locked: false } }],
            suppressed: [],
          },
        ],
      }));
      set({ shotId: id, writeReport: null });
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

    writing: false,
    writeReport: null,

    writeShot: async () => {
      const { project, shotId } = get();
      if (project === null || shotId === null || get().writing) return;
      writeAbort = new AbortController();
      set({ writing: true, writeReport: null });
      try {
        const res = await fetch('/api/llm/write', { method: 'POST', headers: HEADERS, body: JSON.stringify({ project, shotId }), signal: writeAbort.signal });
        const result = await json<WriteResponse>(res);
        const byId = new Map(result.blocks.map((b) => [b.segmentId, b]));
        // Текст агента не блокируется: его можно перегенерировать. Любая ручная правка заблокирует отрезок.
        get().updateShot((shot) => ({ ...shot, segments: shot.segments.map((s) => (byId.has(s.id) && !s.text.locked ? { ...s, text: { ...s.text, en: byId.get(s.id)?.en ?? s.text.en, source: 'llm' } } : s)) }));
        set({
          writeReport: {
            ok: true,
            messageRu: `Написано отрезков: ${result.blocks.length} · кругов: ${result.rounds} · ${Math.round(result.meta.durationMs / 1000)} с · ${result.meta.model ?? ''}`,
            notes: Object.fromEntries(result.blocks.map((b) => [b.segmentId, b.notesRu])),
            warningsRu: result.warningsRu,
            remainingRu: [...result.remaining.violations.map((v) => `${v.segmentId}: ${v.messageEn}`), ...result.remaining.lintRu],
          },
        });
      } catch (cause) {
        const aborted = cause instanceof DOMException && cause.name === 'AbortError';
        set({ writeReport: { ok: false, messageRu: aborted ? 'Отменено.' : cause instanceof Error ? cause.message : String(cause), notes: {}, warningsRu: [], remainingRu: [] } });
      } finally {
        writeAbort = null;
        set({ writing: false });
      }
    },

    cancelWrite: () => writeAbort?.abort(),

    planning: false,
    planReport: null,

    planShot: async () => {
      const { project, shotId } = get();
      const shot = project?.shots.find((s) => s.id === shotId);
      if (project === null || shot === undefined || get().planning) return;
      set({ planning: true, planReport: null });
      try {
        const res = await fetch('/api/llm/plan', { method: 'POST', headers: HEADERS, body: JSON.stringify({ project, synopsisRu: shot.synopsisRu }) });
        const { plan, newLines, problems, meta } = await json<PlanResponse>(res);
        const stamp = Date.now().toString(36);
        get().update((p) => ({
          ...p,
          // Реплики из «ёлочек» синопсиса — буква в букву, невычитанные: галочку ставит владелец.
          lines: [...p.lines, ...newLines.map((l) => ({ id: l.id, speakerKey: null, ru: l.ru, proofread: false }))],
          world: {
            ...p.world,
            place: plan.placeEn.trim() !== '' && p.world.place.en.trim() === '' ? { ...p.world.place, en: plan.placeEn.trim(), source: 'llm' } : p.world.place,
            weather: plan.weatherEn.trim() !== '' && p.world.weather.en.trim() === '' ? { ...p.world.weather, en: plan.weatherEn.trim(), source: 'llm' } : p.world.weather,
          },
          shots: p.shots.map((s) => (s.id === shotId ? { ...s, segments: plan.segments.map((seg, i) => ({ id: `seg-${stamp}-${i + 1}`, titleRu: seg.titleRu, beatsRu: seg.beatsRu, text: { ru: '', en: '', source: 'empty' as const, locked: false } })) } : s)),
        }));
        set({ planReport: { ok: problems.length === 0, messageRu: `Отрезков: ${plan.segments.length} · новых реплик: ${newLines.length} · ${Math.round(meta.durationMs / 1000)} с. ${plan.notesRu}${problems.length > 0 ? ` Осталось: ${problems.join(' ')}` : ''}` } });
      } catch (cause) {
        set({ planReport: { ok: false, messageRu: cause instanceof Error ? cause.message : String(cause) } });
      } finally {
        set({ planning: false });
      }
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
