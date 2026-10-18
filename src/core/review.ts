import type { Critique, Project, Shot } from './model/project.ts';

export interface BuildBlocker {
  code: string;
  messageRu: string;
  /** Есть только у требований к содержанию, которые владелец может снять. */
  fingerprint?: string;
}

// Ошибки pack и неразрешённые плейсхолдеры не являются редакторским решением.
const DISMISSIBLE = new Set([
  'NEEDS_COMPOSE', 'CUSTOM_KIT_EMPTY', 'CUSTOM_KIT_NO_CAMERA', 'CUSTOM_KIT_NO_LOOK',
  'CUSTOM_SHOOTING_EMPTY', 'CUSTOM_SHOOTING_NOT_WRITTEN', 'NO_LOCATION_REF', 'NO_PLACE',
  'ENTITY_NO_NAME', 'ROLE_SPLIT_INCOMPLETE', 'NO_SCENARIO', 'LINE_EMPTY', 'LINE_NOT_PROOFREAD',
]);

/** Короткий отпечаток содержимого; не security hash. Одинаков в браузере и на сервере. */
function stamp(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  return `${text.length}-${hash.toString(36)}`;
}

export function reviewBlockers(blockers: BuildBlocker[], project: Project, shot: Shot, prompt: string): BuildBlocker[] {
  // Решение не переносится на изменённый текст, русское задание или референсы. Сохранение,
  // новый отчёт критика и другие исключения сами по себе его не сбрасывают.
  const context = stamp({
    ...project, rev: undefined, title: undefined, shots: undefined,
    shot: { ...shot, title: undefined, suppressed: undefined, critique: undefined, attempts: undefined },
    prompt,
  });
  const suppressed = new Set(shot.suppressed.map((item) => item.fingerprint));
  return blockers.flatMap((blocker) => {
    if (!DISMISSIBLE.has(blocker.code)) return [blocker];
    const fingerprint = `blocker:${blocker.code}:${context}:${stamp(blocker.messageRu)}`;
    return suppressed.has(fingerprint) ? [] : [{ ...blocker, fingerprint }];
  });
}

export function critiqueFingerprint(critique: Critique, finding: Critique['findings'][number]): string {
  return `critic:${stamp([critique.prompt, critique.createdAt, finding])}`;
}

/** Исходный отчёт неизменен; скрываем только решения для этой версии проверки. */
export function activeCritiqueFindings(shot: Shot, prompt: string): Critique['findings'] {
  const critique = shot.critique;
  if (critique === null || critique.prompt !== prompt) return [];
  const suppressed = new Set(shot.suppressed.map((item) => item.fingerprint));
  return critique.findings.filter((finding) => !suppressed.has(critiqueFingerprint(critique, finding)));
}
