import { formatCost } from '../formatCost.ts';
import { nodeTitle } from './nodeTitle.ts';
import { ui } from '../language.ts';
import { SeriesNodeStatus } from '../series/SeriesPreparation.tsx';
import { inputFingerprint } from '../../core/canvas/freshness.ts';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { frameInput, mediaInput, planRun, sourceKey, trimProblems } from '../../core/canvas/plan.ts';
import { seedanceInputs } from '../../core/canvas/seedance.ts';
import { findModel, modelsOf, paramsFor, upscaleModelOf } from '../../core/gen/models.ts';
import { inputsOf, RESIZE_PRESETS, type CanvasNode, type InputPort } from '../../core/model/canvas.ts';
import type { MediaItem } from '../../core/model/media.ts';
import { extractFrame, hasRefsConsent, importMedia, isActive, measureInput, mediaUrl, resizeMedia, savedMediaOf, thumbOf, trimVideo, uploadImage, useGen, type MeasuredInput } from '../gen/genStore.ts';
import { ParamField } from '../studio/Controls.tsx';
import { retryable, STATUS_RU } from '../studio/JobTile.tsx';
import { DownloadMediaButton, MediaPreview } from '../studio/MediaPreview.tsx';
import { Button, Icon, SegmentedControl, Text } from '../ui/components/index.ts';
import styles from './Canvas.module.css';
import { NODE_WIDTH, PORT_STEP, PORT_TOP, useCanvas } from './canvasStore.ts';
import { jobLookup, openSeedanceNode } from './openSeedance.ts';
import { submissionIssue } from '../../core/gen/jobStatus.ts';

export const PORT_RU: Record<InputPort, string> = { prompt: 'Промпт', ref: 'Реф', start: 'Старт', end: 'Финал', video: 'Видео', media: 'Файл' };

/** Входы ноды с учётом ролей выбранной модели. */
export function portsOf(node: CanvasNode): InputPort[] {
  return inputsOf(node, findModel(node.modelId)?.refs.roles ?? []);
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Один мост из любого сохранённого результата в правку и выдачу файла. */
function SavedResultActions({ mediaId }: { mediaId: string }) {
  const { library, addRef } = useGen();
  const [open, setOpen] = useState<MediaItem | null>(null);
  const item = library.find((m) => m.id === mediaId);
  if (item === undefined) return null;
  return (
    <>
      <div className={styles.nodeRow} data-guide="canvas-result" onPointerDown={(event) => event.stopPropagation()}>
        <Button variant="border" size="xs" onClick={() => setOpen(item)}>
          {ui("Открыть и править")}</Button>
        <DownloadMediaButton item={item} size="xs" />
      </div>
      <MediaPreview
        item={open}
        initialTab="edit"
        onClose={() => setOpen(null)}
        onUseAsRef={(source, target) => {
          addRef(target, { label: 'Из Canvas', source: { type: 'media', mediaId: source.id } });
          setOpen(null);
          window.location.hash = target === 'image' ? '/images' : '/video';
        }}
      />
    </>
  );
}

/**
 * Обрезка видео (решение 35): начало и конец в секундах, «сейчас» берёт позицию плеера. Правка отрезка сбрасывает
 * прежний результат — он уже не соответствует. Обрезает ffmpeg на этом компьютере, бесплатно.
 */
function TrimBody({ node, sourceId, problemRu }: { node: CanvasNode; sourceId: string | null; problemRu: string | null }) {
  const { patchNode } = useCanvas();
  const loadLibrary = useGen((s) => s.loadLibrary);
  const player = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = trimProblems(node.start, node.end, duration);
  const length = duration === null ? null : (node.end === 0 ? duration : node.end) - node.start;
  const setRange = (patch: { start?: number; end?: number }): void => patchNode(node.id, { ...patch, mediaId: null }, `trim:${node.id}`);

  const cut = async (): Promise<void> => {
    if (sourceId === null) return;
    setBusy(true);
    setError(null);
    const finish = useCanvas.getState().captureResult(node.id);
    try {
      const item = await trimVideo(sourceId, node.start, node.end);
      finish({ mediaId: item.id });
      void loadLibrary();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Видео не обрезалось.');
    } finally {
      setBusy(false);
    }
  };

  if (sourceId === null) {
    return (
      <div className={`${styles.nodeDrop} lab-hatch`}>
        <Text variant="caption" tone="tertiary">
          {problemRu ?? ui("Подключи ко входу «Видео» генератор видео.")}
        </Text>
      </div>
    );
  }
  return (
    <>
      <video ref={player} className={styles.nodeVideo} src={mediaUrl(sourceId)} controls muted playsInline onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} />
      {(['start', 'end'] as const).map((key) => (
        <div key={key} className={styles.trimRow}>
          <Text as="span" variant="caption" tone="secondary" className={styles.trimLabel}>
            {key === 'start' ? ui("Начало, с") : ui("Конец, с")}
          </Text>
          <input className={styles.trimInput} type="number" min={0} step={0.1} value={node[key]} aria-label={key === 'start' ? ui("Начало, секунды") : ui("Конец, секунды (0 — до конца)")} onChange={(event) => setRange({ [key]: Math.max(0, Number(event.target.value) || 0) })} />
          <Button variant="ghost" size="xs" title={ui("Взять текущую позицию плеера")} onClick={() => setRange({ [key]: round1(player.current?.currentTime ?? 0) })}>
            {ui("сейчас")}</Button>
        </div>
      ))}
      <Text variant="caption" tone={problems.length > 0 ? 'accent' : 'tertiary'}>
        {problems[0] ?? `${node.end === 0 ? ui("Конец 0 — до конца видео. ") : ''}${length === null ? '' : ui("Отрезок: {0} с", length.toFixed(1))}`}
      </Text>
      {node.mediaId !== null && <video className={styles.nodeVideo} src={mediaUrl(node.mediaId)} controls muted playsInline loop />}
      {!node.stale && node.mediaId !== null && <SavedResultActions mediaId={node.mediaId} />}
      <Button variant="border" size="s" icon={<Icon name="time" size={0.875} />} loading={busy} disabled={problems.length > 0} onClick={() => void cut()}>
        {node.mediaId === null ? ui("Обрезать · бесплатно") : ui("Обрезать заново")}
      </Button>
      <Text variant="caption" tone="tertiary">
        {ui("Выход — видео: тяни в «Кадр из видео» или в следующую обрезку.")}</Text>
      {error !== null && (
        <Text variant="caption" tone="accent">
          {error}
        </Text>
      )}
    </>
  );
}

/** Своё видео (решение 36): файл с диска уходит в библиотеку, нода держит его id; выход — видео для кадра и обрезки. */
function VideoBody({ node, onPick }: { node: CanvasNode; onPick: () => void }) {
  const loadLibrary = useGen((s) => s.loadLibrary);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (f: File): Promise<void> => {
    setBusy(true);
    setError(null);
    const finish = useCanvas.getState().captureResult(node.id);
    try {
      const item = await importMedia(f);
      finish({ mediaId: item.id, label: f.name });
      void loadLibrary();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Видео не загрузилось.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {node.mediaId !== null ? (
        <video className={styles.nodeVideo} src={mediaUrl(node.mediaId)} controls muted playsInline />
      ) : (
        <div className={`${styles.nodeDrop} lab-hatch`}>
          <Text variant="caption" tone="tertiary">
            {busy ? ui("Загружаю…") : ui("Перетащи видео сюда")}
          </Text>
        </div>
      )}
      {!node.stale && node.mediaId !== null && <SavedResultActions mediaId={node.mediaId} />}
      <div className={styles.nodeRow}>
        <input
          ref={file}
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          hidden
          onChange={(event) => {
            const f = event.target.files?.[0];
            event.target.value = '';
            if (f !== undefined) void upload(f);
          }}
        />
        <Button variant="border" size="xs" icon={<Icon name="upload" size={0.875} />} loading={busy} onClick={() => file.current?.click()}>
          {ui("С диска")}</Button>
        <Button variant="border" size="xs" icon={<Icon name="images" size={0.875} />} onClick={onPick}>
          {ui("Из библиотеки")}</Button>
      </div>
      <Text variant="caption" tone="tertiary">
        {ui("Выход — видео: тяни в «Кадр из видео» или «Обрезку». Файл с диска остаётся в библиотеке.")}</Text>
      {error !== null && (
        <Text variant="caption" tone="accent">
          {error}
        </Text>
      )}
    </>
  );
}

/** «Размер» (решение 36): пресеты площадок или свой W×H, заполнить или вписать; ffmpeg на этом компьютере, бесплатно. */
function ResizeBody({ node }: { node: CanvasNode }) {
  const { flow, patchNode } = useCanvas();
  const { jobs, loadLibrary } = useGen();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaOf = (jobId: string): string | null => savedMediaOf(jobs, jobId);
  const input = flow === null ? null : mediaInput(flow, node.id, mediaOf);
  const preset = RESIZE_PRESETS.findIndex((p) => p.width === node.width && p.height === node.height);
  const setSize = (patch: Partial<Pick<CanvasNode, 'width' | 'height' | 'fit'>>): void => patchNode(node.id, { ...patch, mediaId: null }, `resize:${node.id}`);

  const run = async (): Promise<void> => {
    if (input?.source == null) return;
    setBusy(true);
    setError(null);
    const finish = useCanvas.getState().captureResult(node.id);
    try {
      const item = await resizeMedia(input.source, node.width, node.height, node.fit);
      finish({ mediaId: item.id, kind: item.kind });
      void loadLibrary();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Размер не подогнался.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <select className={styles.nodeSelect} value={preset < 0 ? 'custom' : String(preset)} aria-label={ui("Размер площадки")} onChange={(event) => event.target.value !== 'custom' && setSize({ width: RESIZE_PRESETS[Number(event.target.value)]?.width, height: RESIZE_PRESETS[Number(event.target.value)]?.height })}>
        {RESIZE_PRESETS.map((p, i) => (
          <option key={p.labelRu} value={String(i)}>
            {p.labelRu} · {p.width}×{p.height}
          </option>
        ))}
        <option value="custom">{ui("Свой размер")}</option>
      </select>
      <div className={styles.trimRow}>
        <Text as="span" variant="caption" tone="secondary" className={styles.trimLabel}>
          {ui("Ш × В, px")}</Text>
        <span className={styles.sizePair}>
          <input className={styles.trimInput} type="number" min={16} max={8192} step={2} value={node.width} aria-label={ui("Ширина")} onChange={(event) => setSize({ width: Math.min(8192, Math.max(16, Math.round(Number(event.target.value) || 16))) })} />
          <input className={styles.trimInput} type="number" min={16} max={8192} step={2} value={node.height} aria-label={ui("Высота")} onChange={(event) => setSize({ height: Math.min(8192, Math.max(16, Math.round(Number(event.target.value) || 16))) })} />
        </span>
      </div>
      {(node.width % 2 !== 0 || node.height % 2 !== 0) && <Text variant="caption" tone="accent">{ui("Ширина и высота должны быть чётными.")}</Text>}
      <SegmentedControl<'cover' | 'contain'>
        aria-label={ui("Как вписать")}
        size="s"
        value={node.fit}
        onChange={(fit) => setSize({ fit })}
        options={[
          { value: 'cover', label: ui("Заполнить"), title: ui("Заполнить кадр, лишнее по краям обрезать") },
          { value: 'contain', label: ui("Вписать"), title: ui("Вписать целиком, пустое — чёрными полями") },
        ]}
      />
      {node.mediaId !== null ? (
        node.kind === 'video' ? <video className={styles.nodeVideo} src={mediaUrl(node.mediaId)} controls muted playsInline /> : <img className={styles.nodeImage} src={mediaUrl(node.mediaId)} alt={nodeTitle(node)} />
      ) : (
        <div className={`${styles.nodeDrop} lab-hatch`}>
          <Text variant="caption" tone="tertiary">
            {input?.problemRu ?? ui("Будет {0} {1}×{2}", input?.kind === 'video' ? ui("видео") : ui("картинка"), node.width, node.height)}
          </Text>
        </div>
      )}
      {!node.stale && node.mediaId !== null && <SavedResultActions mediaId={node.mediaId} />}
      <Button variant="border" size="s" icon={<Icon name="apps" size={0.875} />} loading={busy} disabled={input?.source == null || node.width % 2 !== 0 || node.height % 2 !== 0} onClick={() => void run()}>
        {node.mediaId === null ? ui("Подогнать · бесплатно") : ui("Подогнать заново")}
      </Button>
      {error !== null && (
        <Text variant="caption" tone="accent">
          {error}
        </Text>
      )}
    </>
  );
}

/**
 * Seedance-промптер (решение 37): полный конструктор кадра — по кнопке, поверх холста. Здесь — подпись черновика,
 * что пришло на вход «Рефы» и выход: видео, сгенерированное из промптера (варианты по порядку запусков).
 */
function SeedanceBody({ node }: { node: CanvasNode }) {
  const { flow, patchNode } = useCanvas();
  const jobs = useGen((s) => s.jobs);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);

  // Выход ноды — генерации её кадра: запущены из промптера (origin), новые добавляются, выбирается последняя.
  const mine = useMemo(() => (node.slug === '' ? [] : jobs.filter((j) => j.origin?.projectSlug === node.slug && j.origin.shotId === node.shotId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((j) => j.id)), [jobs, node.slug, node.shotId]);
  useEffect(() => {
    const added = mine.filter((id) => !node.jobIds.includes(id));
    if (added.length > 0) patchNode(node.id, { jobIds: [...node.jobIds, ...added], selected: node.jobIds.length + added.length - 1, ...(flow !== null && node.runInputFingerprint === inputFingerprint(flow, node.id) ? { stale: false } : {}) }, false);
  }, [mine, node.id, node.jobIds, node.runInputFingerprint, flow, patchNode]);

  const inputs = flow === null ? null : seedanceInputs(flow, node.id, jobLookup);
  const open = async (): Promise<void> => {
    setBusy(true);
    setNotes([]);
    try {
      setNotes(await openSeedanceNode(node.id));
    } catch (e) {
      setNotes([e instanceof Error ? e.message : 'Промптер не открылся.']);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {node.production && <SeriesNodeStatus slug={node.slug} />}
      <Text variant="caption" tone={node.text === '' ? 'tertiary' : 'secondary'} className={styles.seedanceSummary}>
        {node.text === '' ? ui("Полный конструктор кадра: съёмка, камера, референсы по номерам, сценарий по шотам, агенты, проверка и генерация Seedance 2.5.") : node.text}
      </Text>
      <Text variant="caption" tone="tertiary">
        {inputs === null || inputs.inputs.length === 0 ? ui("Подключи картинки ко входу «Рефы» — они встанут в панель кадра.") : ui("На входе картинок: {0} → панель кадра", inputs.inputs.length)}
      </Text>
      {inputs !== null && inputs.problems.length > 0 && (
        <Text variant="caption" tone="secondary" className={styles.nodeProblems}>
          {inputs.problems[0]}
        </Text>
      )}

      <VariantResult node={node} kind="video" emptyRu={ui("Видео появится здесь после генерации в промптере")} />

      <Button variant="dark" size="s" icon={<Icon name="options" size={1} />} loading={busy} onClick={() => void open()}>
        {ui("Открыть промптер")}</Button>
      {/* Причины со входов уже видны выше — здесь только то, что не удалось при открытии (не залилась картинка). */}
      {notes
        .filter((note) => !(inputs?.problems.includes(note) ?? false))
        .map((note) => (
          <Text key={note} variant="caption" tone="secondary">
            {note}
          </Text>
        ))}
    </>
  );
}

/** Выход ноды с запусками (генератор, апскейл, Seedance-промптер): выбранный вариант или статус задачи, листалка ‹ n/N ›. */
function VariantResult({ node, kind, emptyRu }: { node: CanvasNode; kind: 'image' | 'video'; emptyRu: string }) {
  const { patchNode } = useCanvas();
  const { jobs, retry } = useGen();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const current = node.jobIds[node.selected];
  const job = current === undefined ? undefined : jobs.find((j) => j.id === current);
  const media = current === undefined ? null : savedMediaOf(jobs, current);
  useEffect(() => setRetryError(null), [current]);
  return (
    <div className={styles.nodeResult}>
      {media !== null ? (
        kind === 'image' ? (
          <img src={mediaUrl(media)} alt={ui("Результат")} />
        ) : (
          <video src={mediaUrl(media)} controls muted loop playsInline />
        )
      ) : (
        <div className={`${styles.nodeDrop} lab-hatch`}>
          <Text variant="caption" tone={job?.status === 'failed' || job?.status === 'download_failed' ? 'accent' : 'tertiary'}>
            {job === undefined ? emptyRu : `${ui(STATUS_RU[job.status])}${isActive(job) ? '…' : ''}`}
          </Text>
          {job?.error !== null && job?.error !== undefined && (
            <Text variant="caption" tone="secondary">
              {job.error.messageRu}
            </Text>
          )}
          {job !== undefined && retryable(job) && (
            <Button
              variant="border"
              size="xs"
              loading={retrying}
              onClick={() => {
                setRetrying(true);
                setRetryError(null);
                void retry(job.id)
                  .catch((error: unknown) => setRetryError(error instanceof Error ? error.message : 'Не удалось повторить проверку.'))
                  .finally(() => setRetrying(false));
              }}
            >
              {job.status === 'download_failed' ? ui("Скачать снова") : ui("Проверить снова")}
            </Button>
          )}
          {retryError !== null && (
            <Text variant="caption" tone="accent">
              {retryError}
            </Text>
          )}
        </div>
      )}
      {!node.stale && media !== null && <SavedResultActions mediaId={media} />}
      {node.jobIds.length > 1 && (
        <div className={styles.iterations}>
          <button type="button" disabled={node.selected === 0} onClick={() => patchNode(node.id, { selected: node.selected - 1 }, `sel:${node.id}`)} aria-label={ui("Предыдущий вариант")}>
            <Icon name="chevron-back" size={0.875} />
          </button>
          <Text variant="caption" tone="secondary">
            {node.selected + 1} / {node.jobIds.length}
          </Text>
          <button type="button" disabled={node.selected >= node.jobIds.length - 1} onClick={() => patchNode(node.id, { selected: node.selected + 1 }, `sel:${node.id}`)} aria-label={ui("Следующий вариант")}>
            <Icon name="chevron-forward" size={0.875} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Вход апскейла (решение 39): сервер мерит его тем же кодом, что при запуске (длинная сторона картинки или секунды видео),
 * нода хранит замер в params с ключом источника. Сменился вход — мерим заново; без замера запуск закрыт.
 */
function UpscaleSource({ node }: { node: CanvasNode }) {
  const { flow, patchNode } = useCanvas();
  const jobs = useGen((s) => s.jobs);
  const [info, setInfo] = useState<MeasuredInput['info']>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(node);
  latest.current = node;
  const mediaOf = (jobId: string): string | null => savedMediaOf(jobs, jobId);
  const source = flow === null ? null : mediaInput(flow, node.id, mediaOf).source;
  const key = source === null ? null : sourceKey(source);
  const modelId = upscaleModelOf(node.kind).id;

  useEffect(() => {
    if (source === null || key === null) {
      setInfo(null);
      return;
    }
    let live = true;
    setError(null);
    measureInput(modelId, source)
      .then((measured) => {
        if (!live) return;
        setInfo(measured.info);
        const current = latest.current;
        const changed = current.params.measuredFor !== key || Object.entries(measured.params).some(([k, v]) => current.params[k] !== v);
        if (changed) patchNode(current.id, { params: { ...current.params, ...measured.params, measuredFor: key } }, false);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'Исходник не измерился.'));
    return () => {
      live = false;
    };
    // source описан ключом: объект пересоздаётся на каждый рендер, ключ — нет.
  }, [key, modelId, patchNode]);

  if (error !== null)
    return (
      <Text variant="caption" tone="accent">
        {error}
      </Text>
    );
  if (info === null || info.width === null || info.height === null) return null;
  const factor = Number(paramsFor(upscaleModelOf(node.kind), node.params).upscaleFactor);
  return (
    <Text variant="caption" tone="secondary">
      {ui("Исходник {0}×{1}{2} → {3}×{4}", info.width, info.height, info.durationSec === null ? '' : ` · ${info.durationSec.toFixed(1)} с`, info.width * factor, info.height * factor)}
    </Text>
  );
}

interface NodeViewProps {
  node: CanvasNode;
  selected: boolean;
  onHeaderDown: (event: ReactPointerEvent, node: CanvasNode) => void;
  onOutputDown: (event: ReactPointerEvent, node: CanvasNode) => void;
  onInputUp: (node: CanvasNode, port: InputPort) => void;
  onKeyboardOutput: () => void;
  onKeyboardInput: (port: InputPort) => void;
  keyboardSource: boolean;
  onPickFromLibrary: (nodeId: string) => void;
  onNeedConsent: (run: () => void) => void;
}

export function NodeView({ node, selected, onHeaderDown, onOutputDown, onInputUp, onKeyboardOutput, onKeyboardInput, keyboardSource, onPickFromLibrary, onNeedConsent }: NodeViewProps) {
  const { flow, patchNode, removeNode, select } = useCanvas();
  const { jobs, run, loadLibrary } = useGen();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ports = portsOf(node);

  const mediaOf = (jobId: string): string | null => savedMediaOf(jobs, jobId);

  const setImage = async (f: File): Promise<void> => {
    const finish = useCanvas.getState().captureResult(node.id);
    try {
      finish({ source: await uploadImage(f), label: f.name });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не загрузилось.');
    }
  };

  const plan = flow === null || (node.type !== 'generator' && node.type !== 'upscale') ? null : planRun(flow, node.id, mediaOf);

  // Запускается только эта нода: ниже по графу ничего само не стартует (у connxn стартовало — и тратило деньги).
  const start = async (consent: boolean): Promise<void> => {
    if (plan === null || plan.estimate === null || plan.problems.length > 0) return;
    setBusy(true);
    setError(null);
    const finish = useCanvas.getState().captureResult(node.id);
    try {
      const created = await run({ modelId: plan.modelId, prompt: plan.prompt, params: plan.params, refs: plan.refs, count: 1, confirmCredits: plan.estimate.credits, refsConsent: plan.refs.length > 0 && consent ? true : undefined });
      finish({ jobIds: [...node.jobIds, ...created.map((j) => j.id)], selected: node.jobIds.length });
      setError(submissionIssue(created));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не запустилось.');
    } finally {
      setBusy(false);
    }
  };
  const onRun = (): void => {
    if (plan !== null && plan.refs.length > 0 && !hasRefsConsent()) onNeedConsent(() => void start(true));
    else void start(plan !== null && plan.refs.length > 0);
  };

  // Кадр из видео и обрезка: локально через ffmpeg, бесплатно — отдельный клик, без гейта стоимости.
  const frameIn = flow === null || (node.type !== 'frame' && node.type !== 'trim') ? null : frameInput(flow, node.id, mediaOf);
  const extract = async (): Promise<void> => {
    if (frameIn?.mediaId === null || frameIn === null) return;
    setBusy(true);
    setError(null);
    const finish = useCanvas.getState().captureResult(node.id);
    try {
      const item = await extractFrame(frameIn.mediaId, node.which);
      finish({ mediaId: item.id });
      void loadLibrary();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Кадр не извлёкся.');
    } finally {
      setBusy(false);
    }
  };

  const model = findModel(node.modelId);

  // Выход платной ноды (генератор, апскейл): выбранный вариант ‹ n/N ›, причины, кнопка с ценой.
  const runOutput = (
    <>
      <VariantResult node={node} kind={node.kind} emptyRu={ui("Результата пока нет")} />

      {plan !== null && plan.problems.length > 0 && (
        <Text variant="caption" tone="secondary" className={styles.nodeProblems}>
          {plan.problems.slice(0, 2).join(' ')}
        </Text>
      )}
      <Button variant="dark" size="s" loading={busy} disabled={plan === null || plan.problems.length > 0 || plan.estimate === null} icon={<Icon name={node.type === 'upscale' ? 'push' : 'sparkle'} size={1} />} onClick={onRun}>
        {node.type === 'upscale' ? ui("Апскейл") : ui("Запустить")}
        {plan?.estimate !== null && plan?.estimate !== undefined ? ` · ${formatCost(plan.estimate)}` : ''}
      </Button>
    </>
  );

  return (
    <div
      data-node-id={node.id}
      className={`${styles.node} ${selected ? styles.nodeSelected : ''}`}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH[node.type] }}
      onPointerDown={(event) => select(node.id, event.shiftKey)}
      onDragOver={(event) => (node.type === 'image' || node.type === 'video') && event.preventDefault()}
      onDrop={(event) => {
        if (node.type !== 'image' && node.type !== 'video') return;
        event.preventDefault();
        event.stopPropagation();
        const f = event.dataTransfer.files[0];
        if (f === undefined) return;
        if (node.type === 'image') void setImage(f);
        else {
          const finish = useCanvas.getState().captureResult(node.id);
          void importMedia(f)
            .then((item) => {
              finish({ mediaId: item.id, label: f.name });
              void loadLibrary();
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Видео не загрузилось.'));
        }
      }}
    >
      <header className={styles.nodeHead} onPointerDown={(event) => onHeaderDown(event, node)}>
        <Icon name={node.type === 'prompt' ? 'pencil' : node.type === 'image' ? 'image' : node.type === 'frame' ? 'layers' : node.type === 'trim' ? 'time' : node.type === 'video' ? 'upload' : node.type === 'resize' ? 'apps' : node.type === 'seedance' ? 'options' : node.type === 'upscale' ? 'push' : node.kind === 'video' ? 'video' : 'sparkles'} size={1} />
        <Text variant="label" medium className={styles.nodeTitle}>
          {nodeTitle(node)}
        </Text>
        <button type="button" className={styles.nodeIcon} title={ui("Удалить ноду")} onPointerDown={(event) => event.stopPropagation()} onClick={() => removeNode(node.id)}>
          <Icon name="close" size={0.875} />
        </button>
      </header>

      {/* Выход — справа на уровне первой строки. */}
      <button type="button" aria-label={ui("Выход: {0}", nodeTitle(node))} aria-pressed={keyboardSource} onKeyDown={(event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onKeyboardOutput(); } }} className={`${styles.port} ${styles.portOut}`} style={{ top: PORT_TOP }} title={ui("Выход — тяни к входу генератора")} onPointerDown={(event) => onOutputDown(event, node)} />

      {ports.length > 0 && (
        <div className={styles.inputs} style={{ height: ports.length * PORT_STEP + 6 }}>
          {ports.map((port, i) => (
            <div key={port} className={styles.inputRow} style={{ top: PORT_TOP - 40 - PORT_STEP / 2 + i * PORT_STEP, height: PORT_STEP }}>
              <button type="button" aria-label={ui("Вход {0}: {1}", PORT_RU[port], nodeTitle(node))} onKeyDown={(event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onKeyboardInput(port); } }} className={`${styles.port} ${styles.portIn}`} onPointerUp={() => onInputUp(node, port)} title={ui("Вход «{0}»", PORT_RU[port])} />
              <Text variant="caption" tone="secondary">
                {node.type === 'seedance' && port === 'ref' ? ui("Рефы") : ui(PORT_RU[port])}
              </Text>
            </div>
          ))}
        </div>
      )}

      <div className={styles.nodeBody} onPointerDown={(event) => event.stopPropagation()}>
        {node.stale && (node.mediaId !== null || node.jobIds.length > 0) && <div role="status"><Text variant="caption" tone="accent">{ui("Вход изменился. Прежний результат устарел; выполни этот шаг заново.")}</Text></div>}
        {node.type === 'prompt' && <textarea className={styles.nodeText} rows={5} value={node.text} placeholder={ui("Текст промпта. Соедини выход со входом «Промпт» генератора.")} onChange={(event) => patchNode(node.id, { text: event.target.value }, `text:${node.id}`)} />}

        {node.type === 'image' && (
          <>
            {node.source !== null ? (
              <img className={styles.nodeImage} src={thumbOf(node.source)} alt={node.label} />
            ) : (
              <div className={`${styles.nodeDrop} lab-hatch`}>
                <Text variant="caption" tone="tertiary">
                  {ui("Перетащи картинку сюда")}</Text>
              </div>
            )}
            {node.source?.type === 'media' && <SavedResultActions mediaId={node.source.mediaId} />}
            <div className={styles.nodeRow}>
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => event.target.files?.[0] !== undefined && void setImage(event.target.files[0])} />
              <Button variant="border" size="xs" icon={<Icon name="upload" size={0.875} />} onClick={() => file.current?.click()}>
                {ui("С диска")}</Button>
              <Button variant="border" size="xs" icon={<Icon name="images" size={0.875} />} onClick={() => onPickFromLibrary(node.id)}>
                {ui("Из библиотеки")}</Button>
            </div>
          </>
        )}

        {node.type === 'frame' && (
          <>
            <SegmentedControl<'first' | 'last'>
              aria-label={ui("Какой кадр")}
              size="s"
              value={node.which}
              onChange={(which) => patchNode(node.id, { which, mediaId: null })}
              options={[
                { value: 'first', label: ui("Первый") },
                { value: 'last', label: ui("Последний") },
              ]}
            />
            {node.mediaId !== null ? (
              <img className={styles.nodeImage} src={mediaUrl(node.mediaId)} alt={nodeTitle(node)} />
            ) : (
              <div className={`${styles.nodeDrop} lab-hatch`}>
                <Text variant="caption" tone="tertiary">
                  {frameIn?.problemRu ?? ui("Кадр ещё не извлечён")}
                </Text>
              </div>
            )}
            {!node.stale && node.mediaId !== null && <SavedResultActions mediaId={node.mediaId} />}
            <Button variant="border" size="s" icon={<Icon name="layers" size={0.875} />} loading={busy} disabled={frameIn?.mediaId === null || frameIn === null} onClick={() => void extract()}>
              {node.mediaId === null ? ui("Извлечь кадр · бесплатно") : ui("Извлечь заново")}
            </Button>
            <Text variant="caption" tone="tertiary">
              {ui("Выход тяни во вход «Старт» следующего видео — клипы склеятся в сцену.")}</Text>
          </>
        )}

        {node.type === 'video' && <VideoBody node={node} onPick={() => onPickFromLibrary(node.id)} />}

        {node.type === 'resize' && <ResizeBody node={node} />}

        {node.type === 'trim' && <TrimBody node={node} sourceId={frameIn?.mediaId ?? null} problemRu={frameIn?.problemRu ?? null} />}

        {node.type === 'seedance' && <SeedanceBody node={node} />}

        {node.type === 'generator' && (
          <>
            <select
              className={styles.nodeSelect}
              value={node.modelId}
              aria-label={ui("Модель")}
              onChange={(event) => {
                const m = findModel(event.target.value);
                if (m !== undefined) patchNode(node.id, { modelId: m.id, params: paramsFor(m, node.params) });
              }}
            >
              {modelsOf(node.kind).map((m) => (
                <option key={m.id} value={m.id}>
                  {ui(m.titleRu)}
                </option>
              ))}
            </select>
            {model !== undefined && (
              <div className={styles.nodeParams}>
                {model.params.map((def) => (
                  <ParamField key={def.key} def={def} compact provider={model.provider} value={paramsFor(model, node.params)[def.key]} onChange={(v) => patchNode(node.id, { params: { ...paramsFor(model, node.params), [def.key]: v } }, `params:${node.id}`)} />
                ))}
              </div>
            )}
            <textarea className={styles.nodeText} rows={2} value={node.text} placeholder={ui("Доп. текст — допишется после входящих промптов")} onChange={(event) => patchNode(node.id, { text: event.target.value }, `text:${node.id}`)} />
            {runOutput}
          </>
        )}

        {node.type === 'upscale' && (
          <>
            <SegmentedControl<string>
              aria-label={ui("Увеличение")}
              size="s"
              value={String(paramsFor(upscaleModelOf(node.kind), node.params).upscaleFactor)}
              onChange={(upscaleFactor) => patchNode(node.id, { params: { ...node.params, upscaleFactor } }, `params:${node.id}`)}
              options={[
                { value: '1', label: '1×', title: ui("Только чистка: размер тот же") },
                { value: '2', label: '2×' },
                { value: '4', label: '4×' },
              ]}
            />
            <UpscaleSource node={node} />
            {runOutput}
            <Text variant="caption" tone="tertiary">
              {ui("Topaz не перерисовывает: тот же ")}{node.kind === 'video' ? ui("дубль") : ui("кадр")}{ui(", больше пикселей. Выход — ")}{node.kind === 'video' ? ui("видео") : ui("картинка")}{ui(": тяни в «Размер» или дальше.")}</Text>
          </>
        )}
        {error !== null && (
          <Text variant="caption" tone="accent">
            {error}
          </Text>
        )}
      </div>
    </div>
  );
}
