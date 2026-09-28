import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { frameInput, planRun, nodeTitle } from '../../core/canvas/plan.ts';
import { findModel, formatCost, modelsOf, paramsFor } from '../../core/gen/models.ts';
import { inputsOf, type CanvasNode, type InputPort } from '../../core/model/canvas.ts';
import { extractFrame, hasRefsConsent, isActive, mediaUrl, thumbOf, uploadImage, useGen } from '../gen/genStore.ts';
import { ParamField } from '../studio/Controls.tsx';
import { STATUS_RU } from '../studio/JobTile.tsx';
import { Button, Icon, SegmentedControl, Text } from '../ui/components/index.ts';
import styles from './Canvas.module.css';
import { NODE_WIDTH, PORT_STEP, PORT_TOP, useCanvas } from './canvasStore.ts';

export const PORT_RU: Record<InputPort, string> = { prompt: 'Промпт', ref: 'Реф', start: 'Старт', end: 'Финал', video: 'Видео' };

/** Входы ноды с учётом ролей выбранной модели. */
export function portsOf(node: CanvasNode): InputPort[] {
  return inputsOf(node, findModel(node.modelId)?.refs.roles ?? []);
}

interface NodeViewProps {
  node: CanvasNode;
  selected: boolean;
  onHeaderDown: (event: ReactPointerEvent, node: CanvasNode) => void;
  onOutputDown: (event: ReactPointerEvent, node: CanvasNode) => void;
  onInputUp: (node: CanvasNode, port: InputPort) => void;
  onPickFromLibrary: (nodeId: string) => void;
  onNeedConsent: (run: () => void) => void;
}

export function NodeView({ node, selected, onHeaderDown, onOutputDown, onInputUp, onPickFromLibrary, onNeedConsent }: NodeViewProps) {
  const { flow, patchNode, removeNode, select } = useCanvas();
  const { jobs, run, loadLibrary } = useGen();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ports = portsOf(node);

  const mediaOf = (jobId: string): string | null => {
    const job = jobs.find((j) => j.id === jobId);
    return job?.status === 'saved' ? (job.mediaIds.find((id): id is string => id !== null) ?? null) : null;
  };

  const setImage = async (f: File): Promise<void> => {
    try {
      patchNode(node.id, { source: await uploadImage(f), label: f.name });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не загрузилось.');
    }
  };

  const plan = flow === null || node.type !== 'generator' ? null : planRun(flow, node.id, mediaOf);
  const current = node.jobIds[node.selected];
  const job = current === undefined ? undefined : jobs.find((j) => j.id === current);
  const resultMedia = current === undefined ? null : mediaOf(current);

  // Запускается только эта нода: ниже по графу ничего само не стартует (у connxn стартовало — и тратило деньги).
  const start = async (consent: boolean): Promise<void> => {
    if (plan === null || plan.estimate === null || plan.problems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await run({ modelId: plan.modelId, prompt: plan.prompt, params: plan.params, refs: plan.refs, count: 1, confirmCredits: plan.estimate.credits, refsConsent: plan.refs.length > 0 && consent ? true : undefined });
      patchNode(node.id, { jobIds: [...node.jobIds, ...created.map((j) => j.id)], selected: node.jobIds.length });
      const failed = created.find((j) => j.status === 'failed');
      if (failed !== undefined) setError(failed.error?.messageRu ?? 'Не запустилось.');
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

  // Кадр из видео: локально через ffmpeg, бесплатно — отдельный клик, без гейта стоимости.
  const frameIn = flow === null || node.type !== 'frame' ? null : frameInput(flow, node.id, mediaOf);
  const extract = async (): Promise<void> => {
    if (frameIn?.mediaId === null || frameIn === null) return;
    setBusy(true);
    setError(null);
    try {
      const item = await extractFrame(frameIn.mediaId, node.which);
      patchNode(node.id, { mediaId: item.id });
      void loadLibrary();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Кадр не извлёкся.');
    } finally {
      setBusy(false);
    }
  };

  const model = findModel(node.modelId);

  return (
    <div
      className={`${styles.node} ${selected ? styles.nodeSelected : ''}`}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH[node.type] }}
      onPointerDown={() => select(node.id)}
      onDragOver={(event) => node.type === 'image' && event.preventDefault()}
      onDrop={(event) => {
        if (node.type !== 'image') return;
        event.preventDefault();
        event.stopPropagation();
        const f = event.dataTransfer.files[0];
        if (f !== undefined) void setImage(f);
      }}
    >
      <header className={styles.nodeHead} onPointerDown={(event) => onHeaderDown(event, node)}>
        <Icon name={node.type === 'prompt' ? 'pencil' : node.type === 'image' ? 'image' : node.type === 'frame' ? 'layers' : node.kind === 'video' ? 'video' : 'sparkles'} size={1} />
        <Text variant="label" medium className={styles.nodeTitle}>
          {nodeTitle(node)}
        </Text>
        <button type="button" className={styles.nodeIcon} title="Удалить ноду" onPointerDown={(event) => event.stopPropagation()} onClick={() => removeNode(node.id)}>
          <Icon name="close" size={0.875} />
        </button>
      </header>

      {/* Выход — справа на уровне первой строки. */}
      <span className={`${styles.port} ${styles.portOut}`} style={{ top: PORT_TOP }} title="Выход — тяни к входу генератора" onPointerDown={(event) => onOutputDown(event, node)} />

      {ports.length > 0 && (
        <div className={styles.inputs} style={{ height: ports.length * PORT_STEP + 6 }}>
          {ports.map((port, i) => (
            <div key={port} className={styles.inputRow} style={{ top: PORT_TOP - 40 - PORT_STEP / 2 + i * PORT_STEP, height: PORT_STEP }}>
              <span className={`${styles.port} ${styles.portIn}`} onPointerUp={() => onInputUp(node, port)} title={`Вход «${PORT_RU[port]}»`} />
              <Text variant="caption" tone="secondary">
                {PORT_RU[port]}
              </Text>
            </div>
          ))}
        </div>
      )}

      <div className={styles.nodeBody} onPointerDown={(event) => event.stopPropagation()}>
        {node.type === 'prompt' && <textarea className={styles.nodeText} rows={5} value={node.text} placeholder="Текст промпта. Соедини выход со входом «Промпт» генератора." onChange={(event) => patchNode(node.id, { text: event.target.value }, `text:${node.id}`)} />}

        {node.type === 'image' && (
          <>
            {node.source !== null ? (
              <img className={styles.nodeImage} src={thumbOf(node.source)} alt={node.label} />
            ) : (
              <div className={`${styles.nodeDrop} lab-hatch`}>
                <Text variant="caption" tone="tertiary">
                  Перетащи картинку сюда
                </Text>
              </div>
            )}
            <div className={styles.nodeRow}>
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => event.target.files?.[0] !== undefined && void setImage(event.target.files[0])} />
              <Button variant="border" size="xs" icon={<Icon name="upload" size={0.875} />} onClick={() => file.current?.click()}>
                С диска
              </Button>
              <Button variant="border" size="xs" icon={<Icon name="images" size={0.875} />} onClick={() => onPickFromLibrary(node.id)}>
                Из библиотеки
              </Button>
            </div>
          </>
        )}

        {node.type === 'frame' && (
          <>
            <SegmentedControl<'first' | 'last'>
              aria-label="Какой кадр"
              size="s"
              value={node.which}
              onChange={(which) => patchNode(node.id, { which, mediaId: null })}
              options={[
                { value: 'first', label: 'Первый' },
                { value: 'last', label: 'Последний' },
              ]}
            />
            {node.mediaId !== null ? (
              <img className={styles.nodeImage} src={mediaUrl(node.mediaId)} alt={nodeTitle(node)} />
            ) : (
              <div className={`${styles.nodeDrop} lab-hatch`}>
                <Text variant="caption" tone="tertiary">
                  {frameIn?.problemRu ?? 'Кадр ещё не извлечён'}
                </Text>
              </div>
            )}
            <Button variant="border" size="s" icon={<Icon name="layers" size={0.875} />} loading={busy} disabled={frameIn?.mediaId === null || frameIn === null} onClick={() => void extract()}>
              {node.mediaId === null ? 'Извлечь кадр · бесплатно' : 'Извлечь заново'}
            </Button>
            <Text variant="caption" tone="tertiary">
              Выход тяни во вход «Старт» следующего видео — клипы склеятся в сцену.
            </Text>
          </>
        )}

        {node.type === 'generator' && (
          <>
            <select
              className={styles.nodeSelect}
              value={node.modelId}
              aria-label="Модель"
              onChange={(event) => {
                const m = findModel(event.target.value);
                if (m !== undefined) patchNode(node.id, { modelId: m.id, params: paramsFor(m, node.params) });
              }}
            >
              {modelsOf(node.kind).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.titleRu}
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
            <textarea className={styles.nodeText} rows={2} value={node.text} placeholder="Доп. текст — допишется после входящих промптов" onChange={(event) => patchNode(node.id, { text: event.target.value }, `text:${node.id}`)} />

            <div className={styles.nodeResult}>
              {resultMedia !== null ? (
                node.kind === 'image' ? (
                  <img src={mediaUrl(resultMedia)} alt="Результат" />
                ) : (
                  <video src={mediaUrl(resultMedia)} controls muted loop playsInline />
                )
              ) : (
                <div className={`${styles.nodeDrop} lab-hatch`}>
                  <Text variant="caption" tone={job?.status === 'failed' || job?.status === 'download_failed' ? 'accent' : 'tertiary'}>
                    {job === undefined ? 'Результата пока нет' : `${STATUS_RU[job.status]}${isActive(job) ? '…' : ''}`}
                  </Text>
                  {job?.error !== null && job?.error !== undefined && (
                    <Text variant="caption" tone="secondary">
                      {job.error.messageRu}
                    </Text>
                  )}
                </div>
              )}
              {node.jobIds.length > 1 && (
                <div className={styles.iterations}>
                  <button type="button" disabled={node.selected === 0} onClick={() => patchNode(node.id, { selected: node.selected - 1 }, `sel:${node.id}`)} aria-label="Предыдущий вариант">
                    <Icon name="chevron-back" size={0.875} />
                  </button>
                  <Text variant="caption" tone="secondary">
                    {node.selected + 1} / {node.jobIds.length}
                  </Text>
                  <button type="button" disabled={node.selected >= node.jobIds.length - 1} onClick={() => patchNode(node.id, { selected: node.selected + 1 }, `sel:${node.id}`)} aria-label="Следующий вариант">
                    <Icon name="chevron-forward" size={0.875} />
                  </button>
                </div>
              )}
            </div>

            {plan !== null && plan.problems.length > 0 && (
              <Text variant="caption" tone="secondary" className={styles.nodeProblems}>
                {plan.problems.slice(0, 2).join(' ')}
              </Text>
            )}
            <Button variant="dark" size="s" loading={busy} disabled={plan === null || plan.problems.length > 0 || plan.estimate === null} icon={<Icon name="sparkle" size={1} />} onClick={onRun}>
              Запустить{plan?.estimate !== null && plan?.estimate !== undefined ? ` · ${formatCost(plan.estimate)}` : ''}
            </Button>
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
