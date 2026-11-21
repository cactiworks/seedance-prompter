import { ui } from './language.ts';
import { GenerationQuote } from './gen/GenerationQuote.tsx';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Calibration, CalibrationList } from './calibration/Calibration.tsx';
import { Canvas, FlowList } from './canvas/Canvas.tsx';
import { Home } from './features/Home.tsx';
import { Workspace, WorkspaceOverlay } from './features/Workspace.tsx';
import { Library } from './library/Library.tsx';
import { referenceLibraryStatus, type ReferenceLibraryStatus } from './references/api.ts';
import { useGen } from './gen/genStore.ts';
import { Production, ProductionList } from './production/Production.tsx';
import { Prompter } from './prompter/Prompter.tsx';
import { AppShell } from './shell/AppShell.tsx';
import { useRoute } from './shell/route.ts';
import { useStore } from './store.ts';
import { Studio } from './studio/Studio.tsx';
import { applyTheme, readTheme } from './theme.ts';
import { Text } from './ui/components/index.ts';
import { applyLanguage, useLanguage } from './language.ts';

const ReferenceLibrary = lazy(async () => ({ default: (await import('./references/ReferenceLibrary.tsx')).ReferenceLibrary }));

export function App() {
  const [language] = useLanguage();
  useEffect(() => {
    const stop = useGen.getState().watchJobs();
    const refresh = (): void => { if (document.visibilityState === 'visible') void useGen.getState().loadJobs(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { stop(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const { pack, project, host, loadPack, error } = useStore();
  const [requestedRoute, setRoute] = useRoute();
  const [referenceStatus, setReferenceStatus] = useState<ReferenceLibraryStatus>();
  const referenceLibraryEnabled = referenceStatus?.enabled;
  const route = requestedRoute === 'references' && referenceLibraryEnabled === false ? 'canvas' : requestedRoute;
  const tasksVisit = useGen((s) => s.tasksVisit);

  useEffect(() => {
    applyTheme(readTheme());
    void loadPack();
  }, [loadPack]);

  useEffect(() => { applyLanguage(language); }, [language]);

  useEffect(() => {
    const controller = new AbortController();
    void referenceLibraryStatus(controller.signal).then((status) => {
      if (!controller.signal.aborted) setReferenceStatus(status);
    }, () => {
      if (!controller.signal.aborted) setReferenceStatus({ enabled: false });
    });
    return () => controller.abort();
  }, []);

  if (pack === null) {
    return (
      <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Text tone="secondary">{error ?? ui("Открываю студию…")}</Text>
      </main>
    );
  }
  // Открытый ролик — прежний редактор кадра во весь экран; «Ролики» в его шапке возвращают в оболочку.
  if (project !== null && host === null) return <><Workspace pack={pack} /><GenerationQuote /></>;

  return (
    <>
      <AppShell route={route} onRoute={setRoute} referenceLibraryEnabled={referenceLibraryEnabled} sidebar={route === 'production' ? <ProductionList /> : route === 'canvas' ? <FlowList /> : route === 'calibration' ? <CalibrationList /> : undefined}>
        {route === 'production' && <Production />}
        {route === 'prompter' && <Prompter />}
        {route === 'images' && <Studio kind="image" />}
        {route === 'video' && <Studio kind="video" />}
        {route === 'canvas' && <Canvas referenceLibraryEnabled={referenceLibraryEnabled} />}
        {route === 'library' && <Library key={tasksVisit} />}
        {route === 'references' && <Suspense fallback={<Text tone="secondary">{ui('Открываю библиотеку…')}</Text>}>
          {referenceLibraryEnabled ? <ReferenceLibrary showGraph={referenceStatus?.graph === true} shared={referenceStatus?.shared === true} /> : <Text tone="secondary">{ui('Открываю библиотеку…')}</Text>}
        </Suspense>}
        {route === 'calibration' && <Calibration />}
        {route === 'shots' && (
          <div style={{ height: '100%', overflowY: 'auto' }}>
            <Home />
          </div>
        )}
      </AppShell>
      {/* Seedance-промптер из canvas: тот же редактор кадра — попапом на весь экран поверх холста. */}
      {project !== null && host !== null && <WorkspaceOverlay pack={pack} />}
      <GenerationQuote />
    </>
  );
}
