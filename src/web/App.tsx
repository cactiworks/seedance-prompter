import { useEffect } from 'react';
import { Calibration, CalibrationList } from './calibration/Calibration.tsx';
import { Canvas, FlowList } from './canvas/Canvas.tsx';
import { Home } from './features/Home.tsx';
import { Workspace, WorkspaceOverlay } from './features/Workspace.tsx';
import { Library } from './library/Library.tsx';
import { useGen } from './gen/genStore.ts';
import { Production, ProductionList } from './production/Production.tsx';
import { Prompter } from './prompter/Prompter.tsx';
import { AppShell } from './shell/AppShell.tsx';
import { useRoute } from './shell/route.ts';
import { useStore } from './store.ts';
import { Studio } from './studio/Studio.tsx';
import { applyTheme, readTheme } from './theme.ts';
import { Text } from './ui/components/index.ts';

export function App() {
  useEffect(() => {
    const stop = useGen.getState().watchJobs();
    const refresh = (): void => { if (document.visibilityState === 'visible') void useGen.getState().loadJobs(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { stop(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const { pack, project, host, loadPack, error } = useStore();
  const [route, setRoute] = useRoute();
  const tasksVisit = useGen((s) => s.tasksVisit);

  useEffect(() => {
    applyTheme(readTheme());
    void loadPack();
  }, [loadPack]);

  if (pack === null) {
    return (
      <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Text tone="secondary">{error ?? 'Открываю студию…'}</Text>
      </main>
    );
  }
  // Открытый ролик — прежний редактор кадра во весь экран; «Ролики» в его шапке возвращают в оболочку.
  if (project !== null && host === null) return <Workspace pack={pack} />;

  return (
    <>
      <AppShell route={route} onRoute={setRoute} sidebar={route === 'production' ? <ProductionList /> : route === 'canvas' ? <FlowList /> : route === 'calibration' ? <CalibrationList /> : undefined}>
        {route === 'production' && <Production />}
        {route === 'prompter' && <Prompter />}
        {route === 'images' && <Studio kind="image" />}
        {route === 'video' && <Studio kind="video" />}
        {route === 'canvas' && <Canvas />}
        {route === 'library' && <Library key={tasksVisit} />}
        {route === 'calibration' && <Calibration />}
        {route === 'shots' && (
          <div style={{ height: '100%', overflowY: 'auto' }}>
            <Home />
          </div>
        )}
      </AppShell>
      {/* Seedance-промптер из canvas: тот же редактор кадра — попапом на весь экран поверх холста. */}
      {project !== null && host !== null && <WorkspaceOverlay pack={pack} />}
    </>
  );
}
