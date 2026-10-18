import { currentArtifact, isAutomatic, type Artifact, type ProductionRun, type ProductionShot, type RunAction, type RunInput } from './model.ts';
import { reviewedPhoto } from './review.ts';
import { applyReviewDecision } from './reviewDecisions.ts';

export class ProductionError extends Error {
  readonly code: 'CONFLICT' | 'INVALID' | 'NOT_FOUND';
  constructor(code: ProductionError['code'], message: string) { super(message); this.code = code; }
}
const iso = (now: number): string => new Date(now).toISOString();
export function record(run: ProductionRun, now: number, message: string): void {
  run.events.push({ at: iso(now), message });
  run.rev += 1;
  run.updatedAt = iso(now);
}
export function newRun(id: string, input: RunInput, now: number, delay: number): ProductionRun {
  return { ...input, id, rev: 0, createdAt: iso(now), updatedAt: iso(now), paused: false, planned: false, dueAt: now + delay,
    shots: [], artifacts: [], approvals: [], events: [{ at: iso(now), message: input.planningMode === 'codex' ? input.mode === 'photos' ? 'Codex готовит события, сцены и prompts. Фото запустятся только после подтверждения стоимости.' : 'Запущена подготовка Codex. Медиа и QC остаются mock; медиа-кредиты не расходуются.' : 'Запущена mock-серия. Внешние сервисы не вызываются; стоимость 0.' }],
    ...(input.planningMode === 'codex' ? { preparation: { status: 'running' as const, stage: 'scene' as const, attempt: 1, startedAt: iso(now), error: null, calls: [] } } : {}) };
}
export function completePreparation(source: ProductionRun, now: number, delay: number): ProductionRun {
  if (!source.scenePlan || !source.promptPlan || !source.preparation || source.planned) throw new ProductionError('INVALID', 'Подготовка ещё не завершена.');
  const run = structuredClone(source);
  run.shots = source.scenePlan.shots.map((s, index) => ({
    id: s.id, title: s.title, framing: s.framing, action: s.action, step: 'photos',
    photoId: null, videoId: null, finalId: null, acceptedPhotoId: null, acceptedVideoId: null,
    dueAt: now + delay * (index + 1), error: null, editNote: '', editSourceId: null,
  }));
  run.planned = true;
  run.preparation!.status = 'complete';
  record(run, now, `Codex подготовил план событий и prompts для ${run.shots.length} кадров. ${run.mode === 'photos' ? 'Ожидается подтверждение стоимости реальных фото.' : 'Дальше — только mock-медиа и mock QC.'}`);
  return run;
}
function makeArtifact(run: ProductionRun, shot: ProductionShot, kind: Artifact['kind'], now: number): Artifact {
  const version = run.artifacts.filter((a) => a.shotId === shot.id && a.kind === kind).length + 1;
  const id = `${shot.id}-${kind}-v${version}`;
  const index = run.shots.indexOf(shot) % 3 + 1;
  const repaired = kind === 'photo' ? version > 1 : (currentArtifact(run, shot.photoId)?.version ?? 1) > 1;
  const base = `/production-mock/shot-${index}${repaired ? '-edit' : ''}`;
  const planned = run.promptPlan?.shots.find((p) => p.shotId === shot.id);
  const prompt = kind === 'photo' && planned ? planned.imagePrompt : kind === 'video' && planned ? planned.motionPrompt : kind === 'photo'
    ? `Demo still: ${shot.framing}. Same room, window light, same character and wardrobe. ${run.style === 'phone' ? 'Casual smartphone framing.' : 'Cinematic controlled framing.'}`
    : kind === 'video' ? 'Demo motion: a slow camera move, stable subject and room. Use the approved start image. Duration 4s; resolution 480p.' : 'Demo upscale of the approved clip. Keep its duration, composition and identity.';
  return {
    id, shotId: shot.id, kind, version, sourceId: kind === 'photo' ? shot.editSourceId : kind === 'video' ? shot.acceptedPhotoId : shot.acceptedVideoId,
    url: `${base}.${kind === 'photo' ? 'png' : 'mp4'}`, poster: `${base}.png`, prompt,
    model: kind === 'photo' ? (version > 1 ? 'Seedream 5 Pro · KIE' : run.style === 'phone' ? 'Soul 2 · Higgsfield' : 'Soul Cinema · Higgsfield') : kind === 'video' ? 'Seedance 2.5 · Higgsfield' : 'Topaz · KIE',
    taskId: `mock-${run.id}-${id}`, createdAt: iso(now), qc: 'pending', qcNote: '', note: kind === 'photo' ? shot.editNote : '', cost: 0,
  };
}
/** Pure state transitions. There is intentionally no provider, network, or LLM dependency. */
export function advanceRun(source: ProductionRun, now: number, delay: number): ProductionRun {
  if (source.mode === 'photos') return source;
  if (source.paused) return source;
  const run = structuredClone(source);
  if (!run.planned) {
    // Real preparation is driven only by an explicit API action, never by a timer.
    if (run.planningMode === 'codex') return source;
    if (now < run.dueAt) return source;
    const descriptions = [
      ['У окна', 'Средний план', 'Герой смотрит в окно'],
      ['Мысль на бумаге', 'Крупный план', 'Рука делает запись в блокноте'],
      ['Маленькая деталь', 'Деталь', 'Кружка и блокнот на столе'],
    ];
    run.shots = descriptions.map(([title, framing, action], index) => ({
      id: `shot-${index + 1}`, title: title!, framing: framing!, action: action!, step: 'photos',
      photoId: null, videoId: null, finalId: null, acceptedPhotoId: null, acceptedVideoId: null,
      dueAt: now + delay * (index + 1), error: null, editNote: '', editSourceId: null,
    }));
    run.planned = true;
    record(run, now, 'Подготовлен демонстрационный паспорт одной сцены и три кадра. Сценарий сохранён, LLM-анализ пока не подключён.');
    return run;
  }
  // One completion per tick makes transitions observable and limits concurrent mock work.
  const shot = run.shots.find((s) => s.error === null && isAutomatic(s.step) && now >= s.dueAt);
  if (!shot) return source;
  const before = shot.step;
  if (before === 'photos') {
    const artifact = makeArtifact(run, shot, 'photo', now); run.artifacts.push(artifact); shot.photoId = artifact.id; shot.step = 'photoQc';
  } else if (before === 'photoQc') {
    const a = currentArtifact(run, shot.photoId)!;
    a.qc = run.scenario === 'repair' && shot.id === 'shot-2' && a.version === 1 ? 'repair' : 'pass';
    a.qcNote = a.qc === 'repair' ? 'Демо-дефект: лишняя деталь у блокнота. Нужна локальная правка.' : 'Mock QC: ракурс и continuity приняты. Сходство с твоим лицом здесь не проверяется.';
    shot.step = 'photoReview';
  } else if (before === 'videos') {
    if (shot.acceptedPhotoId !== shot.photoId) throw new ProductionError('INVALID', 'Фотография не принята.');
    const a = makeArtifact(run, shot, 'video', now); run.artifacts.push(a); shot.videoId = a.id; shot.step = 'videoQc';
  } else if (before === 'videoQc') {
    const a = currentArtifact(run, shot.videoId)!; a.qc = 'pass'; a.qcNote = 'Mock QC: 4 секунды, демонстрационное движение камеры. Посмотри клип перед Topaz.'; shot.step = 'videoReview';
  } else if (before === 'upscale') {
    if (shot.acceptedVideoId !== shot.videoId) throw new ProductionError('INVALID', 'Видео не принято перед Topaz.');
    const a = makeArtifact(run, shot, 'final', now); run.artifacts.push(a); shot.finalId = a.id; shot.step = 'finalQc';
  } else if (before === 'finalQc') {
    const a = currentArtifact(run, shot.finalId)!; a.qc = 'pass'; a.qcNote = 'Демо завершено. Файл остался 480p: настоящий upscale не запускался.'; shot.step = 'ready';
  }
  shot.dueAt = now + delay;
  record(run, now, `${shot.title}: ${before} → ${shot.step}.`);
  return run;
}
export function applyRunAction(source: ProductionRun, action: RunAction, now: number, delay: number): ProductionRun {
  if (action.rev !== source.rev) throw new ProductionError('CONFLICT', 'Серия уже изменилась. Данные обновлены — повтори действие для текущей версии.');
  const run = structuredClone(source);
  if (action.type === 'setReviewDismissal' || action.type === 'acceptReviewedPhoto') {
    applyReviewDecision(run, action, now);
    return run;
  }
  if (action.type === 'pause' || action.type === 'resume') {
    run.paused = action.type === 'pause';
    if (run.retouch?.status === 'running' && run.paused) { run.retouch.status = 'stopped'; for (const item of run.retouch.items) if (item.status === 'checking') { item.status = 'pending'; item.error = 'Проверка прервана паузой.'; } }
    if (run.photos?.status === 'running' && run.paused) run.photos.status = 'stopped';
    record(run, now, run.paused ? 'Производство поставлено на паузу.' : 'Производство продолжено с сохранённого этапа.');
    return run;
  }
  if (run.paused) throw new ProductionError('INVALID', 'Сначала продолжи серию.');
  if (run.mode === 'photos' && !['approvePhotos', 'retryPreparation'].includes(action.type)) throw new ProductionError('INVALID', 'В этой серии доступны только реальные фото. Видео, upscale и mock-правки отключены.');
  if (action.type === 'retryPreparation') throw new ProductionError('INVALID', 'Повтор подготовки выполняется сервером.');
  if (action.type === 'approvePhotos' || action.type === 'approveVideos') {
    const photo = action.type === 'approvePhotos';
    const ids = new Set(action.ids);
    if (ids.size !== action.ids.length) throw new ProductionError('INVALID', 'Один результат указан дважды.');
    for (const id of ids) {
      const shot = run.shots.find((s) => (photo ? s.photoId : s.videoId) === id);
      const artifact = currentArtifact(run, id);
      if (run.mode === 'photos' && artifact && !reviewedPhoto(run, id)) throw new ProductionError('INVALID', 'Сначала дождись проверки этого кадра критиком перед milestone.');
      if (!shot || !artifact || (artifact.qc !== 'pass' && !(run.mode === 'photos' && artifact.qc === 'review' && artifact.mediaId)) || shot.step !== (photo ? 'photoReview' : 'videoReview')) throw new ProductionError('INVALID', 'Принимать можно только текущие проверенные результаты этого milestone.');
      if (run.mode === 'photos') throw new ProductionError('INVALID', 'После milestone нужна проверка деталей и автоправки. Подтверди их стоимость.');
      if (photo) { shot.acceptedPhotoId = id; shot.step = 'videos'; }
      else { shot.acceptedVideoId = id; shot.step = 'upscale'; }
      shot.dueAt = now + delay;
      run.approvals.push({ kind: photo ? 'photo' : 'video', artifactId: id, at: iso(now) });
    }
    if (run.photos && run.shots.every((s) => s.step === 'ready')) run.photos.status = 'complete';
    record(run, now, `${photo ? 'Milestone 1: приняты фотографии' : 'Milestone 2: приняты видео до Topaz'} — ${ids.size}. Остальные ветви остаются на своём этапе.`);
    return run;
  }
  const shot = run.shots.find((s) => s.id === action.shotId);
  if (!shot) throw new ProductionError('NOT_FOUND', 'Кадр не найден.');
  if (action.type === 'edit') {
    if (shot.photoId !== action.sourceId || !currentArtifact(run, action.sourceId) || shot.step === 'photos' || shot.step === 'photoQc') throw new ProductionError('INVALID', 'Исходник изменился или ещё проверяется.');
    shot.editSourceId = action.sourceId; shot.editNote = action.note; shot.step = 'photos';
    shot.acceptedPhotoId = null; shot.acceptedVideoId = null; shot.videoId = null; shot.finalId = null; shot.error = null;
    shot.dueAt = now + delay;
    record(run, now, `${shot.title}: новая правка от ${action.sourceId}. Исходник сохранён; прежние приёмки и зависимые видео больше не действуют для этой ветви.`);
  } else if (action.type === 'simulateFailure') {
    if (!isAutomatic(shot.step) || shot.error !== null) throw new ProductionError('INVALID', 'Сбой можно показать только на работающем этапе.');
    shot.error = 'Смоделирован сбой mock-этапа. Сохранённый результат и остальные кадры не потеряны.';
    record(run, now, `${shot.title}: демонстрационный сбой на этапе ${shot.step}.`);
  } else {
    if (shot.error === null) throw new ProductionError('INVALID', 'У этого кадра нет сбоя.');
    shot.error = null; shot.dueAt = now + delay;
    record(run, now, `${shot.title}: повтор сохранённого mock-этапа. Новая платная генерация не создаётся.`);
  }
  return run;
}
