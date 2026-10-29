import { ui } from '../language.ts';
import { studioFetch as fetch } from '../remoteFetch.ts';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { MediaItem } from '../../core/model/media.ts';
import { mediaUrl, useGen } from '../gen/genStore.ts';
import { Button, Icon, Text } from '../ui/components/index.ts';
import styles from './MediaPreview.module.css';

/** Рамка обрезки в долях картинки (0…1) от левого верхнего угла. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

const ASPECTS: { id: string; labelRu: string; ratio: number | null }[] = [
  { id: 'free', labelRu: 'Свободно', ratio: null },
  { id: '1:1', labelRu: '1:1', ratio: 1 },
  { id: '4:5', labelRu: '4:5', ratio: 4 / 5 },
  { id: '3:4', labelRu: '3:4', ratio: 3 / 4 },
  { id: '9:16', labelRu: '9:16', ratio: 9 / 16 },
  { id: '16:9', labelRu: '16:9', ratio: 16 / 9 },
];

const MIN = 0.05;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Самая большая рамка нужного формата по центру; `k` — отношение сторон картинки (ширина / высота). */
function fit(ratio: number | null, k: number): Rect {
  if (ratio === null) return { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
  const w = ratio / k <= 1 ? ratio / k : 1;
  const h = ratio / k <= 1 ? 1 : k / ratio;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/**
 * Обрезка рамкой (решение 34): углы тянут, середина двигает, формат — кнопками. Делается на этом компьютере через
 * ffmpeg, бесплатно; результат — новая версия.
 */
export function CropEditor({ item, onExit }: { item: MediaItem; onExit: () => void }) {
  const loadLibrary = useGen((s) => s.loadLibrary);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [aspect, setAspect] = useState('free');
  const [rect, setRect] = useState<Rect>(fit(null, 1));
  const [state, setState] = useState<{ busy: boolean; messageRu: string | null }>({ busy: false, messageRu: null });
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; start: { x: number; y: number }; rect: Rect } | null>(null);

  const k = natural === null ? 1 : natural.width / natural.height;
  const ratio = ASPECTS.find((a) => a.id === aspect)?.ratio ?? null;

  const pointOf = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = frame.current?.getBoundingClientRect();
    if (box === undefined) return { x: 0, y: 0 };
    return { x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height };
  };

  // Перетаскивание слушает окно: палец или мышь могут уйти за рамку и за картинку.
  const onMove = useCallback(
    (event: PointerEvent) => {
      const d = drag.current;
      if (d === null) return;
      const p = pointOf(event.clientX, event.clientY);
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      const r = d.rect;
      if (d.handle === 'move') {
        setRect({ ...r, x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h) });
        return;
      }
      // Угол тянется, противоположный стоит на месте.
      const left = d.handle === 'nw' || d.handle === 'sw';
      const top = d.handle === 'nw' || d.handle === 'ne';
      const anchorX = left ? r.x + r.w : r.x;
      const anchorY = top ? r.y + r.h : r.y;
      let w = clamp(left ? anchorX - (r.x + dx) : r.x + r.w + dx - anchorX, MIN, left ? anchorX : 1 - anchorX);
      let h = clamp(top ? anchorY - (r.y + dy) : r.y + r.h + dy - anchorY, MIN, top ? anchorY : 1 - anchorY);
      if (ratio !== null) {
        // Доля высоты при той же пиксельной пропорции: h = w · k / ratio; не влезла — ужимаем ширину.
        h = (w * k) / ratio;
        const room = top ? anchorY : 1 - anchorY;
        if (h > room) {
          h = room;
          w = (h * ratio) / k;
        }
      }
      setRect({ x: left ? anchorX - w : anchorX, y: top ? anchorY - h : anchorY, w, h });
    },
    [k, ratio],
  );
  const onUp = useCallback(() => {
    drag.current = null;
  }, []);
  useEffect(() => {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onMove, onUp]);

  // Esc — выйти из обрезки, а не закрыть просмотр; стрелки не листают.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        onExit();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onExit]);

  const grab =
    (handle: Handle) =>
    (event: ReactPointerEvent): void => {
      event.stopPropagation();
      event.preventDefault();
      drag.current = { handle, start: pointOf(event.clientX, event.clientY), rect };
    };

  const pickAspect = (id: string): void => {
    setAspect(id);
    setRect(fit(ASPECTS.find((a) => a.id === id)?.ratio ?? null, k));
  };

  // Как ffmpeg: trunc(iw·w) — подпись совпадает с файлом пиксель в пиксель.
  const pixels = natural === null ? null : { w: Math.floor(rect.w * natural.width), h: Math.floor(rect.h * natural.height) };

  const crop = async (): Promise<void> => {
    setState({ busy: true, messageRu: null });
    try {
      const res = await fetch(`/api/library/${item.id}/crop`, { method: 'POST', headers: { 'x-sp-client': '1', 'content-type': 'application/json' }, body: JSON.stringify({ ...rect, labelRu: aspect === 'free' ? '' : aspect }) });
      const data = (await res.json().catch(() => ({}))) as { messageRu?: string };
      if (!res.ok) throw new Error(data.messageRu ?? `HTTP ${res.status}`);
      await loadLibrary();
      setState({ busy: false, messageRu: 'Готово — обрезанная версия в ленте версий слева.' });
    } catch (error) {
      setState({ busy: false, messageRu: error instanceof Error ? error.message : 'Обрезка не удалась.' });
    }
  };

  return (
    <div className={styles.maskStage}>
      <div className={styles.maskTools} role="toolbar" aria-label={ui("Обрезка")}>
        {ASPECTS.map((a) => (
          <button key={a.id} type="button" className={`${styles.maskTool} ${aspect === a.id ? styles.maskToolOn : ''}`} onClick={() => pickAspect(a.id)} aria-pressed={aspect === a.id}>
            {a.labelRu}
          </button>
        ))}
        <span className={styles.maskDivider} />
        <button type="button" className={styles.maskTool} onClick={onExit} title={ui("Выйти из обрезки (Esc)")} aria-label={ui("Выйти из обрезки")}>
          <Icon name="close" size={1} />
        </button>
      </div>

      <div ref={frame} className={styles.maskFrame}>
        <img
          className={styles.maskImage}
          src={mediaUrl(item.id)}
          alt={item.prompt.slice(0, 80)}
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            setNatural({ width: img.naturalWidth, height: img.naturalHeight });
          }}
        />
        <div className={styles.cropRect} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} onPointerDown={grab('move')}>
          {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
            <span key={h} className={`${styles.cropHandle} ${styles[`crop_${h}`]}`} onPointerDown={grab(h)} />
          ))}
        </div>
      </div>

      <div className={styles.maskBar}>
        <Text variant="label" tone="secondary">
          {pixels === null ? '…' : `${pixels.w} × ${pixels.h} px`}
        </Text>
        <span />
        <Button variant="primary" size="m" icon={<Icon name="checkmark" size={1} />} loading={state.busy} onClick={() => void crop()}>
          {ui("Обрезать · бесплатно")}</Button>
      </div>
      <div className={styles.maskNote}>
        <Text variant="caption" tone="secondary">
          {state.messageRu ?? ui("Углы — размер, середина — сдвиг. Делается на этом компьютере, в провайдер ничего не уходит.")}
        </Text>
      </div>
    </div>
  );
}
