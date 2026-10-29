import { ui } from '../language.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MediaKind } from '../../core/gen/models.ts';
import { isCanvasDraft } from '../../core/model/canvas.ts';
import { ThemeSwitch } from '../features/ThemeSwitch.tsx';
import { LanguageSwitch } from '../features/LanguageSwitch.tsx';
import { useLanguage } from '../language.ts';
import { useGen } from '../gen/genStore.ts';
import { GenerationStatus } from '../gen/GenerationStatus.tsx';
import { usePrompter } from '../prompter/prompterStore.ts';
import { useStore } from '../store.ts';
import { Button, Icon, Text } from '../ui/components/index.ts';
import styles from './AppShell.module.css';
import { PRIMARY_ROUTES, ROUTE_EN, ROUTE_HINT, ROUTE_HINT_EN, ROUTE_RU, TOOL_ROUTES, type Route } from './route.ts';
import { CreatorGuide } from './CreatorGuide.tsx';
import { ChatgptConnection } from './ChatgptConnection.tsx';

const SIDEBAR_KEY = 'sp-sidebar';

function readCollapsed(): boolean {
  try {
    return window.matchMedia('(max-width: 768px)').matches || localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/** Список сессий студии в сайдбаре: закрепить, переименовать двойным кликом, удалить (файлы остаются). */
function SessionList({ kind }: { kind: MediaKind }) {
  const [language] = useLanguage();
  const english = language === 'en';
  const { sessions, activeSession, loadSessions, newSession, selectSession, renameSession, pinSession, deleteSession } = useGen();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void loadSessions(kind);
  }, [kind, loadSessions]);

  return (
    <>
      <Button variant="border" size="s" icon={<Icon name="plus" size={1} />} className={styles.newButton} onClick={() => void newSession(kind)}>
        {english ? 'New collection' : ui("Новая подборка")}
      </Button>
      <Text variant="caption" tone="tertiary" className={styles.listTitle}>
        {english ? 'Recent' : ui("Недавние")}
      </Text>
      <nav className={styles.list}>
        {sessions[kind].length === 0 && (
          <Text variant="caption" tone="tertiary" className={styles.listEmpty}>
            {english ? 'Generation history is saved here. You can split it into collections.' : ui("Здесь сохраняется история генераций. Можно разделить её на подборки.")}
          </Text>
        )}
        {sessions[kind].map((session) => (
          <div key={session.id} className={`${styles.item} ${session.id === activeSession[kind] ? styles.itemActive : ''}`}>
            {editing === session.id ? (
              <input
                className={styles.rename}
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => {
                  setEditing(null);
                  if (draft.trim() !== '' && draft !== session.title) void renameSession(session.id, draft);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <button
                type="button"
                className={styles.itemLabel}
                title={english ? 'Double-click to rename' : ui("Двойной клик — переименовать")}
                onClick={() => selectSession(kind, session.id)}
                onDoubleClick={() => {
                  setDraft(session.title);
                  setEditing(session.id);
                }}
              >
                {session.pinned && <Icon name="pin" size={0.875} />}
                <span>{session.title}</span>
              </button>
            )}
            <span className={styles.itemActions}>
              <button type="button" className={styles.iconButton} title={session.pinned ? (english ? 'Unpin' : ui("Открепить")) : (english ? 'Pin' : ui("Закрепить"))} onClick={() => void pinSession(session.id, !session.pinned)}>
                <Icon name="pin" size={0.875} />
              </button>
              <button type="button" className={styles.iconButton} title={english ? 'Delete collection (files stay in Assets)' : ui("Удалить сессию (файлы останутся в библиотеке)")} onClick={() => void deleteSession(kind, session.id)}>
                <Icon name="bin" size={0.875} />
              </button>
            </span>
          </div>
        ))}
      </nav>
    </>
  );
}

/** История промптера: последние 20 попыток, клик — открыть, корзина — забыть. */
function PrompterHistory() {
  const [language] = useLanguage();
  const english = language === 'en';
  const { history, currentId, open, remove } = usePrompter();
  return (
    <>
      <Text variant="caption" tone="tertiary" className={styles.listTitle}>
        {english ? 'History' : ui("История")}
      </Text>
      <nav className={styles.list}>
        {history.length === 0 && (
          <Text variant="caption" tone="tertiary" className={styles.listEmpty}>
            {english ? 'Previous prompts will appear here.' : ui("Здесь будут прошлые промпты.")}
          </Text>
        )}
        {history.map((entry) => (
          <div key={entry.id} className={`${styles.item} ${entry.id === currentId ? styles.itemActive : ''}`}>
            <button type="button" className={styles.itemLabel} title={entry.commentRu !== '' ? ui("Правка: {0}", entry.commentRu) : entry.ideaRu} onClick={() => open(entry.id)}>
              {entry.commentRu !== '' && <Icon name="arrow-redo" size={0.875} />}
              <span>{entry.ideaRu}</span>
            </button>
            <span className={styles.itemActions}>
              <button type="button" className={styles.iconButton} title={english ? 'Remove from history' : ui("Убрать из истории")} onClick={() => remove(entry.id)}>
                <Icon name="bin" size={0.875} />
              </button>
            </span>
          </div>
        ))}
      </nav>
    </>
  );
}

function ProjectList() {
  const [language] = useLanguage();
  const { projects, loadProjects, openProject } = useStore();
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);
  return (
    <>
      <Text variant="caption" tone="tertiary" className={styles.listTitle}>
        {language === 'en' ? 'Projects' : ui("Ролики")}
      </Text>
      <nav className={styles.list}>
        {/* Черновики Seedance-промптеров живут в своих нодах canvas — здесь только ролики «Кадров». */}
        {projects.filter((project) => !isCanvasDraft(project.slug)).map((project) => (
          <div key={project.slug} className={styles.item}>
            <button type="button" className={styles.itemLabel} onClick={() => void openProject(project.slug)}>
              <span>{project.title}</span>
            </button>
          </div>
        ))}
      </nav>
    </>
  );
}

const PROVIDERS = [
  { id: 'kie', title: 'KIE', balanceable: true },
  { id: 'higgsfield', title: 'Higgsfield API', balanceable: false },
] as const;

/** Карточки внизу сайдбара: есть ли ключ провайдера; баланс KIE — по клику, это запрос наружу. */
function ProviderCards() {
  const [language] = useLanguage();
  const english = language === 'en';
  const { status, loadStatus } = useGen();
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  return (
    <div className={styles.providers}>
      {PROVIDERS.map((p) => {
        const s = status[p.id];
        const line = s === undefined ? (english ? 'checking…' : ui("проверяю…")) : !s.hasKey ? (s.keyProblem ?? (english ? 'no key in storage' : ui("нет ключа в хранилище"))) : s.balance !== undefined ? `${s.balance.toLocaleString(english ? 'en-US' : 'ru-RU')} ${english ? 'credits' : ui("кр")}` : (s.balanceError ?? (p.balanceable ? (english ? 'balance on click' : ui("баланс — по клику")) : (english ? 'key available' : ui("ключ есть"))));
        return (
          <button key={p.id} type="button" className={styles.provider} onClick={() => p.balanceable && void loadStatus(true)} title={p.balanceable ? (english ? 'Refresh balance' : ui("Обновить баланс")) : undefined}>
            <span className={`${styles.dot} ${s?.hasKey === true ? styles.dotOn : ''}`} />
            <span className={styles.providerText}>
              <Text variant="label" medium>
                {p.title}
              </Text>
              <Text variant="caption" tone="secondary">
                {line}
              </Text>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AppShell({ route, onRoute, sidebar, children }: { route: Route; onRoute: (r: Route) => void; sidebar?: ReactNode; children: ReactNode }) {
  const [language] = useLanguage();
  const english = language === 'en';
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)');
    const adapt = (): void => { if (media.matches) setCollapsed(true); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && media.matches) setCollapsed(true); };
    media.addEventListener('change', adapt);
    window.addEventListener('keydown', escape);
    return () => { media.removeEventListener('change', adapt); window.removeEventListener('keydown', escape); };
  }, []);
  const toolsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !toolsRef.current?.contains(event.target) && toolsRef.current) toolsRef.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const toggle = (): void => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? 'open' : 'collapsed');
      } catch {
        /* не запомним — не страшно */
      }
      return !c;
    });
  };

  return (
    <div className={`${styles.shell} ${collapsed ? styles.collapsed : ''}`}>
      {!collapsed && <button className={styles.sidebarBackdrop} type="button" aria-label={english ? 'Close project list' : ui("Закрыть список работ")} onClick={() => setCollapsed(true)} />}
      <aside className={styles.sidebar} aria-hidden={collapsed}>
        <div className={styles.brand}>
          <span className={styles.logo}>
            <Icon name="sparkles" size={1.25} />
          </span>
          <Text variant="title-s" medium>
            {english ? 'Studio' : ui("Студия")}
          </Text>
          <button type="button" className={styles.iconButton} onClick={toggle} title={english ? 'Collapse sidebar' : ui("Свернуть сайдбар")}>
            <Icon name="chevron-back" size={1} />
          </button>
        </div>
        <div className={styles.sidebarBody}>
          {sidebar ?? (route === 'images' ? <SessionList kind="image" /> : route === 'video' ? <SessionList kind="video" /> : route === 'shots' ? <ProjectList /> : route === 'prompter' ? <PrompterHistory /> : null)}
        </div>
        <div className={styles.sidebarFoot}>
          <details className={styles.connections} data-guide="connections">
            <summary>{english ? 'Connections' : ui("Подключения")}</summary>
            <ProviderCards />
          </details>
          <div className={styles.preferences}><LanguageSwitch /><ThemeSwitch /></div>
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          {collapsed && (
            <button type="button" className={styles.iconButton} onClick={toggle} title={english ? 'Show sidebar' : ui("Показать сайдбар")}>
              <Icon name="chevron-forward" size={1} />
            </button>
          )}
          <nav className={styles.tabs} aria-label={english ? 'Studio sections' : ui("Разделы студии")}>
            {PRIMARY_ROUTES.map((r) => (
              <button key={r} type="button" data-guide={`nav-${r}`} aria-current={r === route ? 'page' : undefined} title={(english ? ROUTE_HINT_EN : ROUTE_HINT)[r]} className={`${styles.tab} ${r === route ? styles.tabActive : ''}`} onClick={() => onRoute(r)}>
                {(english ? ROUTE_EN : ROUTE_RU)[r]}
              </button>
            ))}
          </nav>
          <details ref={toolsRef} className={styles.tools} data-guide="nav-tools" onKeyDown={(event) => {
            if (event.key === 'Escape' && toolsRef.current) { toolsRef.current.open = false; toolsRef.current.querySelector('summary')?.focus(); }
          }} onBlur={(event) => { if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
            <summary className={`${styles.tab} ${TOOL_ROUTES.includes(route) ? styles.tabActive : ''}`}>
              {TOOL_ROUTES.includes(route) ? (english ? ROUTE_EN : ROUTE_RU)[route] : english ? 'Tools' : ui("Инструменты")} <Icon name="chevron-down" size={0.875} />
            </summary>
            <nav className={styles.toolMenu} aria-label={english ? 'Tools' : ui("Инструменты")}>
              {TOOL_ROUTES.map((r) => <button key={r} type="button" className={styles.toolItem} aria-current={r === route ? 'page' : undefined} onClick={() => { onRoute(r); if (toolsRef.current) toolsRef.current.open = false; }}>
                <Text as="span" variant="label" medium>{(english ? ROUTE_EN : ROUTE_RU)[r]}</Text>
                <Text as="span" variant="caption" tone="secondary">{(english ? ROUTE_HINT_EN : ROUTE_HINT)[r]}</Text>
              </button>)}
            </nav>
          </details>
          <div className={styles.help}><ChatgptConnection /><CreatorGuide route={route} onRoute={onRoute} /></div>
        </header>
        <GenerationStatus onOpen={() => useGen.getState().openTasks()} />
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
