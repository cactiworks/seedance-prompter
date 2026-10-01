import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { z } from 'zod';
import { flowCost } from '../../core/canvas/plan.ts';
import { CanvasEdgeSchema, CanvasNodeSchema, portAccepts, outputOf, type CanvasNode, type InputPort } from '../../core/model/canvas.ts';
import { importMedia, uploadImage, mediaUrl, useGen } from '../gen/genStore.ts';
import { Button, Dialog, Icon, Text } from '../ui/components/index.ts';
import styles from './Canvas.module.css';
import { FLOW_TEMPLATES } from '../../core/canvas/templates.ts';
import { newId, NODE_WIDTH, PORT_STEP, PORT_TOP, useCanvas } from './canvasStore.ts';
import { NodeView, portsOf } from './NodeView.tsx';
import { afterSeedanceClose } from './openSeedance.ts';
import { cloneSeedance } from '../../core/canvas/seedance.ts';
import { useStore, type ProjectHost } from '../store.ts';

const ImportSchema = z.object({ name: z.string().default('Импорт'), nodes: z.array(CanvasNodeSchema), edges: z.array(CanvasEdgeSchema) });

const SAVE_RU = { saved: 'Сохранено', dirty: 'Изменено', saving: 'Сохраняю…', error: 'Не сохранилось' } as const;

/** Список flows в сайдбаре оболочки — как «Projects» в connxn. */
export function FlowList() {
  const { flows, flow, loadFlows, openFlow, newFlow, deleteFlow } = useCanvas();
  useEffect(() => {
    void loadFlows();
  }, [loadFlows]);
  return (
    <>
      <Button variant="border" size="s" icon={<Icon name="plus" size={1} />} className={styles.newFlow} onClick={() => void newFlow()}>
        Новый flow
      </Button>
      <Text variant="caption" tone="tertiary" className={styles.flowsTitle}>
        Шаблоны — откроются новым flow
      </Text>
      <nav className={styles.flowList}>
        {FLOW_TEMPLATES.map((t) => (
          <div key={t.id} className={styles.flowItem}>
            <button type="button" className={styles.flowLabel} title={t.descriptionRu} onClick={() => void newFlow({ name: t.titleRu, ...t.build(newId) })}>
              <span>{t.titleRu}</span>
              <Icon name="plus" size={0.875} />
            </button>
          </div>
        ))}
      </nav>
      <Text variant="caption" tone="tertiary" className={styles.flowsTitle}>
        Flows
      </Text>
      <nav className={styles.flowList}>
        {flows.map((f) => (
          <div key={f.id} className={`${styles.flowItem} ${f.id === flow?.id ? styles.flowItemActive : ''}`}>
            <button type="button" className={styles.flowLabel} onClick={() => void openFlow(f.id)}>
              <span>{f.name}</span>
              <Text as="span" variant="caption" tone="tertiary">
                {f.nodes}
              </Text>
            </button>
            <button type="button" className={styles.flowDelete} title="Удалить flow (файлы генераций останутся в библиотеке)" onClick={() => void deleteFlow(f.id)}>
              <Icon name="bin" size={0.875} />
            </button>
          </div>
        ))}
      </nav>
    </>
  );
}

/** Карточки шаблонов на пустом холсте и на экране без flows. */
function TemplateCards() {
  const newFlow = useCanvas((s) => s.newFlow);
  return (
    <div className={styles.emptyTemplates}>
      {FLOW_TEMPLATES.map((t) => (
        <button key={t.id} type="button" className={styles.templateCard} onClick={() => void newFlow({ name: t.titleRu, ...t.build(newId) })}>
          <Text variant="label" medium>
            {t.titleRu}
          </Text>
          <Text variant="caption" tone="secondary">
            {t.descriptionRu}
          </Text>
        </button>
      ))}
    </div>
  );
}

type Interaction =
  | { type: 'drag'; id: string; startX: number; startY: number; origins: { id: string; x: number; y: number }[] }
  | { type: 'pan'; startX: number; startY: number; origX: number; origY: number }
  | { type: 'link'; from: string; x: number; y: number }
  /** Рамка выделения: Shift + протяжка по пустому холсту; координаты экранные. */
  | { type: 'marquee'; startX: number; startY: number; x: number; y: number };

const curve = (x1: number, y1: number, x2: number, y2: number): string => {
  const dx = Math.max(48, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};

/** Canvas — нодовый граф по каркасу connxn. Запуск — только нажатой ноды, цена видна до запуска. */
export function Canvas() {
  const { flow, save, selection, error, past, future, newFlow, rename, addNode, patchNode, select, selectMany, removeSelected, moveNodes, connect, disconnect, setViewport, undo, redo, copySelected, pasteNodes, duplicateSelected } = useCanvas();
  const { library, loadJobs, loadLibrary } = useGen();
  const board = useRef<HTMLDivElement>(null);
  const importer = useRef<HTMLInputElement>(null);
  /** Связь дошла до входа — меню «в пустоту» не нужно. */
  const linked = useRef(false);
  const [linkMenu, setLinkMenu] = useState<{ from: string; screenX: number; screenY: number; x: number; y: number } | null>(null);
  const [act, setAct] = useState<Interaction | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const pickKind = flow?.nodes.find((n) => n.id === picker)?.type === 'video' ? 'video' : 'image';
  const [consent, setConsent] = useState<(() => void) | null>(null);

  useEffect(() => {
    void loadJobs();
    void loadLibrary();
  }, [loadJobs, loadLibrary]);

  // Seedance-промптер закрыт — подпись ноды по сохранённому черновику и свежие задачи (выход ноды).
  const host = useStore((s) => s.host);
  const lastHost = useRef<ProjectHost | null>(null);
  useEffect(() => {
    const previous = lastHost.current;
    lastHost.current = host;
    if (previous !== null && host === null) void afterSeedanceClose(previous.nodeId);
  }, [host]);

  const viewport = flow?.viewport ?? { x: 0, y: 0, zoom: 1 };
  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = board.current?.getBoundingClientRect();
    return { x: (clientX - (rect?.left ?? 0) - viewport.x) / viewport.zoom, y: (clientY - (rect?.top ?? 0) - viewport.y) / viewport.zoom };
  };
  const centerWorld = (): { x: number; y: number } => {
    const rect = board.current?.getBoundingClientRect();
    const c = toWorld((rect?.left ?? 0) + (rect?.width ?? 800) / 2, (rect?.top ?? 0) + (rect?.height ?? 600) / 2);
    const jitter = ((flow?.nodes.length ?? 0) % 5) * 24;
    return { x: c.x - 130 + jitter, y: c.y - 120 + jitter };
  };

  // Перетаскивание, панорама и протяжка связи — через window, чтобы не терять курсор за пределами ноды.
  useEffect(() => {
    if (act === null) return;
    const move = (event: PointerEvent): void => {
      if (act.type === 'drag') {
        const dx = (event.clientX - act.startX) / viewport.zoom;
        const dy = (event.clientY - act.startY) / viewport.zoom;
        moveNodes(
          act.origins.map((o) => ({ id: o.id, x: o.x + dx, y: o.y + dy })),
          `move:${act.id}`,
        );
      } else if (act.type === 'pan') setViewport({ ...viewport, x: act.origX + event.clientX - act.startX, y: act.origY + event.clientY - act.startY });
      else if (act.type === 'marquee') setAct({ ...act, x: event.clientX, y: event.clientY });
      else setAct({ ...act, ...toWorld(event.clientX, event.clientY) });
    };
    const up = (event: PointerEvent): void => {
      // Рамка: выделяются ноды, которых она касается (по их настоящим размерам на экране), Shift — к уже выделенным.
      if (act.type === 'marquee') {
        const left = Math.min(act.startX, act.x);
        const right = Math.max(act.startX, act.x);
        const top = Math.min(act.startY, act.y);
        const bottom = Math.max(act.startY, act.y);
        const hit = [...(board.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.left < right && r.right > left && r.top < bottom && r.bottom > top;
          })
          .map((el) => el.dataset.nodeId ?? '');
        selectMany([...new Set([...useCanvas.getState().selection, ...hit])]);
        setAct(null);
        return;
      }
      // Связь отпустили не на входе, а на пустом холсте — меню подходящих нод, как в connxn.
      const target = event.target as Element | null;
      if (act.type === 'link' && !linked.current && target !== null && (target === board.current || target.closest(`.${styles.world}`) === target || target.tagName === 'svg')) {
        setLinkMenu({ from: act.from, screenX: event.clientX, screenY: event.clientY, ...toWorld(event.clientX, event.clientY) });
      }
      linked.current = false;
      setAct(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });

  // Колесо: с Ctrl / щипком — масштаб к курсору, без — прокрутка холста.
  useEffect(() => {
    const el = board.current;
    if (el === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const f = useCanvas.getState().flow;
      if (f === null) return;
      const vp = f.viewport;
      if (event.ctrlKey || event.metaKey) {
        const rect = el.getBoundingClientRect();
        const zoom = Math.min(2, Math.max(0.3, vp.zoom * Math.exp(-event.deltaY * 0.01)));
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        setViewport({ zoom, x: px - ((px - vp.x) / vp.zoom) * zoom, y: py - ((py - vp.y) / vp.zoom) * zoom });
      } else {
        setViewport({ ...vp, x: vp.x - event.deltaX, y: vp.y - event.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [flow?.id, setViewport]);

  // Клавиши, пока фокус не в поле ввода: Delete — удалить, ⌘Z / ⇧⌘Z / ⌘Y — отмена и повтор,
  // ⌘C — копировать ноду в буфер (работает и между flows), ⌘D — дублировать. ⌘V ловит обработчик paste ниже.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const tag = (event.target as HTMLElement | null)?.tagName ?? '';
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      // Поверх холста открыт Seedance-промптер: Delete, ⌘Z и ⌘A относятся к нему, а не к нодам под ним.
      if (useStore.getState().host !== null) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (selection.length > 0 && (event.key === 'Delete' || event.key === 'Backspace')) {
        removeSelected();
      } else if (mod && key === 'a') {
        event.preventDefault();
        selectMany(useCanvas.getState().flow?.nodes.map((n) => n.id) ?? []);
      } else if (event.key === 'Escape') {
        select(null);
      } else if (mod && key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (mod && ((key === 'z' && event.shiftKey) || key === 'y')) {
        event.preventDefault();
        redo();
      } else if (mod && key === 'd') {
        event.preventDefault();
        duplicateSelected();
      } else if (mod && key === 'c') {
        const text = copySelected();
        const n = useCanvas.getState().selection.length;
        if (text !== null) void navigator.clipboard.writeText(text).then(() => setHint(n > 1 ? `Скопировано нод: ${n}, со связями между ними — ⌘V вставит сюда или в другой flow.` : 'Нода скопирована — ⌘V вставит её сюда или в другой flow.'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, removeSelected, selectMany, select, undo, redo, duplicateSelected, copySelected]);

  // Вставка: ноды из буфера, картинка → нода картинки, текст → нода промпта. Как в connxn.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const tag = (event.target as HTMLElement | null)?.tagName ?? '';
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || useCanvas.getState().flow === null || useStore.getState().host !== null) return;
      const at = centerWorld();
      const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file !== undefined) {
        event.preventDefault();
        void uploadImage(file)
          .then((source) => patchNode(addNode('image', at.x, at.y), { source, label: file.name }, false))
          .catch((e: unknown) => setHint(e instanceof Error ? e.message : 'Не загрузилось.'));
        return;
      }
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text.trim() === '') return;
      event.preventDefault();
      if (pasteNodes(text, at) > 0) return;
      patchNode(addNode('prompt', at.x, at.y), { text }, false);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  if (flow === null) {
    return (
      <div className={styles.emptyPage}>
        <Text variant="title-m" medium>
          Canvas
        </Text>
        <Text variant="label" tone="secondary">
          Нодовый воркфлоу: промпты, картинки и генераторы, связанные между собой.
        </Text>
        <Button variant="primary" size="m" icon={<Icon name="plus" size={1} />} onClick={() => void newFlow()}>
          Новый flow
        </Button>
        <Text variant="caption" tone="tertiary">
          или начни с шаблона
        </Text>
        <TemplateCards />
      </div>
    );
  }

  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
  const portPoint = (node: CanvasNode, port: InputPort): { x: number; y: number } => ({ x: node.x, y: node.y + PORT_TOP + Math.max(0, portsOf(node).indexOf(port)) * PORT_STEP });
  const outPoint = (node: CanvasNode): { x: number; y: number } => ({ x: node.x + NODE_WIDTH[node.type], y: node.y + PORT_TOP });
  const cost = flowCost(flow);

  // Shift+клик по шапке — добавить в выделение или убрать; протяжка выделенной ноды двигает всю группу.
  const onHeaderDown = (event: ReactPointerEvent, node: CanvasNode): void => {
    event.stopPropagation();
    if (event.shiftKey) {
      select(node.id, true);
      return;
    }
    const inGroup = selection.includes(node.id) && selection.length > 1;
    if (!inGroup) select(node.id);
    const ids = inGroup ? selection : [node.id];
    const origins = flow.nodes.filter((n) => ids.includes(n.id)).map((n) => ({ id: n.id, x: n.x, y: n.y }));
    setAct({ type: 'drag', id: node.id, startX: event.clientX, startY: event.clientY, origins });
  };
  const onOutputDown = (event: ReactPointerEvent, node: CanvasNode): void => {
    event.stopPropagation();
    setAct({ type: 'link', from: node.id, ...toWorld(event.clientX, event.clientY) });
  };
  const onInputUp = (node: CanvasNode, port: InputPort): void => {
    if (act?.type !== 'link') return;
    linked.current = true;
    const from = nodeById.get(act.from);
    setAct(null);
    if (from === undefined) return;
    if (!portAccepts(port, outputOf(from))) {
      setHint(port === 'prompt' ? 'Во вход «Промпт» подключается нода промпта.' : port === 'video' ? 'Во вход «Видео» подключается видео: генератор, своё видео или обрезка.' : port === 'media' ? 'Во вход «Файл» подключается картинка или видео.' : 'Во вход картинки подключается картинка, кадр или генератор картинки.');
      return;
    }
    const problem = connect(from.id, node.id, port);
    setHint(problem);
  };

  /** Что можно создать на конце связи, отпущенной в пустоту, — по типу выхода. */
  const linkOptions = (fromId: string): { label: string; type: 'generator' | 'frame' | 'trim' | 'resize' | 'seedance'; kind: 'image' | 'video'; port: InputPort }[] => {
    const from = nodeById.get(fromId);
    if (from === undefined) return [];
    const out = outputOf(from);
    if (out === 'text')
      return [
        { label: 'Генератор картинки', type: 'generator', kind: 'image', port: 'prompt' },
        { label: 'Генератор видео', type: 'generator', kind: 'video', port: 'prompt' },
      ];
    if (out === 'video')
      return [
        { label: 'Кадр из видео', type: 'frame', kind: 'image', port: 'video' },
        { label: 'Обрезка видео', type: 'trim', kind: 'image', port: 'video' },
        { label: 'Размер под площадку', type: 'resize', kind: 'video', port: 'media' },
      ];
    return [
      { label: 'Генератор картинки · референс', type: 'generator', kind: 'image', port: 'ref' },
      { label: 'Генератор видео · старт-кадр', type: 'generator', kind: 'video', port: 'start' },
      { label: 'Seedance-промптер · в панель', type: 'seedance', kind: 'image', port: 'ref' },
      { label: 'Размер под площадку', type: 'resize', kind: 'image', port: 'media' },
    ];
  };
  const createLinked = (opt: ReturnType<typeof linkOptions>[number]): void => {
    if (linkMenu === null) return;
    const id = addNode(opt.type, linkMenu.x, linkMenu.y - PORT_TOP, opt.kind);
    // Порт «Старт» у генератора видео — второй вход, а модель по умолчанию его поддерживает (Kling / Seedance).
    setHint(connect(linkMenu.from, id, opt.port));
    setLinkMenu(null);
  };

  const fit = (): void => {
    const rect = board.current?.getBoundingClientRect();
    if (rect === undefined || flow.nodes.length === 0) return setViewport({ x: 0, y: 0, zoom: 1 });
    const minX = Math.min(...flow.nodes.map((n) => n.x));
    const minY = Math.min(...flow.nodes.map((n) => n.y));
    const maxX = Math.max(...flow.nodes.map((n) => n.x + NODE_WIDTH[n.type]));
    const maxY = Math.max(...flow.nodes.map((n) => n.y + 360));
    const zoom = Math.min(1, Math.max(0.3, Math.min(rect.width / (maxX - minX + 96), rect.height / (maxY - minY + 96))));
    setViewport({ zoom, x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom });
  };

  const exportFlow = (): void => {
    const blob = new Blob([JSON.stringify({ name: flow.name, nodes: flow.nodes, edges: flow.edges }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${flow.name.replace(/[^\p{L}\p{N}-]+/gu, '-')}.flow.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importFlow = async (f: File): Promise<void> => {
    try {
      const parsed = ImportSchema.parse(JSON.parse(await f.text()));
      // Новые id: импорт того же flow второй раз не должен делить с оригиналом ноды и черновики Seedance-промптеров.
      const ids = new Map(parsed.nodes.map((n) => [n.id, newId('n')]));
      const nodes = parsed.nodes.map((n) => ({ ...n, id: ids.get(n.id) ?? n.id, ...cloneSeedance(n) }));
      const edges = parsed.edges.flatMap((e) => {
        const from = ids.get(e.from);
        const to = ids.get(e.to);
        return from === undefined || to === undefined ? [] : [{ ...e, id: newId('e'), from, to }];
      });
      await newFlow({ name: parsed.name, nodes, edges });
    } catch {
      setHint('Это не flow: файл не читается как экспорт canvas.');
    }
  };

  const linkFrom = act?.type === 'link' ? nodeById.get(act.from) : undefined;

  return (
    <div className={styles.canvas}>
      <header className={styles.head}>
        <input className={styles.name} value={flow.name} onChange={(event) => rename(event.target.value)} aria-label="Название flow" />
        <Text variant="caption" tone="secondary">
          {flow.nodes.length} нод · {SAVE_RU[save]}
          {error !== null && save === 'error' ? ` · ${error}` : ''}
        </Text>
        <span className={styles.grow} />
        <Button variant="soft" size="xs" icon={<Icon name="pencil" size={0.875} />} onClick={() => addNode('prompt', centerWorld().x, centerWorld().y)}>
          Промпт
        </Button>
        <Button variant="soft" size="xs" icon={<Icon name="image" size={0.875} />} onClick={() => addNode('image', centerWorld().x, centerWorld().y)}>
          Картинка
        </Button>
        <Button variant="soft" size="xs" icon={<Icon name="sparkles" size={0.875} />} title="Нода-генератор картинки" onClick={() => addNode('generator', centerWorld().x, centerWorld().y, 'image')}>
          Ген. картинки
        </Button>
        <Button variant="soft" size="xs" icon={<Icon name="video" size={0.875} />} title="Нода-генератор видео" onClick={() => addNode('generator', centerWorld().x, centerWorld().y, 'video')}>
          Ген. видео
        </Button>
        <Button variant="soft" size="xs" icon={<Icon name="options" size={0.875} />} title="Seedance-промптер — полный конструктор кадра «Кадров»: съёмка, камера, рефы по номерам, сценарий по шотам, генерация" onClick={() => addNode('seedance', centerWorld().x, centerWorld().y)}>
          Seedance-промптер
        </Button>
        <Button variant="soft" size="xs" icon={<Icon name="layers" size={0.875} />} title="Первый / последний кадр видео — старт-кадр следующего клипа" onClick={() => addNode('frame', centerWorld().x, centerWorld().y)}>
          Кадр
        </Button>
        <Button variant="soft" size="xs" icon={<Icon name="upload" size={0.875} />} title="Своё видео с диска или из библиотеки — его можно резать и брать кадр" onClick={() => addNode('video', centerWorld().x, centerWorld().y)}>
          Видео
        </Button>
        <Button variant="soft" size="xs" icon={<Icon name="time" size={0.875} />} title="Обрезать видео по времени — бесплатно, локально" onClick={() => addNode('trim', centerWorld().x, centerWorld().y)}>
          Обрезка
        </Button>
        <Button variant="soft" size="xs" icon={<Icon name="apps" size={0.875} />} title="Картинку или видео — под размер площадки (1080×1920 и др.), бесплатно" onClick={() => addNode('resize', centerWorld().x, centerWorld().y)}>
          Размер
        </Button>
      </header>

      <div
        ref={board}
        className={styles.board}
        style={{ backgroundPosition: `${viewport.x}px ${viewport.y}px`, backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px` }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return;
          // Shift + протяжка — рамка выделения; просто протяжка — сдвиг холста (как раньше).
          if (event.shiftKey) {
            setAct({ type: 'marquee', startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY });
            return;
          }
          select(null);
          setAct({ type: 'pan', startX: event.clientX, startY: event.clientY, origX: viewport.x, origY: viewport.y });
        }}
        onDoubleClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const p = toWorld(event.clientX, event.clientY);
          addNode('prompt', p.x, p.y);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const f = event.dataTransfer.files[0];
          if (f === undefined) return;
          const p = toWorld(event.clientX, event.clientY);
          // Видео с диска — в библиотеку и нодой «Видео»: его можно резать и брать из него кадр.
          if (f.type.startsWith('video/')) {
            setHint(`Загружаю «${f.name}»…`);
            void importMedia(f)
              .then((item) => {
                patchNode(addNode('video', p.x, p.y), { mediaId: item.id, label: f.name }, false);
                setHint(null);
                void loadLibrary();
              })
              .catch((e: unknown) => setHint(e instanceof Error ? e.message : 'Видео не загрузилось.'));
            return;
          }
          void uploadImage(f)
            .then((source) => {
              const id = addNode('image', p.x, p.y);
              patchNode(id, { source, label: f.name });
            })
            .catch((e: unknown) => setHint(e instanceof Error ? e.message : 'Не загрузилось.'));
        }}
      >
        <div className={styles.world} style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
          <svg className={styles.edges} aria-hidden="true">
            {flow.edges.map((edge) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (from === undefined || to === undefined) return null;
              const a = outPoint(from);
              const b = portPoint(to, edge.port);
              const d = curve(a.x, a.y, b.x, b.y);
              return (
                <g key={edge.id} className={styles.edge} onClick={() => disconnect(edge.id)}>
                  <title>Клик — убрать связь</title>
                  <path d={d} className={styles.edgeHit} />
                  <path d={d} className={edge.port === 'prompt' ? styles.edgeText : styles.edgeMedia} />
                </g>
              );
            })}
            {linkFrom !== undefined && act?.type === 'link' && <path d={curve(outPoint(linkFrom).x, outPoint(linkFrom).y, act.x, act.y)} className={styles.edgeDraft} />}
          </svg>
          {flow.nodes.map((node) => (
            <NodeView key={node.id} node={node} selected={selection.includes(node.id)} onHeaderDown={onHeaderDown} onOutputDown={onOutputDown} onInputUp={onInputUp} onPickFromLibrary={setPicker} onNeedConsent={(runIt) => setConsent(() => runIt)} />
          ))}
        </div>

        {flow.nodes.length === 0 && (
          <div className={styles.emptyBoard}>
            <span className={styles.emptyIcon}>
              <Icon name="layers" size={1.5} />
            </span>
            <Text variant="title-m" medium>
              Собери свой воркфлоу
            </Text>
            <Text variant="label" tone="secondary">
              Перетащи картинку на холст, двойной клик — нода промпта. Выход ноды тяни ко входу генератора.
            </Text>
            <div className={styles.emptyActions}>
              <Button variant="border" size="s" icon={<Icon name="pencil" size={1} />} onClick={() => addNode('prompt', centerWorld().x, centerWorld().y)}>
                Промпт
              </Button>
              <Button variant="border" size="s" icon={<Icon name="sparkles" size={1} />} onClick={() => addNode('generator', centerWorld().x + 320, centerWorld().y, 'image')}>
                Генератор картинки
              </Button>
            </div>
            <Text variant="caption" tone="tertiary">
              или начни с шаблона — он откроется новым flow
            </Text>
            <TemplateCards />
          </div>
        )}
        {act?.type === 'marquee' && (
          <div
            className={styles.marquee}
            style={{
              left: Math.min(act.startX, act.x) - (board.current?.getBoundingClientRect().left ?? 0),
              top: Math.min(act.startY, act.y) - (board.current?.getBoundingClientRect().top ?? 0),
              width: Math.abs(act.x - act.startX),
              height: Math.abs(act.y - act.startY),
            }}
          />
        )}
        {selection.length > 1 && (
          <div className={styles.selectionBar}>
            <Text variant="caption" tone="secondary">
              Выделено: {selection.length} · перетащи любую — двинется группа · ⌘C / ⌘D / Delete
            </Text>
          </div>
        )}
        {linkMenu !== null && (
          <div className={styles.linkMenu} style={{ left: linkMenu.screenX - (board.current?.getBoundingClientRect().left ?? 0), top: linkMenu.screenY - (board.current?.getBoundingClientRect().top ?? 0) }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
            <Text variant="caption" tone="tertiary" className={styles.linkMenuTitle}>
              Добавить и соединить
            </Text>
            {linkOptions(linkMenu.from).map((opt) => (
              <button key={opt.label} type="button" role="menuitem" onClick={() => createLinked(opt)}>
                <Icon name={opt.type === 'frame' ? 'layers' : opt.type === 'trim' ? 'time' : opt.type === 'resize' ? 'apps' : opt.type === 'seedance' ? 'options' : opt.kind === 'video' ? 'video' : 'sparkles'} size={0.875} />
                {opt.label}
              </button>
            ))}
            <button type="button" role="menuitem" onClick={() => setLinkMenu(null)}>
              <Icon name="close" size={0.875} />
              Отмена
            </button>
          </div>
        )}
        {hint !== null && (
          <button type="button" className={styles.hint} onClick={() => setHint(null)}>
            <Text variant="caption">{hint}</Text>
            <Icon name="close" size={0.75} />
          </button>
        )}
        {/* Плавающая группа, как в дизайн-инструментах: вписать, масштаб, экспорт / импорт. */}
        <div className={styles.zoom}>
          {cost.usd > 0 && (
            <span className={styles.cost} title="Сумма по одному запуску каждого генератора. Всё разом не запускается — только нода, которую нажал.">
              <Text as="span" variant="caption" tone="secondary">
                прогон всех ≈ ${cost.usd}
                {cost.credits > 0 ? ` · ${cost.credits} кр` : ''}
              </Text>
            </span>
          )}
          <button type="button" onClick={undo} disabled={past.length === 0} aria-label="Отменить (⌘Z)" title="Отменить (⌘Z)">
            <Icon name="arrow-undo" size={0.875} />
          </button>
          <button type="button" onClick={redo} disabled={future.length === 0} aria-label="Повторить (⇧⌘Z)" title="Повторить (⇧⌘Z)">
            <Icon name="arrow-redo" size={0.875} />
          </button>
          <button type="button" onClick={fit} title="Вписать все ноды">
            <Text as="span" variant="caption">
              Вписать
            </Text>
          </button>
          <button type="button" onClick={() => setViewport({ ...viewport, zoom: Math.max(0.3, viewport.zoom - 0.1) })} aria-label="Уменьшить">
            <Icon name="minus" size={0.875} />
          </button>
          <Text as="span" variant="caption" tone="secondary" mono>
            {Math.round(viewport.zoom * 100)}%
          </Text>
          <button type="button" onClick={() => setViewport({ ...viewport, zoom: Math.min(2, viewport.zoom + 0.1) })} aria-label="Увеличить">
            <Icon name="plus" size={0.875} />
          </button>
          <button type="button" onClick={exportFlow} aria-label="Экспорт flow в JSON" title="Экспорт flow в JSON">
            <Icon name="download" size={0.875} />
          </button>
          <input ref={importer} type="file" accept="application/json,.json" hidden onChange={(event) => event.target.files?.[0] !== undefined && void importFlow(event.target.files[0]).finally(() => (event.target.value = ''))} />
          <button type="button" onClick={() => importer.current?.click()} aria-label="Импорт flow из JSON" title="Импорт flow из JSON">
            <Icon name="upload" size={0.875} />
          </button>
        </div>
      </div>

      <Dialog open={picker !== null} onOpenChange={(open) => !open && setPicker(null)} size="l" title={pickKind === 'video' ? 'Видео из библиотеки' : 'Картинка из библиотеки'} description="Файлы с диска — ссылки провайдера для них не нужны. Свои файлы добавляются кнопкой «С диска».">
        <div className={styles.pickerGrid}>
          {library
            .filter((m) => m.kind === pickKind)
            .map((m) => (
              <button
                key={m.id}
                type="button"
                className={styles.pickerItem}
                onClick={() => {
                  if (picker !== null) patchNode(picker, pickKind === 'video' ? { mediaId: m.id, label: m.modelId === 'local/import' ? m.prompt : 'Из библиотеки' } : { source: { type: 'media', mediaId: m.id }, label: 'Из библиотеки' });
                  setPicker(null);
                }}
              >
                {pickKind === 'video' ? <video src={mediaUrl(m.id)} muted preload="metadata" /> : <img src={mediaUrl(m.id)} alt={m.prompt.slice(0, 60)} loading="lazy" />}
              </button>
            ))}
          {library.every((m) => m.kind !== pickKind) && (
            <Text variant="label" tone="tertiary">
              {pickKind === 'video' ? 'В библиотеке пока нет видео.' : 'В библиотеке пока нет картинок.'}
            </Text>
          )}
        </div>
      </Dialog>

      <Dialog
        open={consent !== null}
        onOpenChange={(open) => !open && setConsent(null)}
        title="Отправить картинки провайдеру?"
        description="Входные картинки ноды уйдут в KIE, а оттуда — исполнителю модели (fal / replicate). Если на них есть лицо, оно тоже уйдёт. Согласие действует до закрытия вкладки."
        footer={
          <>
            <Button variant="ghost" size="s" onClick={() => setConsent(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              size="s"
              onClick={() => {
                consent?.();
                setConsent(null);
              }}
            >
              Отправить и запустить
            </Button>
          </>
        }
      >
        <Text variant="label" tone="secondary">
          Запустится только эта нода.
        </Text>
      </Dialog>
    </div>
  );
}
