import { nodeTitle } from './nodeTitle.ts';
import { ui } from '../language.ts';
import { SeriesFlow } from '../series/SeriesFlow.tsx';
import { studioFetch as fetch } from '../remoteFetch.ts';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { z } from 'zod';
import { flowCost } from '../../core/canvas/plan.ts';
import { referenceComments } from '../../core/canvas/ai.ts';
import { CanvasEdgeSchema, CanvasNodeSchema, CanvasSectionSchema, FlowSchema, portAccepts, outputOf, type CanvasNode, type Flow, type InputPort } from '../../core/model/canvas.ts';
import type { GenJob } from '../../core/model/media.ts';
import { importMedia, uploadImage, mediaUrl, useGen } from '../gen/genStore.ts';
import { Button, Dialog, Icon, Text } from '../ui/components/index.ts';
import styles from './Canvas.module.css';
import { FLOW_TEMPLATES } from '../../core/canvas/templates.ts';
import { CLIPBOARD_PREFIX, newId, NODE_WIDTH, PORT_STEP, PORT_TOP, remapCanvasCopy, remapCanvasSections, useCanvas, type FlowHistoryItem } from './canvasStore.ts';
import { NodeView, portsOf, PORT_RU } from './NodeView.tsx';
import { afterSeedanceClose } from './openSeedance.ts';
import { CanvasAiDrawer } from './CanvasAi.tsx';
import { useStore, type ProjectHost } from '../store.ts';
import { ReferenceChat } from '../references/ReferenceChat.tsx';

const ImportSchema = z.object({ name: z.string().default('Импорт'), nodes: z.array(CanvasNodeSchema), edges: z.array(CanvasEdgeSchema), sections: z.array(CanvasSectionSchema).optional() });

const SAVE_RU = { saved: 'Сохранено на сервере', dirty: 'Ожидает сохранения на сервере', saving: 'Сохраняю…', error: 'Не сохранилось' } as const;

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
        {ui("Создать холст")}</Button>
      <Text variant="caption" tone="tertiary" className={styles.flowsTitle}>
        {ui("Мои холсты")}</Text>
      <nav className={styles.flowList} aria-label={ui("Мои холсты")}>
        {flows.map((f) => (
          <div key={f.id} className={`${styles.flowItem} ${f.production ? styles.productionFlow : ''} ${f.id === flow?.id ? styles.flowItemActive : ''}`}>
            <button type="button" className={styles.flowLabel} aria-current={f.id === flow?.id ? 'page' : undefined} onClick={() => void openFlow(f.id)}>
              <span>{f.name}{f.production && <Text as="span" variant="caption" tone="secondary" className={styles.productionBadge}>{ui("Из производства")}</Text>}</span>
              <Text as="span" variant="caption" tone="tertiary">
                {f.nodes}
              </Text>
            </button>
            <button type="button" className={styles.flowDelete} style={confirmDelete === f.id ? { width: 'auto', opacity: 1 } : undefined} aria-label={ui("Удалить холст «{0}»", f.name)} title={ui("Удалить холст (файлы генераций останутся в библиотеке)")} onClick={() => { if (confirmDelete !== f.id) { setConfirmDelete(f.id); return; } void deleteFlow(f.id).then(() => { setDeleted(f.id); setConfirmDelete(null); }); }}>
              {confirmDelete === f.id ? ui("Удалить?") : <Icon name="bin" size={0.875} />}
            </button>
          </div>
        ))}
      </nav>
      {confirmDelete !== null && <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(null)}>{ui("Отмена удаления")}</Button>}
      {deleted !== null && <Button variant="border" size="s" onClick={() => void restoreFlow(deleted).then(() => setDeleted(null))}>{ui("Восстановить удалённый холст")}</Button>}
      {flows.length === 0 && <Text variant="caption" tone="tertiary" className={styles.flowsTitle}>{ui("Здесь будут твои работы.")}</Text>}
      <details className={styles.sidebarTemplates}>
        <summary>{ui("Шаблоны холстов")}</summary>
        <nav className={styles.flowList} aria-label={ui("Шаблоны холстов")}>
          {FLOW_TEMPLATES.map((t) => (
            <button key={t.id} type="button" className={styles.flowLabel} title={ui(t.descriptionRu)} onClick={() => void newFlow({ name: t.titleRu, ...t.build(newId) })}>
              <span>{ui(t.titleRu)}</span>
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
            {ui(t.titleRu)}
          </Text>
          <Text variant="caption" tone="secondary">
            {ui(t.descriptionRu)}
          </Text>
        </button>
      ))}
    </div>
  );
}

type Interaction = { pointerId: number } & (
  | { type: 'drag'; historyKey: string; startX: number; startY: number; origins: { id: string; x: number; y: number }[] }
  | { type: 'pan'; startX: number; startY: number; origX: number; origY: number }
  | { type: 'link'; from: string; x: number; y: number }
  | { type: 'marquee'; startX: number; startY: number; x: number; y: number; additive: boolean }
);

function editingCanvasText(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

function canvasShortcutsBlocked(target: EventTarget | null): boolean {
  return editingCanvasText(target) || useStore.getState().host !== null
    || document.querySelector('[aria-modal="true"], [role="dialog"][data-state="open"]') !== null;
}

const curve = (x1: number, y1: number, x2: number, y2: number): string => {
  const dx = Math.max(48, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};

/** Server revisions are reviewed before restoring; browsing never changes the flow. */
function FlowHistoryDialog({ flowId, open, onOpenChange }: { flowId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [history, setHistory] = useState<FlowHistoryItem[]>([]);
  const [version, setVersion] = useState<Flow | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    const token = ++request.current;
    if (!open) return;
    setBusy(true); setError(null); setVersion(null); setVersionId(null);
    void useCanvas.getState().loadHistory(flowId).then(items => {
      if (token === request.current) setHistory(items);
    }).catch(() => { if (token === request.current) setError(ui('Не удалось загрузить историю.')); })
      .finally(() => { if (token === request.current) setBusy(false); });
    return () => { request.current += 1; };
  }, [flowId, open]);
  const inspect = async (id: string): Promise<void> => {
    const token = ++request.current;
    setBusy(true); setError(null);
    try {
      const result = await useCanvas.getState().loadHistoryVersion(flowId, id);
      if (token === request.current) { setVersion(result); setVersionId(id); }
    } catch { if (token === request.current) setError(ui('Не удалось загрузить историю.')); }
    finally { if (token === request.current) setBusy(false); }
  };
  const restore = async (): Promise<void> => {
    if (!versionId) return;
    setRestoring(true); setError(null);
    try { if (await useCanvas.getState().restoreHistoryVersion(flowId, versionId)) onOpenChange(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui('Не удалось восстановить версию.')); }
    finally { setRestoring(false); }
  };
  const kind = (item: FlowHistoryItem): string => ui(item.kind === 'legacy' ? 'Прежний черновик' : item.kind === 'recovery' ? 'Неотправленные изменения' : 'Сохранение');
  return <Dialog open={open} onOpenChange={onOpenChange} title={ui('История сохранений')}
    description={ui('Версии и прежние черновики хранятся на сервере. Восстановление заменит содержимое этого холста. Идею, промпт и фото нужно будет одобрить заново.')}
    footer={version ? <><Button variant="ghost" size="s" disabled={restoring} onClick={() => { setVersion(null); setVersionId(null); }}>{ui('К истории')}</Button><Button variant="primary" size="s" disabled={restoring || busy} onClick={() => void restore()}>{ui(restoring ? 'Восстанавливаю…' : 'Восстановить эту версию')}</Button></> : undefined}>
    <div className={styles.nodeBody}>
      {error && <Text tone="secondary">{error}</Text>}
      {busy && <Text tone="tertiary">{ui('Загружаю историю…')}</Text>}
      {!busy && version === null && history.length === 0 && <Text tone="tertiary">{ui('История пока пуста.')}</Text>}
      {version === null ? history.map(item => <div key={item.id} className={styles.nodeBody}>
        <Text medium>{item.name}</Text>
        <Text variant="caption" tone="secondary">{kind(item)} · {ui('Версия {0} · {1} нод', item.rev, item.nodes)} · {new Date(item.createdAt).toLocaleString()}</Text>
        <Button variant="border" size="s" disabled={busy} onClick={() => void inspect(item.id)}>{ui('Посмотреть версию')}</Button>
      </div>) : <>
        <Text medium>{version.name}</Text>
        <Text variant="caption" tone="secondary">{ui('Версия {0} · {1} нод', version.rev ?? 0, version.nodes.length)}</Text>
        {version.nodes.map(node => <div key={node.id} className={styles.nodeBody}>
          <Text variant="label">{nodeTitle(node)}</Text>
          {(node.text || node.ai?.idea?.text) && <Text variant="caption" tone="secondary">{node.text || node.ai?.idea?.text}</Text>}
        </div>)}
      </>}
    </div>
  </Dialog>;
}

/** Canvas — нодовый граф по каркасу connxn. Запуск — только нажатой ноды, цена видна до запуска. */
export function Canvas({ referenceLibraryEnabled = false }: { referenceLibraryEnabled?: boolean }) {
  const { flow, save, selected, selection, selectedSection, error, past, future, newFlow, rename, addNode, patchNode,
    select, selectMany, selectSection, createSection, renameSection, ungroupSection, removeSelected, moveNodes,
    connect, disconnect, setViewport, undo, redo, copySelected, pasteNodes, duplicateSelected } = useCanvas();
  const { library, loadJobs, loadLibrary } = useGen();
  const board = useRef<HTMLDivElement>(null);
  const zoomBar = useRef<HTMLDivElement>(null);
  const toolPalette = useRef<HTMLDivElement>(null);
  const sectionName = useRef<HTMLInputElement>(null);
  const importer = useRef<HTMLInputElement>(null);
  const addMenu = useRef<HTMLDetailsElement>(null);
  const moreMenu = useRef<HTMLDetailsElement>(null);
  /** Связь дошла до входа — меню «в пустоту» не нужно. */
  const linked = useRef(false);
  const spacePan = useRef(false);
  const [linkMenu, setLinkMenu] = useState<{ from: string; screenX: number; screenY: number; x: number; y: number } | null>(null);
  const [act, setAct] = useState<Interaction | null>(null);
  const [tool, setTool] = useState<'cursor' | 'pan'>('cursor');
  const [nodeSizes, setNodeSizes] = useState<{ flowId: string; sizes: Map<string, { width: number; height: number }> }>();
  const [hint, setHint] = useState<string | null>(null);
  const [keyboardFrom, setKeyboardFrom] = useState<string | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);
  const memberIds = flow?.nodes.filter(node => node.sectionId !== undefined).map(node => node.id).join('\n') ?? '';
  const flowId = flow?.id;

  useEffect(() => {
    if (!memberIds || !flowId || !board.current) return;
    const ids = new Set(memberIds.split('\n'));
    const elements = [...board.current.querySelectorAll<HTMLElement>('[data-node-id]')].filter(element => ids.has(element.dataset.nodeId ?? ''));
    const measure = (): void => {
      const sizes = new Map(elements.flatMap(element => element.dataset.nodeId
        ? [[element.dataset.nodeId, { width: element.offsetWidth, height: element.offsetHeight }] as const] : []));
      setNodeSizes(current => current?.flowId === flowId && current.sizes.size === sizes.size
        && [...sizes].every(([id, size]) => current.sizes.get(id)?.width === size.width && current.sizes.get(id)?.height === size.height)
        ? current : { flowId, sizes });
    };
    const observer = new ResizeObserver(measure);
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [flowId, memberIds]);
  const [referencePicker, setReferencePicker] = useState<string | null>(null);
  const pickKind = flow?.nodes.find((n) => n.id === picker)?.type === 'video' ? 'video' : 'image';
  const referenceNode = referenceLibraryEnabled ? flow?.nodes.find(n => n.id === referencePicker && n.type === 'references') : undefined;
  const [consent, setConsent] = useState<{ run: () => void; provider?: string } | null>(null);

  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (addMenu.current !== null && !addMenu.current.contains(event.target as Node)) addMenu.current.open = false;
      if (moreMenu.current !== null && !moreMenu.current.contains(event.target as Node)) moreMenu.current.open = false;
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
    setHistoryOpen(false);
    setPicker(null);
    setReferencePicker(null);
    setConsent(null);
    useCanvas.getState().closeAi();
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
      if (event.pointerId !== act.pointerId) return;
      if (act.type === 'drag') {
        const dx = (event.clientX - act.startX) / viewport.zoom;
        const dy = (event.clientY - act.startY) / viewport.zoom;
        moveNodes(
          act.origins.map((o) => ({ id: o.id, x: o.x + dx, y: o.y + dy })),
          act.historyKey,
        );
      } else if (act.type === 'pan') setViewport({ ...viewport, x: act.origX + event.clientX - act.startX, y: act.origY + event.clientY - act.startY });
      else if (act.type === 'marquee') setAct({ ...act, x: event.clientX, y: event.clientY });
      else setAct({ ...act, ...toWorld(event.clientX, event.clientY) });
    };
    const up = (event: PointerEvent): void => {
      if (event.pointerId !== act.pointerId) return;
      // Hit-test the actual card bounds. Shift preserves the prior selection.
      if (act.type === 'marquee') {
        const left = Math.min(act.startX, event.clientX);
        const right = Math.max(act.startX, event.clientX);
        const top = Math.min(act.startY, event.clientY);
        const bottom = Math.max(act.startY, event.clientY);
        const hit = [...(board.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.left < right && r.right > left && r.top < bottom && r.bottom > top;
          })
          .map((el) => el.dataset.nodeId ?? '');
        const before = act.additive ? useCanvas.getState().selection : [];
        if (right !== left || bottom !== top) selectMany([...new Set([...before, ...hit])]);
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
    const cancel = (event: PointerEvent): void => {
      if (event.pointerId === act.pointerId) { linked.current = false; setAct(null); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
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

  // Canvas keyboard shortcuts leave active editors and dialogs to the browser.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || canvasShortcutsBlocked(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (event.code === 'Space' && !mod && !(event.target instanceof Element && event.target.closest('button, a, summary'))) {
        event.preventDefault();
        spacePan.current = true;
      } else if ((selection.length > 0 || selectedSection !== null) && (key === 'delete' || key === 'backspace')) {
        event.preventDefault();
        removeSelected();
      } else if (mod && key === 'a') {
        event.preventDefault();
        selectMany(useCanvas.getState().flow?.nodes.map((n) => n.id) ?? []);
      } else if (event.key === 'Escape') {
        select(null);
        setAct(null);
      } else if (mod && key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (mod && ((key === 'z' && event.shiftKey) || key === 'y')) {
        event.preventDefault();
        redo();
      } else if (mod && key === 'd') {
        event.preventDefault();
        if (!event.repeat) duplicateSelected();
      }
    };
    const releaseSpace = (event: KeyboardEvent): void => { if (event.code === 'Space') spacePan.current = false; };
    const resetSpace = (): void => { spacePan.current = false; };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', releaseSpace);
    window.addEventListener('blur', resetSpace);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', releaseSpace);
      window.removeEventListener('blur', resetSpace);
    };
  }, [selection, selectedSection, removeSelected, selectMany, select, undo, redo, duplicateSelected]);

  // Вставка: ноды из буфера, картинка → нода картинки, текст → нода промпта. Как в connxn.
  useEffect(() => {
    const onCopy = (event: ClipboardEvent): void => {
      if (canvasShortcutsBlocked(event.target) || window.getSelection()?.isCollapsed === false) return;
      const text = copySelected();
      if (text === null || event.clipboardData === null) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      const state = useCanvas.getState();
      const n = state.selection.length;
      setHint(state.selectedSection !== null ? ui('Секция скопирована') : n > 1
        ? ui("Скопировано блоков: {0}, со связями — ⌘V вставит сюда или на другой холст.", n)
        : ui('Блок скопирован — ⌘V вставит его сюда или на другой холст.'));
    };
    const onPaste = (event: ClipboardEvent): void => {
      if (canvasShortcutsBlocked(event.target) || useCanvas.getState().flow === null) return;
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
      if (text.startsWith(CLIPBOARD_PREFIX)) { pasteNodes(text, at); return; }
      patchNode(addNode('prompt', at.x, at.y), { text }, false);
    };
    window.addEventListener('copy', onCopy);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('paste', onPaste);
    };
  });

  if (flow === null) {
    return (
      <div className={styles.emptyPage}>
        <Text variant="title-m" medium>
          {ui("Вся работа — на одном холсте")}</Text>
        <Text variant="label" tone="secondary">
          {ui("Собери референсы, создавай изображения и видео, дорабатывай результат для клиента.")}</Text>
        <Button variant="primary" size="m" icon={<Icon name="plus" size={1} />} data-guide="canvas-create" onClick={() => void newFlow({ name: 'Новый холст', nodes: [], edges: [] })}>
          {ui("Создать холст")}</Button>
        <Text variant="caption" tone="tertiary">
          {ui("или начни с шаблона")}</Text>
        <TemplateCards />
      </div>
    );
  }

  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
  const portPoint = (node: CanvasNode, port: InputPort): { x: number; y: number } => ({ x: node.x, y: node.y + PORT_TOP + Math.max(0, portsOf(node).indexOf(port)) * PORT_STEP });
  const outPoint = (node: CanvasNode): { x: number; y: number } => ({ x: node.x + NODE_WIDTH[node.type], y: node.y + PORT_TOP });
  const cost = flowCost(flow);
  const activeSection = flow.sections?.find(section => section.id === selectedSection);
  const sectionBounds = new Map<string, { left: number; top: number; right: number; bottom: number }>();
  const sectionPadding = 20;
  for (const node of flow.nodes) {
    if (node.sectionId === undefined) continue;
    const size = nodeSizes?.flowId === flow.id ? nodeSizes.sizes.get(node.id) : undefined;
    const previous = sectionBounds.get(node.sectionId);
    sectionBounds.set(node.sectionId, {
      left: Math.min(previous?.left ?? Infinity, node.x - sectionPadding),
      top: Math.min(previous?.top ?? Infinity, node.y - sectionPadding),
      right: Math.max(previous?.right ?? -Infinity, node.x + (size?.width ?? NODE_WIDTH[node.type]) + sectionPadding),
      bottom: Math.max(previous?.bottom ?? -Infinity, node.y + (size?.height ?? 160) + sectionPadding),
    });
  }

  const startDrag = (event: ReactPointerEvent, nodes: CanvasNode[]): void => {
    setAct({
      type: 'drag', pointerId: event.pointerId, historyKey: newId('move:'),
      startX: event.clientX, startY: event.clientY,
      origins: nodes.map(({ id, x, y }) => ({ id, x, y })),
    });
  };
  const startPan = (event: ReactPointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    setAct({ type: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origX: viewport.x, origY: viewport.y });
  };

  // Shift+клик по шапке — добавить в выделение или убрать; протяжка выделенной ноды двигает всю группу.
  const onHeaderDown = (event: ReactPointerEvent, node: CanvasNode): void => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.stopPropagation();
    if (event.shiftKey) {
      select(node.id, true);
      return;
    }
    const inGroup = selection.includes(node.id) && selection.length > 1;
    if (!inGroup) select(node.id);
    startDrag(event, inGroup ? flow.nodes.filter(n => selection.includes(n.id)) : [node]);
  };
  const onOutputDown = (event: ReactPointerEvent, node: CanvasNode): void => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.stopPropagation();
    setAct({ type: 'link', pointerId: event.pointerId, from: node.id, ...toWorld(event.clientX, event.clientY) });
  };
  const onInputUp = (node: CanvasNode, port: InputPort): void => {
    if (act?.type !== 'link') return;
    linked.current = true;
    const from = nodeById.get(act.from);
    setAct(null);
    if (from === undefined) return;
    if (!portAccepts(port, outputOf(from))) {
      setHint(port === 'context' || port === 'libraryRefs' ? 'Несовместимые порты.' : port === 'prompt' ? 'Во вход «Промпт» подключается блок с текстом промпта.' : port === 'video' ? 'Во вход «Видео» подключается видео: генератор, своё видео или обрезка.' : port === 'media' ? 'Во вход «Файл» подключается изображение или видео.' : 'Во вход изображения подключается изображение, стоп-кадр или генератор изображения.');
      return;
    }
    const problem = connect(from.id, node.id, port);
    setHint(problem);
  };

  /** Что можно создать на конце связи, отпущенной в пустоту, — по типу выхода. */
  const linkOptions = (fromId: string): { label: string; type: CanvasNode['type']; kind: 'image' | 'video'; port: InputPort }[] => {
    const from = nodeById.get(fromId);
    if (from === undefined) return [];
    const out = outputOf(from);
    if (out === 'context') return [
      { label: 'Разработать идею с AI', type: 'ai', kind: 'image', port: 'context' },
      ...(referenceLibraryEnabled ? [{ label: 'Подобрать референсы', type: 'references', kind: 'image', port: 'context' } as const] : []),
    ];
    if (out === 'libraryRefs') return [{ label: 'Разработать идею с AI', type: 'ai', kind: 'image', port: 'libraryRefs' }];
    if (out === 'idea') return [{ label: 'Подготовить промпт с AI', type: 'prompt', kind: from.kind, port: 'idea' }];
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
      { label: 'Обсудить изображение с AI', type: 'ai', kind: 'image', port: 'ref' },
      { label: 'Создать изображение по референсу', type: 'generator', kind: 'image', port: 'ref' },
      { label: 'Оживить изображение', type: 'generator', kind: 'video', port: 'start' },
      { label: 'Добавить в Seedance-промптер', type: 'seedance', kind: 'image', port: 'ref' },
      { label: 'Размер под площадку', type: 'resize', kind: 'image', port: 'media' },
      { label: 'Апскейл Topaz', type: 'upscale', kind: 'image', port: 'media' },
    ];
  };
  const createLinked = (opt: ReturnType<typeof linkOptions>[number]): void => {
    if (linkMenu === null) return;
    if (opt.port === 'idea') {
      const id = useCanvas.getState().addAiPrompt(linkMenu.from);
      if (id) { useCanvas.getState().focusNode(id); useCanvas.getState().openAi(linkMenu.from, 'prompt'); }
      setLinkMenu(null); return;
    }
    const id = addNode(opt.type, linkMenu.x, linkMenu.y - PORT_TOP, opt.kind);
    // Порт «Старт» у генератора видео — второй вход, а модель по умолчанию его поддерживает (Kling / Seedance).
    setHint(connect(linkMenu.from, id, opt.port));
    setLinkMenu(null);
  };

  const fit = (): void => {
    const rect = board.current?.getBoundingClientRect();
    if (rect === undefined || flow.nodes.length === 0) return setViewport({ x: 0, y: 0, zoom: 1 });
    const bounds = [...sectionBounds.values()];
    const minX = Math.min(...flow.nodes.map((n) => n.x), ...bounds.map(section => section.left));
    const minY = Math.min(...flow.nodes.map((n) => n.y), ...bounds.map(section => section.top - 36));
    const maxX = Math.max(...flow.nodes.map((n) => n.x + NODE_WIDTH[n.type]), ...bounds.map(section => section.right));
    const heights = new Map([...(board.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])].map((el) => [el.dataset.nodeId, el.offsetHeight]));
    const maxY = Math.max(...flow.nodes.map((n) => n.y + (heights.get(n.id) ?? 360)), ...bounds.map(section => section.bottom));
    const top = Math.max(0, (toolPalette.current?.getBoundingClientRect().bottom ?? rect.top) - rect.top);
    const height = Math.max(1, (zoomBar.current?.getBoundingClientRect().top ?? rect.bottom) - rect.top - top);
    const zoom = Math.min(1, Math.max(0.1, Math.min(rect.width / (maxX - minX + 96), height / (maxY - minY + 96))));
    setViewport({ zoom, x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: top + (height - (maxY - minY) * zoom) / 2 - minY * zoom });
  };

  const exportFlow = (): void => {
    const blob = new Blob([JSON.stringify({ name: flow.name, nodes: flow.nodes, edges: flow.edges, sections: flow.sections }, null, 1)], { type: 'application/json' });
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
      const { ids: sectionIds, sections } = remapCanvasSections(parsed.sections);
      const nodes = parsed.nodes.map(n => remapCanvasCopy(n, ids, sectionIds));
      const edges = parsed.edges.flatMap((e) => {
        const from = ids.get(e.from);
        const to = ids.get(e.to);
        return from === undefined || to === undefined ? [] : [{ ...e, id: newId('e'), from, to }];
      });
      await newFlow({ name: parsed.name, nodes, edges, sections: sections.length > 0 ? sections : undefined });
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

  const addAiPromptBlock = (aiId?: string): void => {
    const chosen = aiId ?? flow.nodes.find(n => n.id === selected && n.type === 'ai')?.id;
    if (!chosen) return;
    const id = useCanvas.getState().addAiPrompt(chosen);
    if (id) { useCanvas.getState().focusNode(id); useCanvas.getState().openAi(chosen, 'prompt'); }
    if (addMenu.current) addMenu.current.open = false;
  };

  const linkFrom = act?.type === 'link' ? nodeById.get(act.from) : undefined;

  return (
    <div className={styles.canvas}>
      <header className={styles.head}>
        <div className={styles.flowIdentity} data-guide="canvas-save">
          <input className={styles.name} value={flow.name} onChange={(event) => rename(event.target.value)} aria-label={ui("Название холста")} />
          <Text variant="caption" tone={save === 'error' ? 'primary' : 'tertiary'}>
            {ui(SAVE_RU[save])}{error !== null ? ` · ${error}` : ''}
          </Text>
        </div>
        {save === 'error' && <Button variant="border" size="xs" onClick={() => void useCanvas.getState().retrySave().catch(() => undefined)}>{ui("Повторить сохранение")}</Button>}
        <span className={styles.grow} />
        <details
          ref={moreMenu}
          className={styles.moreMenu}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }}
        >
          <summary className={styles.moreTrigger}>{ui("Ещё")}</summary>
          <div className={styles.morePanel}>
            <Button variant="ghost" size="xs" onClick={() => { if (moreMenu.current) { moreMenu.current.open = false; moreMenu.current.querySelector('summary')?.focus(); } setHistoryOpen(true); }}>{ui('История сохранений')}</Button>
            <Button variant="ghost" size="xs" onClick={() => setConnectionsOpen(true)}>{ui("Связи (")}{flow.edges.length})</Button>
            <Button variant="ghost" size="xs" data-guide="canvas-export" icon={<Icon name="download" size={0.875} />} onClick={exportFlow} title={ui("Скачать схему холста в JSON. Медиафайлы скачиваются из результата.")}>{ui("Сохранить схему")}</Button>
            <Button variant="ghost" size="xs" icon={<Icon name="upload" size={0.875} />} onClick={() => importer.current?.click()} title={ui("Открыть сохранённую схему холста из JSON")}>{ui("Открыть схему")}</Button>
          </div>
        </details>
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
          <summary className={styles.addTrigger}><Icon name="plus" size={1} />{ui("Добавить")}</summary>
          <div className={styles.addPanel}>
            <div className={styles.addGroup} role="group" aria-label={ui("Материал")}>
              <Text variant="caption" tone="tertiary">{ui("Материал")}</Text>
              <button type="button" onClick={() => addBlock('image')}><Icon name="image" size={1} />{ui("Изображение")}</button>
              <button type="button" onClick={() => addBlock('video')}><Icon name="video" size={1} />{ui("Видео")}</button>
              <button type="button" onClick={() => addBlock('comment')}><Icon name="pencil" size={1} />{ui('Комментарий')}</button>
              {referenceLibraryEnabled && <button type="button" onClick={() => addBlock('references')}><Icon name="images" size={1} />{ui('Библиотека референсов')}</button>}
            </div>
            <div className={styles.addGroup} role="group" aria-label={ui("Создать")}>
              <Text variant="caption" tone="tertiary">{ui("Создать")}</Text>
              <button type="button" onClick={() => addBlock('ai')}><Icon name="sparkles" size={1} />{ui('AI · идея')}</button>
              <details className={styles.promptMenu}><summary>{ui('AI · промпт')}</summary>{flow.nodes.some(n => n.type === 'ai') ? flow.nodes.filter(n => n.type === 'ai').map(n => <button key={n.id} type="button" onClick={() => addAiPromptBlock(n.id)}>{ui('Из идеи: {0}', n.label || n.id.slice(-5))}</button>) : <Text variant="caption" tone="secondary">{ui('Сначала добавь ноду AI · идея.')}</Text>}</details>
              <button type="button" onClick={() => addBlock('generator', 'image')}><Icon name="sparkles" size={1} />{ui("Изображение")}</button>
              <button type="button" onClick={() => addBlock('generator', 'video')}><Icon name="video" size={1} />{ui("Видео")}</button>
              <button type="button" onClick={() => addBlock('seedance')}><Icon name="options" size={1} />{ui("Seedance-промптер")}</button>
              <button type="button" onClick={() => addBlock('prompt')}><Icon name="pencil" size={1} />{ui("Текст промпта")}</button>
            </div>
            <div className={styles.addGroup} role="group" aria-label={ui("Обработать")}>
              <Text variant="caption" tone="tertiary">{ui("Обработать")}</Text>
              <button type="button" onClick={() => addBlock('frame')}><Icon name="layers" size={1} />{ui("Стоп-кадр")}</button>
              <button type="button" onClick={() => addBlock('trim')}><Icon name="time" size={1} />{ui("Обрезка видео")}</button>
              <button type="button" onClick={() => addBlock('resize')}><Icon name="apps" size={1} />{ui("Размер под площадку")}</button>
              <button type="button" onClick={() => addBlock('upscale')}><Icon name="push" size={1} />{ui("Апскейл Topaz")}</button>
            </div>
          </div>
        </details>
      </header>
      {flow.production && <SeriesFlow key={flow.id} flow={flow} />}
      <div
        ref={board}
        className={`${styles.board} ${tool === 'pan' ? styles.boardPan : ''} ${act?.type === 'pan' ? styles.boardPanning : ''}`}
        data-guide="canvas-board"
        style={{ backgroundPosition: `${viewport.x}px ${viewport.y}px`, backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px` }}
        onPointerDownCapture={event => {
          if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
          const target = event.target as Element;
          if (sectionName.current === document.activeElement && target !== sectionName.current) sectionName.current?.blur();
          if (target.closest('[data-canvas-tools]') || zoomBar.current?.contains(target)) return;
          if (event.button === 1 || spacePan.current || (tool === 'pan' && (target === event.currentTarget || target.closest(`.${styles.nodeHead}, .${styles.sectionHeading}`)))) {
            startPan(event);
          }
        }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget || event.button !== 0 || !event.isPrimary) return;
          if (!event.shiftKey) select(null);
          setAct({ type: 'marquee', pointerId: event.pointerId, additive: event.shiftKey, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY });
        }}
        onDoubleClick={(event) => {
          if (event.target !== event.currentTarget || tool === 'pan' || spacePan.current) return;
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
          {flow.sections?.map(section => {
            const bounds = sectionBounds.get(section.id);
            if (!bounds) return null;
            const isSelected = selectedSection === section.id;
            return (
              <div key={section.id} data-section-id={section.id} data-selected={isSelected}
                className={styles.sectionFrame}
                style={{ left: bounds.left, top: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }}>
                <button type="button" className={styles.sectionHeading} aria-pressed={isSelected} title={section.title}
                  onClick={() => selectSection(section.id)}
                  onPointerDown={event => {
                    if (event.button !== 0 || !event.isPrimary) return;
                    event.stopPropagation();
                    selectSection(section.id);
                    startDrag(event, flow.nodes.filter(node => node.sectionId === section.id));
                  }}>
                  <Icon name="group" size={0.875} />
                  <span>{section.title}</span>
                </button>
              </div>
            );
          })}
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
                  <title>{ui("Клик — убрать связь")}</title>
                  <path d={d} className={styles.edgeHit} />
                  <path d={d} className={edge.port === 'prompt' ? styles.edgeText : styles.edgeMedia} />
                </g>
              );
            })}
            {linkFrom !== undefined && act?.type === 'link' && <path d={curve(outPoint(linkFrom).x, outPoint(linkFrom).y, act.x, act.y)} className={styles.edgeDraft} />}
          </svg>
          {flow.nodes.map((node) => (
            <NodeView key={`${flow.id}:${node.id}`} node={node} selected={selection.includes(node.id)} onHeaderDown={onHeaderDown} onOutputDown={onOutputDown} onInputUp={onInputUp} keyboardSource={keyboardFrom === node.id} onKeyboardOutput={() => { setKeyboardFrom(node.id); setHint('Выход выбран. Нажми Tab до нужного входа и Enter; Escape — отмена.'); }} onKeyboardInput={(port) => { if (keyboardFrom !== null) { setHint(connect(keyboardFrom, node.id, port) ?? 'Связь создана.'); setKeyboardFrom(null); } else setHint('Сначала выбери выход исходной ноды.'); }} onPickFromLibrary={setPicker} onOpenReferences={referenceLibraryEnabled ? setReferencePicker : undefined} onNeedConsent={(runIt, provider) => setConsent({ run: runIt, provider })} />
          ))}
        </div>

        {flow.nodes.length === 0 && (
          <div className={styles.emptyBoard}>
            <Text variant="title-m" medium>
              {ui("С чего начнём?")}</Text>
            <Text variant="label" tone="secondary">
              {ui("Добавь блок или перетащи изображение или видео на холст.")}</Text>
            <div className={styles.emptyActions}>
              <Button variant="primary" size="s" icon={<Icon name="plus" size={1} />} onClick={() => {
                if (addMenu.current === null) return;
                addMenu.current.open = true;
                addMenu.current.querySelector('summary')?.focus();
              }}>
                {ui("Добавить блок")}</Button>
            </div>
            <Text variant="caption" tone="tertiary">
              {ui("Или выбери шаблон — откроется на новом холсте")}</Text>
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
        <div ref={toolPalette} className={styles.canvasTools} role="group" aria-label={ui('Инструменты холста')} data-canvas-tools>
          <div className={styles.toolRow}>
            <Button variant="ghost" size="xs" aria-pressed={tool === 'cursor'} onClick={() => setTool('cursor')}>{ui('Курсор')}</Button>
            <Button variant="ghost" size="xs" aria-pressed={tool === 'pan'} onClick={() => setTool('pan')}>{ui('Перемещение холста')}</Button>
            <Button variant="ghost" size="xs" icon={<Icon name="group" size={0.875} />} disabled={selection.length === 0}
              onClick={() => createSection(ui('Секция {0}', (flow.sections?.length ?? 0) + 1))}>{ui('Создать секцию')}</Button>
          </div>
          {(flow.sections?.length ?? 0) > 0 && <div className={styles.toolRow} data-inactive={activeSection === undefined} inert={activeSection === undefined}>
            <input ref={sectionName} key={activeSection ? `${activeSection.id}:${activeSection.title}` : 'untitled'} className={styles.sectionName} maxLength={120}
              aria-label={ui('Название секции')} defaultValue={activeSection?.title ?? ''}
              onBlur={event => {
                if (!activeSection) return;
                const title = event.currentTarget.value.trim() || activeSection.title;
                event.currentTarget.value = title;
                renameSection(activeSection.id, title);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                if (event.key === 'Escape' && activeSection) { event.stopPropagation(); event.currentTarget.value = activeSection.title; event.currentTarget.blur(); }
              }} />
            <Button variant="ghost" size="xs" onClick={() => activeSection && ungroupSection(activeSection.id)}>{ui('Разгруппировать секцию')}</Button>
          </div>}
        </div>
        {linkMenu !== null && (
          <div className={styles.linkMenu} style={{ left: linkMenu.screenX - (board.current?.getBoundingClientRect().left ?? 0), top: linkMenu.screenY - (board.current?.getBoundingClientRect().top ?? 0) }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
            <Text variant="caption" tone="tertiary" className={styles.linkMenuTitle}>
              {ui("Добавить и соединить")}</Text>
            {linkOptions(linkMenu.from).map((opt) => (
              <button key={opt.label} type="button" role="menuitem" onClick={() => createLinked(opt)}>
                <Icon name={opt.type === 'frame' ? 'layers' : opt.type === 'trim' ? 'time' : opt.type === 'resize' ? 'apps' : opt.type === 'seedance' ? 'options' : opt.type === 'upscale' ? 'push' : opt.kind === 'video' ? 'video' : 'sparkles'} size={0.875} />
                {opt.label}
              </button>
            ))}
            <button type="button" role="menuitem" onClick={() => setLinkMenu(null)}>
              <Icon name="close" size={0.875} />
              {ui("Отмена")}</button>
          </div>
        )}
        {hint !== null && (
          <button type="button" className={styles.hint} aria-live="polite" onClick={() => setHint(null)}>
            <Text variant="caption">{hint}</Text>
            <Icon name="close" size={0.75} />
          </button>
        )}
        {/* Плавающая группа: история, масштаб и оценка генераций. */}
        <div className={styles.zoom} ref={zoomBar}>
          {cost.unquoted > 0 && <Text variant="caption" tone="secondary">{ui("Seedance: цена перед запуском · ")}{cost.unquoted}</Text>}
          {cost.usd > 0 && (
            <span className={styles.cost} title={ui("Оценка одного запуска каждого генератора. Каждый блок запускается отдельно, с ценой на кнопке.")}>
              <Text as="span" variant="caption" tone="secondary">
                {ui("Генерации ≈ $")}{cost.usd}
                {cost.credits > 0 ? ui(" · {0} кр", cost.credits) : ''}
              </Text>
            </span>
          )}
          <button type="button" onClick={undo} disabled={past.length === 0} aria-label={ui("Отменить (⌘Z)")} title={ui("Отменить (⌘Z)")}>
            <Icon name="arrow-undo" size={0.875} />
          </button>
          <button type="button" onClick={redo} disabled={future.length === 0} aria-label={ui("Повторить (⇧⌘Z)")} title={ui("Повторить (⇧⌘Z)")}>
            <Icon name="arrow-redo" size={0.875} />
          </button>
          <button type="button" onClick={fit} title={ui("Показать все блоки")}>
            <Text as="span" variant="caption">
              {ui("Вписать")}</Text>
          </button>
          <button type="button" onClick={() => setViewport({ ...viewport, zoom: Math.max(0.3, viewport.zoom - 0.1) })} aria-label={ui("Уменьшить")}>
            <Icon name="minus" size={0.875} />
          </button>
          <Text as="span" variant="caption" tone="secondary" mono>
            {Math.round(viewport.zoom * 100)}%
          </Text>
          <button type="button" onClick={() => setViewport({ ...viewport, zoom: Math.min(2, viewport.zoom + 0.1) })} aria-label={ui("Увеличить")}>
            <Icon name="plus" size={0.875} />
          </button>
        </div>
      </div>

      <FlowHistoryDialog flowId={flow.id} open={historyOpen} onOpenChange={setHistoryOpen} />
      <Dialog open={connectionsOpen} onOpenChange={setConnectionsOpen} title={ui("Связи холста")} description={ui("Клавиатура: выбери выход ноды, затем нужный вход. Здесь можно удалить связь.")}>
        {flow.edges.length === 0 && <Text>{ui("Связей пока нет.")}</Text>}
        {flow.edges.map((edge) => <div key={edge.id}><Text>{nodeTitle(nodeById.get(edge.from)!)} → {nodeTitle(nodeById.get(edge.to)!)} · {ui(PORT_RU[edge.port])}</Text><Button variant="border" size="s" onClick={() => disconnect(edge.id)}>{ui("Удалить связь")}</Button></div>)}
      </Dialog>
      <Dialog open={referenceNode !== undefined} onOpenChange={open => { if (!open) setReferencePicker(null); }} title={ui('Подобрать референсы')} size="l">
        {referenceNode && <ReferenceChat
          key={`${flow.id}~${referenceNode.id}`}
          threadKey={`${flow.id}~${referenceNode.id}`}
          initialBrief={referenceComments(flow, referenceNode.id).map(comment => comment.text).join('\n\n')}
          selection={referenceNode.libraryRefs ?? []}
          onApply={async selection => {
            const current = useCanvas.getState();
            if (current.flow?.id !== flow.id || !current.flow.nodes.some(node => node.id === referenceNode.id)) {
              throw new Error(ui('Холст изменился. Открой подборку заново.'));
            }
            current.patchNode(referenceNode.id, { libraryRefs: selection });
            if (!await current.flush()) throw new Error(ui('Сначала сохрани изменения холста.'));
          }}
        />}
      </Dialog>
      <Dialog open={picker !== null} onOpenChange={(open) => !open && setPicker(null)} size="l" title={pickKind === 'video' ? ui("Видео из библиотеки") : ui("Картинка из библиотеки")} description={ui("Выбери файл для этого блока. Свои файлы можно добавить в блоке кнопкой «С диска».")}>
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
              {pickKind === 'video' ? ui("В библиотеке пока нет видео.") : ui("В библиотеке пока нет картинок.")}
            </Text>
          )}
        </div>
      </Dialog>

      <Dialog
        open={consent !== null}
        onOpenChange={(open) => !open && setConsent(null)}
        title={ui("Отправить картинки провайдеру?")}
        description={consent?.provider === 'higgsfield' ? ui('Изображения этого блока уйдут в Higgsfield и исполнителю выбранной модели. Если на них есть лицо, оно тоже уйдёт. Согласие действует до закрытия вкладки.') : ui("Изображения этого блока уйдут в KIE, а оттуда — исполнителю модели (fal / replicate). Если на них есть лицо, оно тоже уйдёт. Согласие действует до закрытия вкладки.")}
        footer={
          <>
            <Button variant="ghost" size="s" onClick={() => setConsent(null)}>
              {ui("Отмена")}</Button>
            <Button
              variant="primary"
              size="s"
              onClick={() => {
                consent?.run();
                setConsent(null);
              }}
            >
              {ui("Отправить и запустить")}</Button>
          </>
        }
      >
        <Text variant="label" tone="secondary">
          {ui("Запустится только этот блок.")}</Text>
      </Dialog>
      <CanvasAiDrawer />
    </div>
  );
}
