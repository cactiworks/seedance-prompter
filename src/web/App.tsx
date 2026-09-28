import { useEffect } from 'react';
import { Canvas, FlowList } from './canvas/Canvas.tsx';
import { Home } from './features/Home.tsx';
import { Workspace } from './features/Workspace.tsx';
import { Library } from './library/Library.tsx';
import { AppShell } from './shell/AppShell.tsx';
import { useRoute } from './shell/route.ts';
import { useStore } from './store.ts';
import { Studio } from './studio/Studio.tsx';
import { applyTheme, readTheme } from './theme.ts';
import { Text } from './ui/components/index.ts';

export function App() {
  const { pack, project, loadPack, error } = useStore();
  const [route, setRoute] = useRoute();

  useEffect(() => {
    applyTheme(readTheme());
    void loadPack();
  }, [loadPack]);

  if (pack === null) {
    return (
      <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Text tone="secondary">{error ?? 'Загружаю правила гайда…'}</Text>
      </main>
    );
  }
  // Открытый ролик — прежний редактор кадра во весь экран; «Ролики» в его шапке возвращают в оболочку.
  if (project !== null) return <Workspace pack={pack} />;

  return (
    <AppShell route={route} onRoute={setRoute} sidebar={route === 'canvas' ? <FlowList /> : undefined}>
      {route === 'images' && <Studio kind="image" />}
      {route === 'video' && <Studio kind="video" />}
      {route === 'canvas' && <Canvas />}
      {route === 'library' && <Library />}
      {route === 'shots' && (
        <div style={{ height: '100%', overflowY: 'auto' }}>
          <Home />
        </div>
      )}
    </AppShell>
  );
}
