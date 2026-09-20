import { useEffect } from 'react';
import { Home } from './features/Home.tsx';
import { Workspace } from './features/Workspace.tsx';
import { useStore } from './store.ts';
import { Text } from './ui/components/index.ts';

export function App() {
  const { pack, project, loadPack, error } = useStore();

  useEffect(() => {
    document.documentElement.dataset.theme = 'light';
    void loadPack();
  }, [loadPack]);

  if (pack === null) {
    return (
      <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Text tone="secondary">{error ?? 'Загружаю правила гайда…'}</Text>
      </main>
    );
  }
  return project === null ? <Home /> : <Workspace pack={pack} />;
}
