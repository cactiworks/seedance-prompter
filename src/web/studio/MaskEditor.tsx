import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { fixParams } from '../../core/gen/fixes.ts';
import { estimate, findModel, formatCost } from '../../core/gen/models.ts';
import { maskToBoxes, MAX_REGIONS, regionProblems, type Box } from '../../core/gen/regionEdit.ts';
import type { MediaItem } from '../../core/model/media.ts';
import { hasRefsConsent, mediaUrl, useGen } from '../gen/genStore.ts';
import { Button, Icon, SegmentedControl, Text } from '../ui/components/index.ts';
import styles from './MediaPreview.module.css';

/** Модель точечной правки — выбор владельца 28.09: всё выделенное кистью уходит в Seedream 5 Pro. */
export const REGION_MODEL_ID = 'kie/seedream-5-pro';

type Tool = 'brush' | 'erase';

interface Stroke {
  tool: Tool;
  /** Толщина в долях ширины картинки — мазок не зависит от размера окна. */
  size: number;
  /** Точки в долях ширины / высоты картинки (0…1). */
  points: { x: number; y: number }[];
}

const SIZES = { min: 0.01, max: 0.2, step: 0.005, initial: 0.05 };
/** Сетка маски по длинной стороне: 160 клеток — рамка точнее процента, а подсчёт мгновенный. */
const GRID = 160;

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[], width: number, height: number, color: string): void {
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    ctx.globalCompositeOperation = stroke.tool === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = stroke.size * width;
    const [first, ...rest] = stroke.points;
    if (first === undefined) continue;
    if (rest.length === 0) {
      ctx.beginPath();
      ctx.arc(first.x * width, first.y * height, (stroke.size * width) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(first.x * width, first.y * height);
    for (const p of rest) ctx.lineTo(p.x * width, p.y * height);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** Мазки → рамки выделения: растеризация в маленькую сетку пропорций картинки и связные пятна. */
function boxesOf(strokes: readonly Stroke[], aspect: number): Box[] {
  if (strokes.length === 0) return [];
  const width = aspect >= 1 ? GRID : Math.max(8, Math.round(GRID * aspect));
  const height = aspect >= 1 ? Math.max(8, Math.round(GRID / aspect)) : GRID;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return [];
  drawStrokes(ctx, strokes, width, height, '#000');
  const data = ctx.getImageData(0, 0, width, height).data;
  const cells = new Uint8Array(width * height);
  for (let i = 0; i < cells.length; i += 1) cells[i] = (data[i * 4 + 3] ?? 0) > 96 ? 1 : 0;
  return maskToBoxes({ width, height, cells });
}

/**
 * Правка кистью по образцу Edit у Higgsfield: закрась, что изменить, ниже напиши, что сделать. Модель получает
 * рамки закрашенного (формат интерактивной правки Seedream) — их видно пунктиром, чтобы не было сюрпризов.
 */
export function MaskEditor({ item, onExit }: { item: MediaItem; onExit: () => void }) {
  const run = useGen((s) => s.run);
  const loadLibrary = useGen((s) => s.loadLibrary);
  const [tool, setTool] = useState<Tool>('brush');
  const [size, setSize] = useState(SIZES.initial);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redo, setRedo] = useState<Stroke[]>([]);
  /** Мазок в процессе — в ref, не в состоянии: события мыши идут чаще перерисовки, иначе точки теряются. */
  const live = useRef<Stroke | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const [instruction, setInstruction] = useState('');
  const [resolution, setResolution] = useState('2K');
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<{ phase: 'idle' | 'translating' | 'sending'; messageRu: string | null }>({ phase: 'idle', messageRu: null });
  const img = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const model = findModel(REGION_MODEL_ID);
  const params = model === undefined ? {} : fixParams(model, item.params, { resolution });
  const cost = model === undefined ? null : estimate(model, params, 1, 1);
  const aspect = frame === null ? 1 : frame.width / frame.height;
  const boxes = useMemo(() => boxesOf(strokes, aspect), [strokes, aspect]);
  const problems = regionProblems(boxes, instruction);
  const needConsent = !hasRefsConsent() && !consent;
  const busy = state.phase !== 'idle';

  // Размер кадра на экране: канвас совпадает с картинкой пиксель в пиксель, с учётом плотности экрана.
  const measure = useCallback(() => {
    const el = img.current;
    if (el !== null && el.clientWidth > 0) setFrame({ width: el.clientWidth, height: el.clientHeight });
  }, []);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const redraw = useCallback(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (el == null || ctx == null) return;
    // Цвет маски — токен акцента: канвас не читает var(), берём вычисленное значение.
    const color = getComputedStyle(el).getPropertyValue('--lab-accent').trim() || getComputedStyle(el).color;
    drawStrokes(ctx, live.current === null ? strokes : [...strokes, live.current], el.width, el.height, color);
  }, [strokes]);

  useEffect(() => {
    const el = canvas.current;
    if (el == null || frame === null) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(frame.width * dpr);
    el.height = Math.round(frame.height * dpr);
    redraw();
  }, [frame, redraw]);

  const pointOf = (event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  };

  const undo = useCallback(() => {
    setStrokes((list) => {
      const last = list.at(-1);
      if (last !== undefined) setRedo((r) => [...r, last]);
      return list.slice(0, -1);
    });
  }, []);
  const redoLast = useCallback(() => {
    setRedo((list) => {
      const last = list.at(-1);
      if (last !== undefined) setStrokes((s) => [...s, last]);
      return list.slice(0, -1);
    });
  }, []);

  // Горячие клавиши — в фазе перехвата: Esc выходит из кисти, а не закрывает просмотр; стрелки не листают.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement | null)?.tagName ?? '');
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        onExit();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (!typing) event.stopImmediatePropagation();
        return;
      }
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoLast();
        else undo();
      } else if (event.key === 'b' || event.key === 'и') setTool('brush');
      else if (event.key === 'e' || event.key === 'у') setTool('erase');
      else if (event.key === '[' || event.key === 'х') setSize((s) => Math.max(SIZES.min, s - SIZES.step * 2));
      else if (event.key === ']' || event.key === 'ъ') setSize((s) => Math.min(SIZES.max, s + SIZES.step * 2));
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onExit, undo, redoLast]);

  const submit = async (): Promise<void> => {
    if (model === undefined || cost === null || problems.length > 0 || needConsent || busy) return;
    setState({ phase: 'translating', messageRu: null });
    try {
      const res = await fetch('/api/llm/region-edit', { method: 'POST', headers: { 'x-sp-client': '1', 'content-type': 'application/json' }, body: JSON.stringify({ instructionRu: instruction, boxes }) });
      const data = (await res.json().catch(() => ({}))) as { prompt?: string; messageRu?: string };
      if (!res.ok || data.prompt === undefined) throw new Error(data.messageRu ?? `HTTP ${res.status}`);
      setState({ phase: 'sending', messageRu: null });
      const created = await run({
        modelId: model.id,
        prompt: data.prompt,
        params,
        refs: [{ label: 'Правка кистью', source: { type: 'media', mediaId: item.id }, role: 'ref' }],
        count: 1,
        confirmCredits: cost.credits,
        refsConsent: true,
        sessionId: item.sessionId ?? undefined,
      });
      const failed = created.find((j) => j.status === 'failed');
      setState({ phase: 'idle', messageRu: failed?.error?.messageRu ?? 'Правка запущена — новая версия появится в ленте версий слева, файл сразу на диске.' });
      void loadLibrary();
    } catch (error) {
      setState({ phase: 'idle', messageRu: error instanceof Error ? error.message : 'Правка не запустилась.' });
    }
  };

  const brushPx = frame === null ? 0 : size * frame.width;

  return (
    <div className={styles.maskStage}>
      <div className={styles.maskTools} role="toolbar" aria-label="Кисть">
        <button type="button" className={`${styles.maskTool} ${tool === 'brush' ? styles.maskToolOn : ''}`} onClick={() => setTool('brush')} title="Кисть (B)" aria-pressed={tool === 'brush'}>
          <Icon name="brush" size={1} />
          Кисть
        </button>
        <button type="button" className={`${styles.maskTool} ${tool === 'erase' ? styles.maskToolOn : ''}`} onClick={() => setTool('erase')} title="Ластик (E)" aria-pressed={tool === 'erase'}>
          <Icon name="close-circle" size={1} />
          Ластик
        </button>
        <span className={styles.maskDivider} />
        <label className={styles.maskSize} title="Размер кисти ( [ и ] )">
          <span className={styles.maskSizeDot} style={{ width: `${Math.max(4, Math.min(22, brushPx / 3))}px`, height: `${Math.max(4, Math.min(22, brushPx / 3))}px` }} />
          <input type="range" min={SIZES.min} max={SIZES.max} step={SIZES.step} value={size} onChange={(event) => setSize(Number(event.target.value))} aria-label="Размер кисти" />
        </label>
        <span className={styles.maskDivider} />
        <button type="button" className={styles.maskTool} onClick={undo} disabled={strokes.length === 0} title="Отменить (⌘Z)" aria-label="Отменить">
          <Icon name="arrow-undo" size={1} />
        </button>
        <button type="button" className={styles.maskTool} onClick={redoLast} disabled={redo.length === 0} title="Вернуть (⇧⌘Z)" aria-label="Вернуть">
          <Icon name="arrow-redo" size={1} />
        </button>
        <button
          type="button"
          className={styles.maskTool}
          onClick={() => {
            setRedo([]);
            setStrokes([]);
          }}
          disabled={strokes.length === 0}
          title="Стереть всё"
        >
          <Icon name="bin" size={1} />
          Очистить
        </button>
        <span className={styles.maskDivider} />
        <button type="button" className={styles.maskTool} onClick={onExit} title="Выйти из кисти (Esc)">
          <Icon name="close" size={1} />
        </button>
      </div>

      <div className={styles.maskFrame}>
        <img ref={img} className={styles.maskImage} src={mediaUrl(item.id)} alt={item.prompt.slice(0, 80)} onLoad={measure} draggable={false} />
        <canvas
          ref={canvas}
          className={styles.maskCanvas}
          style={{ cursor: 'none' }}
          onPointerDown={(event) => {
            if (busy) return;
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* без захвата мазок оборвётся на краю картинки — не страшно */
            }
            live.current = { tool, size, points: [pointOf(event)] };
            setRedo([]);
            redraw();
          }}
          onPointerMove={(event) => {
            const p = pointOf(event);
            setCursor(p);
            if (live.current !== null) {
              live.current.points.push(p);
              redraw();
            }
          }}
          onPointerUp={() => {
            const done = live.current;
            live.current = null;
            if (done !== null) setStrokes((s) => [...s, done]);
            input.current?.focus();
          }}
          onPointerLeave={() => setCursor(null)}
        />
        {boxes.map((box) => (
          <span key={`${box.x1}-${box.y1}-${box.x2}-${box.y2}`} className={styles.maskBox} style={{ left: `${box.x1 / 10}%`, top: `${box.y1 / 10}%`, width: `${(box.x2 - box.x1) / 10}%`, height: `${(box.y2 - box.y1) / 10}%` }} />
        ))}
        {cursor !== null && frame !== null && (
          <span className={`${styles.maskCursor} ${tool === 'erase' ? styles.maskCursorErase : ''}`} style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%`, width: `${brushPx}px`, height: `${brushPx}px` }} />
        )}
      </div>

      <div className={styles.maskBar}>
        <input
          ref={input}
          className={styles.maskInput}
          value={instruction}
          lang="ru"
          spellCheck
          placeholder={boxes.length === 0 ? 'Сначала закрась кистью, что изменить' : 'Что сделать с выделенным: «убери», «замени на стакан сока», «куртка тёмно-зелёная»'}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit();
          }}
        />
        <SegmentedControl<string> aria-label="Разрешение" size="s" value={resolution} onChange={setResolution} options={(model?.params.find((p) => p.key === 'resolution')?.options ?? []).map((o) => ({ value: o, label: o }))} />
        <Button variant="primary" size="m" icon={<Icon name="sparkle" size={1} />} loading={busy} disabled={problems.length > 0 || needConsent || cost === null} onClick={() => void submit()}>
          {state.phase === 'translating' ? 'Перевожу…' : state.phase === 'sending' ? 'Отправляю…' : `Изменить${cost === null ? '' : ` · ${formatCost(cost)}`}`}
        </Button>
      </div>
      <div className={styles.maskNote}>
        {needConsent ? (
          <label className={styles.consent}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <Text variant="caption">Картинка уйдёт в KIE, а оттуда исполнителю Seedream. Если на ней лицо — оно тоже уйдёт.</Text>
          </label>
        ) : (
          <Text variant="caption" tone="secondary">
            {state.messageRu ??
              (boxes.length === 0
                ? 'Seedream 5 Pro · закрась, что изменить; пунктир — область, которую получит модель'
                : `Seedream 5 Pro · выделено мест: ${boxes.length}${boxes.length > MAX_REGIONS ? ` — больше ${MAX_REGIONS}, объедини` : ''} · Enter — изменить`)}
          </Text>
        )}
      </div>
    </div>
  );
}
