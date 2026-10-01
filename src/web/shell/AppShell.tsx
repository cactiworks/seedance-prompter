import { useEffect, useState, type ReactNode } from 'react';
import type { MediaKind } from '../../core/gen/models.ts';
import { isCanvasDraft } from '../../core/model/canvas.ts';
import { ThemeSwitch } from '../features/ThemeSwitch.tsx';
import { useGen } from '../gen/genStore.ts';
import { usePrompter } from '../prompter/prompterStore.ts';
import { useStore } from '../store.ts';
import { Button, Icon, Text } from '../ui/components/index.ts';
import styles from './AppShell.module.css';
import { ROUTE_RU, ROUTES, type Route } from './route.ts';

const SIDEBAR_KEY = 'sp-sidebar';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/** Список сессий студии в сайдбаре: закрепить, переименовать двойным кликом, удалить (файлы остаются). */
function SessionList({ kind }: { kind: MediaKind }) {
  const { sessions, activeSession, loadSessions, newSession, selectSession, renameSession, pinSession, deleteSession } = useGen();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void loadSessions(kind);
  }, [kind, loadSessions]);

  return (
    <>
      <Button variant="border" size="s" icon={<Icon name="plus" size={1} />} className={styles.newButton} onClick={() => void newSession(kind)}>
        Новая сессия
      </Button>
      <Text variant="caption" tone="tertiary" className={styles.listTitle}>
        Недавние
      </Text>
      <nav className={styles.list}>
        {sessions[kind].length === 0 && (
          <Text variant="caption" tone="tertiary" className={styles.listEmpty}>
            Сессия создастся сама при первой генерации.
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
                title="Двойной клик — переименовать"
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
              <button type="button" className={styles.iconButton} title={session.pinned ? 'Открепить' : 'Закрепить'} onClick={() => void pinSession(session.id, !session.pinned)}>
                <Icon name="pin" size={0.875} />
              </button>
              <button type="button" className={styles.iconButton} title="Удалить сессию (файлы останутся в библиотеке)" onClick={() => void deleteSession(kind, session.id)}>
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
  const { history, currentId, open, remove } = usePrompter();
  return (
    <>
      <Text variant="caption" tone="tertiary" className={styles.listTitle}>
        История
      </Text>
      <nav className={styles.list}>
        {history.length === 0 && (
          <Text variant="caption" tone="tertiary" className={styles.listEmpty}>
            Здесь будут прошлые промпты.
          </Text>
        )}
        {history.map((entry) => (
          <div key={entry.id} className={`${styles.item} ${entry.id === currentId ? styles.itemActive : ''}`}>
            <button type="button" className={styles.itemLabel} title={entry.commentRu !== '' ? `Правка: ${entry.commentRu}` : entry.ideaRu} onClick={() => open(entry.id)}>
              {entry.commentRu !== '' && <Icon name="arrow-redo" size={0.875} />}
              <span>{entry.ideaRu}</span>
            </button>
            <span className={styles.itemActions}>
              <button type="button" className={styles.iconButton} title="Убрать из истории" onClick={() => remove(entry.id)}>
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
  const { projects, loadProjects, openProject } = useStore();
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);
  return (
    <>
      <Text variant="caption" tone="tertiary" className={styles.listTitle}>
        Ролики
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
  const { status, loadStatus } = useGen();
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  return (
    <div className={styles.providers}>
      {PROVIDERS.map((p) => {
        const s = status[p.id];
        const line = s === undefined ? 'проверяю…' : !s.hasKey ? (s.keyProblem ?? 'нет ключа в Keychain') : s.balance !== undefined ? `${s.balance.toLocaleString('ru-RU')} кр` : (s.balanceError ?? (p.balanceable ? 'баланс — по клику' : 'ключ есть'));
        return (
          <button key={p.id} type="button" className={styles.provider} onClick={() => p.balanceable && void loadStatus(true)} title={p.balanceable ? 'Обновить баланс' : undefined}>
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
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const kie = useGen((s) => s.status.kie);
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
      <aside className={styles.sidebar} aria-hidden={collapsed}>
        <div className={styles.brand}>
          <span className={styles.logo}>
            <Icon name="sparkles" size={1.25} />
          </span>
          <Text variant="title-s" medium>
            Студия
          </Text>
          <button type="button" className={styles.iconButton} onClick={toggle} title="Свернуть сайдбар">
            <Icon name="chevron-back" size={1} />
          </button>
        </div>
        <div className={styles.sidebarBody}>
          {sidebar ?? (route === 'images' ? <SessionList kind="image" /> : route === 'video' ? <SessionList kind="video" /> : route === 'shots' ? <ProjectList /> : route === 'prompter' ? <PrompterHistory /> : null)}
        </div>
        <div className={styles.sidebarFoot}>
          <ProviderCards />
          <ThemeSwitch />
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          {collapsed && (
            <button type="button" className={styles.iconButton} onClick={toggle} title="Показать сайдбар">
              <Icon name="chevron-forward" size={1} />
            </button>
          )}
          <nav className={styles.tabs}>
            {ROUTES.map((r) => (
              <button key={r} type="button" className={`${styles.tab} ${r === route ? styles.tabActive : ''}`} onClick={() => onRoute(r)}>
                {ROUTE_RU[r]}
              </button>
            ))}
          </nav>
          <span className={styles.status}>
            <span className={`${styles.dot} ${kie?.hasKey === true ? styles.dotOn : ''}`} />
            <Text variant="caption" tone="secondary">
              {kie?.hasKey === true ? 'KIE подключён' : 'KIE не подключён'}
            </Text>
          </span>
        </header>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
