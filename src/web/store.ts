import { invalidateSeriesCritique } from '../core/production/seriesForm.ts';
import { downloadFile } from './download.ts';
import { studioFetch as fetch } from './remoteFetch.ts';
import { create } from 'zustand';
import { applyFields, applyWrite, staleFields, staleSegments, type FieldItem, type FieldsOutput } from '../core/compose.ts';
import { storyboardFrames, type Attempt, type Critique, type Project, type Shot } from '../core/model/project.ts';
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

/**
 * Где открыт ролик. null — своя страница «Кадров». canvas — черновик ноды Seedance-промптера: редактор кадра
 * открыт поверх холста, «Назад» возвращает на холст, вкладок кадров нет — нода держит один кадр.
 */
export interface ProjectHost {
  kind: 'canvas';
  flowId: string;
  nodeId: string;
}

interface State {
  pack: PackBundle | null;
  projects: ProjectListItem[];
  project: Project | null;
  shotId: string | null;
  host: ProjectHost | null;
  save: SaveState;
  error: string | null;
  loadPack: () => Promise<void>;
  loadProjects: () => Promise<void>;
  createProject: (title: string) => Promise<void>;
  openProject: (slug: string) => Promise<void>;
  /** Черновик ноды canvas: проект уже на диске, кадр выбран нодой. `prepare` — правка сразу после открытия (панель из проводков). */
  openInHost: (project: Project, shotId: string, host: ProjectHost, prepare?: (project: Project) => Project) => void;
  /** Закрыть ролик: сначала дописать незаписанное (автосейв ждёт 800 мс), потом выйти. */
  closeProject: () => Promise<void>;
  flushProject: () => Promise<boolean>;
  retryProjectSave: () => Promise<boolean>;
  selectShot: (shotId: string) => void;
  /** Новый кадр наследует комплект, правила и панель текущего: мир ролика общий. */
  addShot: () => void;
  /** Единственный способ менять проект: чистая функция над документом, автосейв сам. */
  update: (recipe: (project: Project) => Project) => void;
  updateShot: (recipe: (shot: Shot) => Shot) => void;
  uploadRef: (file: File, fileName: string) => Promise<void>;
  /**
   * «Собрать промпт», только по клику: агент полей переводит изменённые тезисы (место, погода, имена,
   * последствия, своя камера, реквизит), потом писатель пишет изменённые отрезки. `all` — переписать все.
   */
  composing: 'fields' | 'writing' | null;
  writeReport: WriteReport | null;
  composeShot: (all?: boolean) => Promise<void>;
  cancelCompose: () => void;
  /** Планировщик: синопсис кадра → отрезки. Непустые отрезки заменяются только с согласия владельца. */
  planning: boolean;
  planReport: { ok: boolean; messageRu: string } | null;
  planShot: () => Promise<void>;
  /** Петля попыток. */
  symptoms: SymptomCatalog | null;
  loadSymptoms: () => Promise<void>;
  saveAttempt: (prompt: string) => void;
  updateAttempt: (n: number, patch: Partial<Attempt>) => void;
  fixing: boolean;
  /** Предложения агента-фиксера: не применяются, пока владелец не примет каждое. */
  proposals: { attemptN: number; items: { segmentId: string; en: string; notesRu: string }[]; messageRu: string } | null;
  proposeFix: (attemptN: number) => Promise<void>;
  acceptProposal: (segmentId: string) => void;
  dismissProposal: (segmentId: string) => void;
  /** Vision-анализ референса — только по кнопке: картинка уходит в OpenAI через Codex. */
  analyzing: string | null;
  visionReports: Record<string, VisionReport>;
  analyzeRef: (refKey: string) => Promise<void>;
  applyVisionFlags: (refKey: string) => void;
  /** Итоговая проверка критиком — по клику; результат хранится в кадре вместе с текстом, для которого сделан. */
  critiquing: boolean;
  critiqueError: string | null;
  critiqueShot: () => Promise<void>;
  cancelCritique: () => void;
  /** Панель пронумерованными файлами + Finder. */
  exporting: boolean;
  exportResult: ExportResult | null;
  exportPanel: () => Promise<void>;
}

export interface ExportResult {
  downloadUrl?: string;
  dir: string;
  files: { n: number; key: string; file: string | null }[];
  errorRu?: string;
}

export interface VisionReport {
  ok: boolean;
  summaryRu: string;
  risksRu: string[];
  clothingEn: string;
  flags: { hasPeople: boolean; hasText: boolean; studioBackdrop: boolean } | null;
}

/** Уменьшенная копия ≤1568 px для vision: без нативных зависимостей на сервере, меньше токенов. */
export async function downscale(file: File, maxSide = 1568): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(new Error('Не удалось уменьшить картинку.')) : resolve(blob)), 'image/jpeg', 0.86));
}

export interface SymptomCatalog {
  groups: Record<string, string>;
  symptoms: { id: string; group: string; titleRu: string; causeRu: string; checkRu: string; fixEn: string; guide: string }[];
}

interface FieldsResponse {
  items: FieldItem[];
  output: FieldsOutput | null;
  problems: string[];
  meta: { durationMs: number; model: string | null } | null;
}

interface PlanResponse {
  plan: { segments: { titleRu: string; beatsRu: string }[]; notesRu: string };
  newLines: { id: string; ru: string }[];
  problems: string[];
  meta: { durationMs: number; model: string | null };
}

export interface WriteReport {
  ok: boolean;
  messageRu: string;
  notes: Record<string, string>;
  /** Заметки агента полей: чего не хватило в тезисах, что он решил сам. */
  fieldsNoteRu: string;
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
let critiqueAbort: AbortController | null = null;

let timer: ReturnType<typeof setTimeout> | null = null;

const TRANSLIT: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

export function slugify(text: string): string {
  const base = [...text.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base === '' ? `project-${Date.now().toString(36)}` : base;
}

export const useStore = create<State>((set, get) => {
  let writing: Promise<void> | null = null;
  const flush = async (): Promise<void> => {
    if (writing) return writing;
    writing = performFlush();
    try { await writing; } finally { writing = null; }
  };
  const performFlush = async (): Promise<void> => {
    const { project } = get();
    if (project === null) return;
    set({ save: 'saving' });
    try {
      const res = await fetch(`/api/projects/${project.slug}`, { method: 'PUT', headers: { ...HEADERS, 'if-match': String(project.rev) }, body: JSON.stringify(project) });
      if (res.status === 409) {
        set({ save: 'conflict', error: 'Проект изменён в другом окне. Скачай свой черновик перед перезагрузкой; текущие правки остаются в редакторе.' });
        return;
      }
      const saved = await json<Project>(res);
      // Пока шёл запрос, пользователь мог печатать дальше: берём с сервера только rev.
      const current = get().project;
      if (current !== null && current.slug === project.slug) set({ project: { ...current, rev: saved.rev }, save: get().save === 'dirty' ? 'dirty' : 'saved', error: null });
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
    host: null,
    save: 'saved',
    error: null,

    flushProject: async () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (writing) await writing;
      while (get().save === 'dirty') await flush();
      if (timer !== null) { clearTimeout(timer); timer = null; }
      return get().save === 'saved';
    },
    retryProjectSave: async () => {
      if (get().save === 'error') set({ save:'dirty' });
      return get().flushProject();
    },
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
      set({ project, shotId: project.shots[0]?.id ?? null, host: null, save: 'saved', error: null });
    },

    openInHost: (project, shotId, host, prepare) => {
      set({ project, shotId: project.shots.some((s) => s.id === shotId) ? shotId : (project.shots[0]?.id ?? null), host, save: 'saved', error: null, writeReport: null, planReport: null, proposals: null, exportResult: null, visionReports: {} });
      if (prepare !== undefined && JSON.stringify(prepare(project)) !== JSON.stringify(project)) get().update(prepare);
    },

    closeProject: async () => {
      // Автосейв ждёт паузу в 800 мс: без этого правка, сделанная за миг до «Назад», терялась.
      if (!await get().flushProject()) return;
      set({ project: null, shotId: null, host: null, writeReport: null, planReport: null, proposals: null, exportResult: null });
      void get().loadProjects().catch(() => undefined);
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
            durationSec: base?.durationSec ?? null,
            kitId: base?.kitId ?? 'arri-alexa35-cooke-s4i',
            customKit: base?.customKit ?? { camera: '', lens: '', look: '', lensNote: '' },
            // Как снято — тоже мир ролика: следующий кадр снимается той же камерой и так же смонтирован.
            ...(base?.shooting === undefined ? {} : { shooting: base.shooting }),
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
            attempts: [],
            critique: null,
          },
        ],
      }));
      set({ shotId: id, writeReport: null });
    },

    update: (recipe) => {
      const { project, save } = get();
      if (project === null || save === 'conflict') return;
      set({ project: invalidateSeriesCritique(project, recipe(project)), save: 'dirty' });
      schedule();
    },

    updateShot: (recipe) => {
      const { shotId } = get();
      get().update((project) => ({ ...project, shots: project.shots.map((shot) => (shot.id === shotId ? recipe(shot) : shot)) }));
    },

    composing: null,
    writeReport: null,

    composeShot: async (all = false) => {
      const { project, shotId } = get();
      const start = project?.shots.find((s) => s.id === shotId);
      if (project === null || shotId === null || start === undefined || get().composing !== null) return;
      writeAbort = new AbortController();
      const { signal } = writeAbort;
      // Правки применяются к кадру, для которого запускали, даже если владелец переключился на другой.
      const onShot = (recipe: (shot: Shot) => Shot): void => get().update((p) => ({ ...p, shots: p.shots.map((s) => (s.id === shotId ? recipe(s) : s)) }));
      const done: string[] = [];
      const report: WriteReport = { ok: true, messageRu: '', notes: {}, fieldsNoteRu: '', warningsRu: [], remainingRu: [] };
      set({ composing: 'fields', writeReport: null });
      try {
        // 1. Поля: место, погода, имена, последствия, своя камера, реквизит. Очищенные стираются без агента.
        const stale = staleFields(project, start, 'compose');
        if (stale.length > 0) {
          let answer: { items: FieldItem[]; output: FieldsOutput | null } = { items: stale, output: null };
          if (stale.some((item) => item.ru !== '')) {
            const result = await json<FieldsResponse>(await fetch('/api/llm/fields', { method: 'POST', headers: HEADERS, body: JSON.stringify({ project, shotId }), signal }));
            answer = { items: result.items, output: result.output };
            report.fieldsNoteRu = result.output?.notesRu ?? '';
            if (result.problems.length > 0) report.remainingRu.push(...result.problems.map((p) => `поля: ${p}`));
            done.push(`полей ${result.items.filter((item) => item.ru !== '').length}${result.meta === null ? '' : ` за ${Math.round(result.meta.durationMs / 1000)} с`}`);
          }
          get().update((p) => applyFields(p, shotId, answer.items, answer.output));
        }

        // 2. Отрезки: изменённые (или все — «переписать кадр»). С пустыми битами абзац просто стирается.
        const snapshot = get().project;
        const shot = snapshot?.shots.find((s) => s.id === shotId);
        if (snapshot === null || shot === undefined) return;
        const described = shot.segments.filter((s) => s.beatsRu.trim() !== '').map((s) => s.id);
        const stalled = new Set(staleSegments(shot));
        const segmentIds = all ? described : described.filter((id) => stalled.has(id));
        if (segmentIds.length > 0) {
          set({ composing: 'writing' });
          const beats = Object.fromEntries(shot.segments.map((s) => [s.id, s.beatsRu]));
          const result = await json<WriteResponse>(await fetch('/api/llm/write', { method: 'POST', headers: HEADERS, body: JSON.stringify({ project: snapshot, shotId, segmentIds }), signal }));
          onShot((s) => applyWrite(s, result.blocks, beats));
          report.notes = Object.fromEntries(result.blocks.map((b) => [b.segmentId, b.notesRu]));
          report.warningsRu = result.warningsRu;
          report.remainingRu.push(...result.remaining.violations.map((v) => `${v.segmentId}: ${v.messageEn}`), ...result.remaining.lintRu);
          done.push(`отрезков ${result.blocks.length} за ${Math.round(result.meta.durationMs / 1000)} с${result.rounds > 1 ? ', с ремонтным кругом' : ''}`);
        } else {
          onShot((s) => applyWrite(s, [], {}));
        }
        report.messageRu = done.length === 0 ? 'Всё уже собрано — агентам нечего переписывать.' : `Собрано: ${done.join(' · ')}.`;
        set({ writeReport: report });
      } catch (cause) {
        const aborted = cause instanceof DOMException && cause.name === 'AbortError';
        set({ writeReport: { ...report, ok: false, messageRu: aborted ? 'Отменено.' : cause instanceof Error ? cause.message : String(cause) } });
      } finally {
        writeAbort = null;
        set({ composing: null });
      }
    },

    cancelCompose: () => writeAbort?.abort(),

    symptoms: null,
    loadSymptoms: async () => set({ symptoms: await json<SymptomCatalog>(await fetch('/api/packs/cinema-doc/symptoms')) }),

    saveAttempt: (prompt) => {
      const { project } = get();
      if (project === null) return;
      get().updateShot((shot) => ({
        ...shot,
        attempts: [
          ...shot.attempts,
          {
            n: Math.max(0, ...shot.attempts.map((a) => a.n)) + 1,
            createdAt: new Date().toISOString(),
            prompt,
            panel: shot.panel.map((key, i) => ({ index: i + 1, key, label: project.refs.find((r) => r.key === key)?.label ?? key })),
            segments: shot.segments.map((s) => ({ id: s.id, en: s.text.en })),
            kitId: shot.kitId,
            verdict: 'pending',
            workedRu: '',
            failedRu: '',
            symptomIds: [],
            // Пересказ критика сохраняется только если он сделан для этого же текста.
            readbackRu: shot.critique?.prompt === prompt ? shot.critique.readback.map((r) => `${r.paragraph}. ${r.seesRu}${r.unsureRu !== undefined && r.unsureRu !== '' ? ` (не уверен: ${r.unsureRu})` : ''}`).join('\n') : '',
          },
        ],
      }));
    },

    critiquing: false,
    critiqueError: null,

    critiqueShot: async () => {
      const { project, shotId } = get();
      if (project === null || shotId === null || get().critiquing) return;
      critiqueAbort = new AbortController();
      set({ critiquing: true, critiqueError: null });
      try {
        const res = await fetch('/api/llm/critique', { method: 'POST', headers: HEADERS, body: JSON.stringify({ project, shotId, visionSummaries: Object.fromEntries(Object.entries(get().visionReports).map(([key, r]) => [key, r.summaryRu])) }), signal: critiqueAbort.signal });
        const { critique } = await json<{ critique: Critique }>(res);
        get().updateShot((shot) => ({ ...shot, critique }));
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) set({ critiqueError: error instanceof Error ? error.message : 'Критик не сработал.' });
      } finally {
        critiqueAbort = null;
        set({ critiquing: false });
      }
    },

    cancelCritique: () => critiqueAbort?.abort(),

    exporting: false,
    exportResult: null,

    exportPanel: async () => {
      const { project, shotId } = get();
      if (project === null || shotId === null || get().exporting) return;
      set({ exporting: true });
      try {
        const res = await fetch(`/api/projects/${project.slug}/shots/${shotId}/export`, { method: 'POST', headers: HEADERS });
        const result = await json<ExportResult>(res);
        if (result.downloadUrl) downloadFile(result.downloadUrl);
        set({ exportResult: result });
      } catch (error) {
        set({ exportResult: { dir: '', files: [], errorRu: error instanceof Error ? error.message : 'Не удалось выгрузить панель.' } });
      } finally {
        set({ exporting: false });
      }
    },

    updateAttempt: (n, patch) => get().updateShot((shot) => ({ ...shot, attempts: shot.attempts.map((a) => (a.n === n ? { ...a, ...patch } : a)) })),

    fixing: false,
    proposals: null,

    proposeFix: async (attemptN) => {
      const { project, shotId } = get();
      if (project === null || shotId === null || get().fixing) return;
      set({ fixing: true, proposals: null });
      try {
        const res = await fetch('/api/llm/fix', { method: 'POST', headers: HEADERS, body: JSON.stringify({ project, shotId, attemptN }) });
        const result = await json<WriteResponse>(res);
        const current = new Map(project.shots.find((s) => s.id === shotId)?.segments.map((s) => [s.id, s.text.en]) ?? []);
        const changed = result.blocks.filter((b) => current.get(b.segmentId) !== b.en);
        set({ proposals: { attemptN, items: changed, messageRu: changed.length === 0 ? 'Агент не нашёл, что менять в абзацах. Посмотри подсказки «что сделать самому» у симптомов.' : `Предложено правок: ${changed.length} из ${result.blocks.length} абзацев · ${Math.round(result.meta.durationMs / 1000)} с` } });
      } catch (cause) {
        set({ proposals: { attemptN, items: [], messageRu: cause instanceof Error ? cause.message : String(cause) } });
      } finally {
        set({ fixing: false });
      }
    },

    acceptProposal: (segmentId) => {
      const item = get().proposals?.items.find((p) => p.segmentId === segmentId);
      if (item === undefined) return;
      get().updateShot((shot) => ({ ...shot, segments: shot.segments.map((s) => (s.id === segmentId ? { ...s, text: { ...s.text, en: item.en, source: 'llm', locked: false } } : s)) }));
      get().dismissProposal(segmentId);
    },

    dismissProposal: (segmentId) => {
      const { proposals } = get();
      if (proposals !== null) set({ proposals: { ...proposals, items: proposals.items.filter((p) => p.segmentId !== segmentId) } });
    },

    analyzing: null,
    visionReports: {},

    analyzeRef: async (refKey) => {
      const { project } = get();
      if (project === null || get().analyzing !== null) return;
      set({ analyzing: refKey });
      try {
        const res = await fetch('/api/llm/vision', { method: 'POST', headers: HEADERS, body: JSON.stringify({ slug: project.slug, refKey }) });
        const { report, flags } = await json<{ report: { summaryRu: string; risksRu: string[]; clothingEn?: string }; flags: VisionReport['flags'] }>(res);
        set({ visionReports: { ...get().visionReports, [refKey]: { ok: true, summaryRu: report.summaryRu, risksRu: report.risksRu, clothingEn: report.clothingEn ?? '', flags } } });
      } catch (cause) {
        set({ visionReports: { ...get().visionReports, [refKey]: { ok: false, summaryRu: cause instanceof Error ? cause.message : String(cause), risksRu: [], clothingEn: '', flags: null } } });
      } finally {
        set({ analyzing: null });
      }
    },

    applyVisionFlags: (refKey) => {
      const flags = get().visionReports[refKey]?.flags;
      if (flags === null || flags === undefined) return;
      get().update((p) => ({ ...p, refs: p.refs.map((r) => (r.key === refKey ? { ...r, flags } : r)) }));
    },

    planning: false,
    planReport: null,

    planShot: async () => {
      const { project, shotId } = get();
      const shot = project?.shots.find((s) => s.id === shotId);
      if (project === null || shot === undefined || get().planning) return;
      set({ planning: true, planReport: null });
      try {
        const res = await fetch('/api/llm/plan', { method: 'POST', headers: HEADERS, body: JSON.stringify({ project, shotId: shot.id, synopsisRu: shot.synopsisRu }) });
        const { plan, newLines, problems, meta } = await json<PlanResponse>(res);
        const stamp = Date.now().toString(36);
        // Кадры раскадровки панели — по порядку: отрезок N открывается на кадре N (планировщик знает их число).
        const frames = storyboardFrames(project, shot).map((ref) => ref.key);
        get().update((p) => ({
          ...p,
          // Реплики из «ёлочек» синопсиса — буква в букву, невычитанные: галочку ставит владелец.
          lines: [...p.lines, ...newLines.map((l) => ({ id: l.id, speakerKey: null, ru: l.ru, proofread: false }))],
          shots: p.shots.map((s) => (s.id === shotId ? { ...s, segments: plan.segments.map((seg, i) => ({ id: `seg-${stamp}-${i + 1}`, titleRu: seg.titleRu, beatsRu: seg.beatsRu, text: { ru: '', en: '', source: 'empty' as const, locked: false }, frameRef: frames[i] ?? null })) } : s)),
        }));
        set({ planReport: { ok: problems.length === 0, messageRu: `Отрезков: ${plan.segments.length}${frames.length > 0 ? ` · по кадрам раскадровки: ${Math.min(frames.length, plan.segments.length)}` : ''} · новых реплик: ${newLines.length} · ${Math.round(meta.durationMs / 1000)} с. ${plan.notesRu}${problems.length > 0 ? ` Осталось: ${problems.join(' ')}` : ''} Проверь биты и нажми «Собрать промпт».` } });
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
