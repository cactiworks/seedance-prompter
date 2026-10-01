import { canvasRefKey, type CanvasNode, type Flow } from '../model/canvas.ts';
import type { RefSource } from '../model/media.ts';
import { syncPanel, type Project, type Ref } from '../model/project.ts';
import { nodeTitle } from './plan.ts';

/**
 * Seedance-промптер в canvas (решение 37): у ноды свой черновик-ролик, картинки входа «Рефы» становятся панелью
 * кадра. Здесь — чистая часть: что пришло проводками и как это ложится в проект. Сеть и файлы — в web.
 */
export interface SeedanceInput {
  /** Нода-источник: по ней ключ референса стабилен между открытиями. */
  nodeId: string;
  key: string;
  label: string;
  source: RefSource;
  /** Отпечаток источника: тот же — файл в панели не перезаливается. */
  signature: string;
  /** Тип по умолчанию: сгенерированная картинка и кадр из видео — кадр раскадровки, своя картинка — «Другое». */
  kind: Ref['kind'];
  /** Что на картинке — промпт генерации, если картинку сделал генератор выше по графу. */
  note: string | null;
}

/** Задача генератора → сохранённый файл и промпт, которым он сделан. */
export type JobLookup = (jobId: string) => { mediaId: string | null; prompt: string } | null;

const signatureOf = (source: RefSource): string => JSON.stringify(source);
const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 42) return flat;
  const cut = flat.slice(0, 41);
  const space = cut.lastIndexOf(' ');
  return `${(space > 24 ? cut.slice(0, space) : cut).replace(/[\s,.:;—-]+$/, '')}…`;
};

/**
 * Картинки на входе «Рефы» в порядке проводков. Генератор выше без результата или видео — не картинка панели:
 * причина уходит в problems, остальное открывается как есть. Сам ничего не запускает.
 */
export function seedanceInputs(flow: Flow, nodeId: string, jobOf: JobLookup): { inputs: SeedanceInput[]; problems: string[] } {
  const inputs: SeedanceInput[] = [];
  const problems: string[] = [];
  const labels = new Map<string, number>();
  const uniqueLabel = (label: string): string => {
    const n = (labels.get(label) ?? 0) + 1;
    labels.set(label, n);
    return n === 1 ? label : `${label} · ${n}`;
  };
  for (const edge of flow.edges.filter((e) => e.to === nodeId && e.port === 'ref')) {
    const from = flow.nodes.find((n) => n.id === edge.from);
    if (from === undefined) continue;
    // Сгенерированный кадр подписывается началом своего промпта: «Картинка · GPT Image 2.5» трижды подряд не различить.
    const add = (source: RefSource, kind: Ref['kind'], note: string | null): void => {
      const label = note === null ? nodeTitle(from) : excerpt(note);
      inputs.push({ nodeId: from.id, key: canvasRefKey(from.id), label: uniqueLabel(label), source, signature: signatureOf(source), kind, note });
    };
    if (from.type === 'image') {
      if (from.source === null) problems.push(`В ноде «${nodeTitle(from)}» нет картинки — в панель она не попала.`);
      else add(from.source, 'other', null);
    } else if (from.type === 'generator') {
      if (from.kind === 'video') {
        problems.push(`«${nodeTitle(from)}»: видео в панель Seedance-промптера пока не подаётся — возьми из него кадр нодой «Кадр».`);
        continue;
      }
      const jobId = from.jobIds[from.selected];
      const job = jobId === undefined ? null : jobOf(jobId);
      if (job === null || job.mediaId === null) problems.push(`«${nodeTitle(from)}» ещё без результата — запусти его, и картинка придёт в панель при следующем открытии.`);
      else add({ type: 'media', mediaId: job.mediaId }, 'frame', job.prompt.trim() === '' ? null : job.prompt.trim());
    } else if (from.type === 'frame' || from.type === 'resize') {
      if (from.mediaId === null) problems.push(`В ноде «${nodeTitle(from)}» ещё нет файла.`);
      else if (from.type === 'resize' && from.kind === 'video') problems.push(`«${nodeTitle(from)}» отдаёт видео — в панель идут только картинки.`);
      else add({ type: 'media', mediaId: from.mediaId }, from.type === 'frame' ? 'frame' : 'other', null);
    }
  }
  return { inputs, problems };
}

/** Входы, чей файл в панели надо (пере)залить: новые или с другим источником. `synced` — node.refSync. */
export function inputsToUpload(inputs: SeedanceInput[], synced: Record<string, string>, project: Project | null): SeedanceInput[] {
  return inputs.filter((input) => {
    const ref = project?.refs.find((r) => r.key === input.key);
    return synced[input.key] !== input.signature || ref === undefined || ref.file === null;
  });
}

/**
 * Проект ← входы ноды. Новая картинка — в конец панели с типом по умолчанию; та же — тип и порядок владельца не
 * трогаются; заменили картинку (другой вариант генератора) — новый файл и сброшенные флаги vision; проводок сняли —
 * картинка уходит из панели, запись референса остаётся (вернёшь проводок — вернётся и тип). `files` — имена
 * залитых файлов, `tracked` — ключи, которые прошлое открытие положило из canvas.
 */
export function applySeedanceInputs(project: Project, shotId: string, inputs: SeedanceInput[], files: Record<string, string>, tracked: string[]): Project {
  const byKey = new Map(inputs.map((input) => [input.key, input]));
  const refs: Ref[] = project.refs.map((ref) => {
    const input = byKey.get(ref.key);
    if (input === undefined) return ref;
    const file = files[ref.key];
    const replaced = file !== undefined && ref.file !== null;
    return {
      ...ref,
      label: input.label,
      file: file ?? ref.file,
      ...(input.note === null ? {} : { note: input.note }),
      flags: replaced ? { hasPeople: false, hasText: false, studioBackdrop: false } : ref.flags,
    };
  });
  for (const input of inputs) {
    if (refs.some((r) => r.key === input.key)) continue;
    refs.push({ key: input.key, label: input.label, kind: input.kind, file: files[input.key] ?? null, flags: { hasPeople: false, hasText: false, studioBackdrop: false }, ...(input.note === null ? {} : { note: input.note }) });
  }
  const gone = new Set(tracked.filter((key) => !byKey.has(key)));
  const next: Project = { ...project, refs };
  return {
    ...next,
    shots: next.shots.map((shot) => {
      if (shot.id !== shotId) return shot;
      const panel = shot.panel.filter((key) => !gone.has(key));
      for (const input of inputs) if (!panel.includes(input.key)) panel.push(input.key);
      return syncPanel(next, { ...shot, panel });
    }),
  };
}

/** Русское число: 1 шот, 2 шота, 5 шотов, 21 шот, 12 шотов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Подпись ноды на холсте после закрытия промптера: как снято, длительность, формат — и начало сюжета. */
export function seedanceSummary(parts: { shootingRu: string; kitRu: string; durationSec: number; aspect: string; shots: number; cuts: boolean; synopsisRu: string }): string {
  const head = [parts.shootingRu, parts.kitRu, `${parts.durationSec} с`, parts.aspect, parts.cuts ? `${parts.shots} ${plural(parts.shots, 'шот', 'шота', 'шотов')}` : 'один дубль'].filter((p) => p !== '').join(' · ');
  const synopsis = parts.synopsisRu.trim().replace(/\s+/g, ' ');
  return synopsis === '' ? head : `${head}\n${synopsis.length > 160 ? `${synopsis.slice(0, 157)}…` : synopsis}`;
}

/** Копия ноды на холсте получает копию черновика при первом открытии, а не тот же ролик. */
export function cloneSeedance(node: CanvasNode): Partial<CanvasNode> {
  return node.type !== 'seedance' ? {} : { slug: '', shotId: '', copyFrom: node.slug !== '' ? node.slug : node.copyFrom, refSync: {} };
}
