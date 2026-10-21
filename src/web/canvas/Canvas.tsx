import { SeriesFlow } from '../series/SeriesFlow.tsx';
import { studioFetch as fetch } from '../remoteFetch.ts';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { z } from 'zod';
import { flowCost, nodeTitle } from '../../core/canvas/plan.ts';
import { CanvasEdgeSchema, CanvasNodeSchema, FlowSchema, portAccepts, outputOf, type CanvasNode, type InputPort } from '../../core/model/canvas.ts';
import type { GenJob } from '../../core/model/media.ts';
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
  const { flows, flow, loadFlows, openFlow, newFlow, deleteFlow, restoreFlow } = useCanvas();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<string | null>(null);
  useEffect(() => {
    void loadFlows();
  }, [loadFlows]);
  return (
    <>
      <Button variant="border" size="s" icon={<Icon name="plus" size={1} />} className={styles.newFlow} onClick={() => void newFlow({ name: 'Новый холст', nodes: [], edges: [] })}>
        Создать холст
      </Button>
      <Text variant="caption" tone="tertiary" className={styles.flowsTitle}>
        Мои холсты
      </Text>
      <nav className={styles.flowList} aria-label="Мои холсты">
        {flows.map((f) => (
          <div key={f.id} className={`${styles.flowItem} ${f.production ? styles.productionFlow : ''} ${f.id === flow?.id ? styles.flowItemActive : ''}`}>
            <button type="button" className={styles.flowLabel} aria-current={f.id === flow?.id ? 'page' : undefined} onClick={() => void openFlow(f.id)}>
              <span>{f.name}{f.production && <Text as="span" variant="caption" tone="secondary" className={styles.productionBadge}>Из производства</Text>}</span>
              <Text as="span" variant="caption" tone="tertiary">
                {f.nodes}
              </Text>
            </button>
            <button type="button" className={styles.flowDelete} style={confirmDelete === f.id ? { width: 'auto', opacity: 1 } : undefined} aria-label={`Удалить холст «${f.name}»`} title="Удалить холст (файлы генераций останутся в библиотеке)" onClick={() => { if (confirmDelete !== f.id) { setConfirmDelete(f.id); return; } void deleteFlow(f.id).then(() => { setDeleted(f.id); setConfirmDelete(null); }); }}>
              {confirmDelete === f.id ? 'Удалить?' : <Icon name="bin" size={0.875} />}
            </button>
          </div>
        ))}
      </nav>
      {confirmDelete !== null && <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(null)}>Отмена удаления</Button>}
      {deleted !== null && <Button variant="border" size="s" onClick={() => void restoreFlow(deleted).then(() => setDeleted(null))}>Восстановить удалённый холст</Button>}
      {flows.length === 0 && <Text variant="caption" tone="tertiary" className={styles.flowsTitle}>Здесь будут твои работы.</Text>}
      <details className={styles.sidebarTemplates}>
        <summary>Шаблоны холстов</summary>
        <nav className={styles.flowList} aria-label="Шаблоны холстов">
          {FLOW_TEMPLATES.map((t) => (
            <button key={t.id} type="button" className={styles.flowLabel} title={t.descriptionRu} onClick={() => void newFlow({ name: t.titleRu, ...t.build(newId) })}>
              <span>{t.titleRu}</span>
              <Icon name="plus" size={0.875} />
            </button>
          ))}
        </nav>
      </details>
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
  const addMenu = useRef<HTMLDetailsElement>(null);
  /** Связь дошла до входа — меню «в пустоту» не нужно. */
  const linked = useRef(false);
  const [linkMenu, setLinkMenu] = useState<{ from: string; screenX: number; screenY: number; x: number; y: number } | null>(null);
  const [act, setAct] = useState<Interaction | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [keyboardFrom, setKeyboardFrom] = useState<string | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);
  const pickKind = flow?.nodes.find((n) => n.id === picker)?.type === 'video' ? 'video' : 'image';
  const [consent, setConsent] = useState<(() => void) | null>(null);

  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (addMenu.current !== null && !addMenu.current.contains(event.target as Node)) addMenu.current.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);

  useEffect(() => {
    void loadJobs();
    void loadLibrary();
  }, [loadJobs, loadLibrary]);

  const jobIdsKey = (flow?.nodes.flatMap((node) => node.jobIds) ?? []).join(',');
  useEffect(() => {
    const ids = [...new Set(jobIdsKey.split(',').filter(Boolean))];
    const missing = ids.filter((id) => !useGen.getState().jobs.some((job) => job.id === id));
    void Promise.all(missing.map(async (id) => {
      const response = await fetch(`/api/gen/jobs/${encodeURIComponent(id)}`);
      return response.ok ? await response.json() as GenJob : null;
    })).then((found) => useGen.setState((state) => ({ jobs: [...new Map([...state.jobs, ...found.filter((job): job is GenJob => job !== null)].map((job) => [job.id, job])).values()] }))).catch(() => setHint('Не удалось загрузить историю результатов. Обнови страницу.'));
  }, [jobIdsKey]);
  useEffect(() => {
    setKeyboardFrom(null);
    setPicker(null);
    setConsent(null);
    const flush = (): void => { void useCanvas.getState().flush(); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [flow?.id]);
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { if (keyboardFrom !== null) { const node = [...(board.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])].find((el) => el.dataset.nodeId === keyboardFrom); node?.querySelector<HTMLButtonElement>('button[aria-pressed]')?.focus(); } setKeyboardFrom(null); setHint(null); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [keyboardFrom]);

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
    const x = c.x - 130;
    let y = c.y - 120;
    const occupied = (flow?.nodes ?? []).map((n) => {
      const el = [...(board.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])].find((element) => element.dataset.nodeId === n.id);
      return { x: n.x, y: n.y, width: NODE_WIDTH[n.type], height: el?.offsetHeight ?? 360 };
    });
    for (let i = 0; i <= occupied.length; i += 1) {
      const hit = occupied.find((r) => x < r.x + r.width + 32 && x + 320 > r.x - 32 && y < r.y + r.height + 32 && y + 400 > r.y - 32);
      if (!hit) break;
      y = hit.y + hit.height + 48;
    }
    return { x, y };
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
      if (event.target instanceof Element && event.target.closest(`.${styles.emptyBoard}`) !== null) return;
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
      if (document.querySelector('[aria-modal="true"], [role="dialog"][data-state="open"]') !== null) return;
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
        if (text !== null) void navigator.clipboard.writeText(text).then(() => setHint(n > 1 ? `Скопировано блоков: ${n}, со связями — ⌘V вставит сюда или на другой холст.` : 'Блок скопирован — ⌘V вставит его сюда или на другой холст.'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, removeSelected, selectMany, select, undo, redo, duplicateSelected, copySelected]);

  // Вставка: ноды из буфера, картинка → нода картинки, текст → нода промпта. Как в connxn.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const tag = (event.target as HTMLElement | null)?.tagName ?? '';
      if (document.querySelector('[aria-modal="true"], [role="dialog"][data-state="open"]') !== null) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || useCanvas.getState().flow === null || useStore.getState().host !== null) return;
      const at = centerWorld();
      const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file !== undefined) {
        event.preventDefault();
        const targetFlow = useCanvas.getState().flow?.id;
        void uploadImage(file)
          .then((source) => { if (useCanvas.getState().flow?.id === targetFlow) patchNode(addNode('image', at.x, at.y), { source, label: file.name }, false); })
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
          Вся работа — на одном холсте
        </Text>
        <Text variant="label" tone="secondary">
          Собери референсы, создавай изображения и видео, дорабатывай результат для клиента.
        </Text>
        <Button variant="primary" size="m" icon={<Icon name="plus" size={1} />} data-guide="canvas-create" onClick={() => void newFlow({ name: 'Новый холст', nodes: [], edges: [] })}>
          Создать холст
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
      setHint(port === 'prompt' ? 'Во вход «Промпт» подключается блок с текстом промпта.' : port === 'video' ? 'Во вход «Видео» подключается видео: генератор, своё видео или обрезка.' : port === 'media' ? 'Во вход «Файл» подключается изображение или видео.' : 'Во вход изображения подключается изображение, стоп-кадр или генератор изображения.');
      return;
    }
    const problem = connect(from.id, node.id, port);
    setHint(problem);
  };

  /** Что можно создать на конце связи, отпущенной в пустоту, — по типу выхода. */
  const linkOptions = (fromId: string): { label: string; type: 'generator' | 'frame' | 'trim' | 'resize' | 'seedance' | 'upscale'; kind: 'image' | 'video'; port: InputPort }[] => {
    const from = nodeById.get(fromId);
    if (from === undefined) return [];
    const out = outputOf(from);
    if (out === 'text')
      return [
        { label: 'Создать изображение', type: 'generator', kind: 'image', port: 'prompt' },
        { label: 'Создать видео', type: 'generator', kind: 'video', port: 'prompt' },
      ];
    if (out === 'video')
      return [
        { label: 'Извлечь стоп-кадр', type: 'frame', kind: 'image', port: 'video' },
        { label: 'Обрезка видео', type: 'trim', kind: 'image', port: 'video' },
        { label: 'Размер под площадку', type: 'resize', kind: 'video', port: 'media' },
        { label: 'Апскейл Topaz', type: 'upscale', kind: 'video', port: 'media' },
      ];
    return [
      { label: 'Создать изображение по референсу', type: 'generator', kind: 'image', port: 'ref' },
      { label: 'Оживить изображение', type: 'generator', kind: 'video', port: 'start' },
      { label: 'Добавить в Seedance-промптер', type: 'seedance', kind: 'image', port: 'ref' },
      { label: 'Размер под площадку', type: 'resize', kind: 'image', port: 'media' },
      { label: 'Апскейл Topaz', type: 'upscale', kind: 'image', port: 'media' },
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
    const heights = new Map([...(board.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])].map((el) => [el.dataset.nodeId, el.offsetHeight]));
    const maxY = Math.max(...flow.nodes.map((n) => n.y + (heights.get(n.id) ?? 360)));
    const zoom = Math.min(1, Math.max(0.1, Math.min(rect.width / (maxX - minX + 96), rect.height / (maxY - minY + 96))));
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
      FlowSchema.parse({ ...parsed, id: 'import', createdAt: '', updatedAt: '' });
      // Новые id: импорт того же flow второй раз не должен делить с оригиналом ноды и черновики Seedance-промптеров.
      const ids = new Map(parsed.nodes.map((n) => [n.id, newId('n')]));
      const nodes = parsed.nodes.map((n) => ({ ...n, production: undefined, id: ids.get(n.id) ?? n.id, ...cloneSeedance(n) }));
      const edges = parsed.edges.flatMap((e) => {
        const from = ids.get(e.from);
        const to = ids.get(e.to);
        return from === undefined || to === undefined ? [] : [{ ...e, id: newId('e'), from, to }];
      });
      await newFlow({ name: parsed.name, nodes, edges });
    } catch {
      setHint('Не удалось открыть схему. Выбери JSON-файл, сохранённый кнопкой «Сохранить схему».');
    }
  };

  const addBlock = (type: CanvasNode['type'], kind: 'image' | 'video' = 'image'): void => {
    const at = centerWorld();
    addNode(type, at.x, at.y, kind);
    setViewport({ ...viewport, x: 80 - at.x * viewport.zoom, y: 80 - at.y * viewport.zoom });
    if (addMenu.current !== null) {
      addMenu.current.open = false;
      addMenu.current.querySelector('summary')?.focus();
    }
  };

  const linkFrom = act?.type === 'link' ? nodeById.get(act.from) : undefined;

  return (
    <div className={styles.canvas}>
      <header className={styles.head}>
        <div className={styles.flowIdentity} data-guide="canvas-save">
          <input className={styles.name} value={flow.name} onChange={(event) => rename(event.target.value)} aria-label="Название холста" />
          <Text variant="caption" tone={save === 'error' ? 'primary' : 'tertiary'}>
            {SAVE_RU[save]}{error !== null ? ` · ${error}` : ''}
          </Text>
        </div>
        {error !== null && <Button variant="border" size="xs" onClick={() => void useCanvas.getState().saveCopy()}>Сохранить копию</Button>}
        <Button variant="ghost" size="xs" onClick={() => setConnectionsOpen(true)}>Связи ({flow.edges.length})</Button>
        <span className={styles.grow} />
        <Button variant="ghost" size="xs" data-guide="canvas-export" icon={<Icon name="download" size={0.875} />} onClick={exportFlow} title="Скачать схему холста в JSON. Медиафайлы скачиваются из результата.">
          Сохранить схему
        </Button>
        <Button variant="ghost" size="xs" icon={<Icon name="upload" size={0.875} />} onClick={() => importer.current?.click()} title="Открыть сохранённую схему холста из JSON">
          Открыть схему
        </Button>
        <input ref={importer} type="file" accept="application/json,.json" hidden onChange={(event) => event.target.files?.[0] !== undefined && void importFlow(event.target.files[0]).finally(() => (event.target.value = ''))} />
        <details
          ref={addMenu}
          className={styles.addMenu}
          data-guide="canvas-add"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }}
          onBlur={(event) => {
            // WebKit blurs summary to null on mouse-down without focusing the button.
            // Closing here removes the target before click; outside pointer-down handles that case.
            if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false;
          }}
        >
          <summary className={styles.addTrigger}><Icon name="plus" size={1} />Добавить</summary>
          <div className={styles.addPanel}>
            <div className={styles.addGroup} role="group" aria-label="Материал">
              <Text variant="caption" tone="tertiary">Материал</Text>
              <button type="button" onClick={() => addBlock('image')}><Icon name="image" size={1} />Изображение</button>
              <button type="button" onClick={() => addBlock('video')}><Icon name="video" size={1} />Видео</button>
            </div>
            <div className={styles.addGroup} role="group" aria-label="Создать">
              <Text variant="caption" tone="tertiary">Создать</Text>
              <button type="button" onClick={() => addBlock('generator', 'image')}><Icon name="sparkles" size={1} />Изображение</button>
              <button type="button" onClick={() => addBlock('generator', 'video')}><Icon name="video" size={1} />Видео</button>
              <button type="button" onClick={() => addBlock('seedance')}><Icon name="options" size={1} />Seedance-промптер</button>
              <button type="button" onClick={() => addBlock('prompt')}><Icon name="pencil" size={1} />Текст промпта</button>
            </div>
            <div className={styles.addGroup} role="group" aria-label="Обработать">
              <Text variant="caption" tone="tertiary">Обработать</Text>
              <button type="button" onClick={() => addBlock('frame')}><Icon name="layers" size={1} />Стоп-кадр</button>
              <button type="button" onClick={() => addBlock('trim')}><Icon name="time" size={1} />Обрезка видео</button>
              <button type="button" onClick={() => addBlock('resize')}><Icon name="apps" size={1} />Размер под площадку</button>
              <button type="button" onClick={() => addBlock('upscale')}><Icon name="push" size={1} />Апскейл Topaz</button>
            </div>
          </div>
        </details>
      </header>
      {flow.production && <SeriesFlow key={flow.id} flow={flow} />}
      <div
        ref={board}
        className={styles.board}
        data-guide="canvas-board"
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
                if (useCanvas.getState().flow?.id !== flow.id) return;
                patchNode(addNode('video', p.x, p.y), { mediaId: item.id, label: f.name }, false);
                setHint(null);
                void loadLibrary();
              })
              .catch((e: unknown) => setHint(e instanceof Error ? e.message : 'Видео не загрузилось.'));
            return;
          }
          void uploadImage(f)
            .then((source) => {
              if (useCanvas.getState().flow?.id !== flow.id) return;
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
            <NodeView key={`${flow.id}:${node.id}`} node={node} selected={selection.includes(node.id)} onHeaderDown={onHeaderDown} onOutputDown={onOutputDown} onInputUp={onInputUp} keyboardSource={keyboardFrom === node.id} onKeyboardOutput={() => { setKeyboardFrom(node.id); setHint('Выход выбран. Нажми Tab до нужного входа и Enter; Escape — отмена.'); }} onKeyboardInput={(port) => { if (keyboardFrom !== null) { setHint(connect(keyboardFrom, node.id, port) ?? 'Связь создана.'); setKeyboardFrom(null); } else setHint('Сначала выбери выход исходной ноды.'); }} onPickFromLibrary={setPicker} onNeedConsent={(runIt) => setConsent(() => runIt)} />
          ))}
        </div>

        {flow.nodes.length === 0 && (
          <div className={styles.emptyBoard}>
            <Text variant="title-m" medium>
              С чего начнём?
            </Text>
            <Text variant="label" tone="secondary">
              Добавь блок или перетащи изображение или видео на холст.
            </Text>
            <div className={styles.emptyActions}>
              <Button variant="primary" size="s" icon={<Icon name="plus" size={1} />} onClick={() => {
                if (addMenu.current === null) return;
                addMenu.current.open = true;
                addMenu.current.querySelector('summary')?.focus();
              }}>
                Добавить блок
              </Button>
            </div>
            <Text variant="caption" tone="tertiary">
              Или выбери шаблон — откроется на новом холсте
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
              Выделено: {selection.length} · перетащи блок — двинется группа · ⌘C / ⌘D / Delete
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
                <Icon name={opt.type === 'frame' ? 'layers' : opt.type === 'trim' ? 'time' : opt.type === 'resize' ? 'apps' : opt.type === 'seedance' ? 'options' : opt.type === 'upscale' ? 'push' : opt.kind === 'video' ? 'video' : 'sparkles'} size={0.875} />
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
          <button type="button" className={styles.hint} aria-live="polite" onClick={() => setHint(null)}>
            <Text variant="caption">{hint}</Text>
            <Icon name="close" size={0.75} />
          </button>
        )}
        {/* Плавающая группа: история, масштаб и оценка генераций. */}
        <div className={styles.zoom}>
          {cost.unquoted > 0 && <Text variant="caption" tone="secondary">Seedance: цена перед запуском · {cost.unquoted}</Text>}
          {cost.usd > 0 && (
            <span className={styles.cost} title="Оценка одного запуска каждого генератора. Каждый блок запускается отдельно, с ценой на кнопке.">
              <Text as="span" variant="caption" tone="secondary">
                Генерации ≈ ${cost.usd}
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
          <button type="button" onClick={fit} title="Показать все блоки">
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
        </div>
      </div>

      <Dialog open={connectionsOpen} onOpenChange={setConnectionsOpen} title="Связи холста" description="Клавиатура: выбери выход ноды, затем нужный вход. Здесь можно удалить связь.">
        {flow.edges.length === 0 && <Text>Связей пока нет.</Text>}
        {flow.edges.map((edge) => <div key={edge.id}><Text>{nodeTitle(nodeById.get(edge.from)!)} → {nodeTitle(nodeById.get(edge.to)!)} · {edge.port}</Text><Button variant="border" size="s" onClick={() => disconnect(edge.id)}>Удалить связь</Button></div>)}
      </Dialog>
      <Dialog open={picker !== null} onOpenChange={(open) => !open && setPicker(null)} size="l" title={pickKind === 'video' ? 'Видео из библиотеки' : 'Картинка из библиотеки'} description="Выбери файл для этого блока. Свои файлы можно добавить в блоке кнопкой «С диска».">
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
        description="Изображения этого блока уйдут в KIE, а оттуда — исполнителю модели (fal / replicate). Если на них есть лицо, оно тоже уйдёт. Согласие действует до закрытия вкладки."
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
          Запустится только этот блок.
        </Text>
      </Dialog>
    </div>
  );
}
