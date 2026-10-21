import { seriesFormFingerprint } from '../../core/production/seriesForm.ts';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../core/model/project.ts';
import { useStore } from '../store.ts';
import { Button, Text } from '../ui/components/index.ts';
import { seriesApi, preparationLabel, type Inspection } from './api.ts';
import styles from './Series.module.css';

/** Read-only status polling. No preparation or generation is triggered by mounting. */
export function usePreparation(slug: string) {
  const [data, setData] = useState<Inspection | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!slug) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      clearTimeout(timer);
      try {
        const value = await seriesApi<Inspection>(`/api/series-prompter/${slug}`);
        if (!stopped) { setData(value); setError(''); timer = setTimeout(() => void poll(), value.state?.status === 'running' ? 1500 : 8000); }
      } catch (e) { if (!stopped) { setError(e instanceof Error ? e.message : 'Статус недоступен.'); timer = setTimeout(() => void poll(), 8000); } }
    };
    const refresh = () => void poll();
    void poll(); window.addEventListener('series-preparation', refresh);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('series-preparation', refresh); };
  }, [slug]);
  return { data, error };
}
export const refreshPreparation = () => window.dispatchEvent(new Event('series-preparation'));
export function SeriesNodeStatus({ slug }: { slug: string }) {
  const { data, error } = usePreparation(slug);
  return <Text variant="caption" tone="secondary">{error || preparationLabel(data)}</Text>;
}
export function SeriesPreparation({ project }: { project: Project }) {
  const { data, error: pollError } = usePreparation(project.slug);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reset, setReset] = useState(false);
  const expected = useRef<{rev:number; id:string} | null>(null);
  useEffect(() => {
    if (expected.current === null || !data?.state || data.state.status === 'running' || data.state.id !== expected.current.id) return;
    const local = useStore.getState();
    if (data.project.rev > expected.current.rev && local.project?.slug === data.project.slug && local.project.rev === expected.current.rev && local.save === 'saved') {
      useStore.setState({ project:data.project, error:null });
    }
    expected.current = null;
  }, [data]);
  useEffect(() => {
    if (!data?.stale) return;
    const local = useStore.getState();
    const current = local.project;
    // Context/photo changes can leave the prompt text unchanged. Do not display the
    // old series report as current, or remove a newer independently requested report.
    if (current?.slug !== data.project.slug || !current.seriesFill?.critique) return;
    if (current.shots.some(shot => shot.critique?.createdAt === current.seriesFill?.critique?.createdAt)) {
      local.update(p => ({ ...p, shots:p.shots.map(shot => shot.critique?.createdAt === p.seriesFill?.critique?.createdAt ? { ...shot, critique:null } : shot) }));
    }
  }, [data]);
  const start = async () => {
    setBusy(true); setError('');
    try {
      if (!await useStore.getState().flushProject()) throw new Error('Сначала сохрани ручные правки.');
      const current = useStore.getState().project!;
      const response = await seriesApi<{ results: { state?: {id:string}; error?: string }[] }>('/api/series-prompter/prepare', { targets:[{ slug:current.slug, rev:current.rev }], consent, reset });
      if (response.results[0]?.error) throw new Error(response.results[0].error);
      expected.current = { rev:current.rev, id:response.results[0]!.state!.id }; setReset(false); refreshPreparation();
    } catch(e) { setError(e instanceof Error ? e.message : 'Не удалось начать.'); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    setBusy(true); setError('');
    try {
      if (!await useStore.getState().flushProject()) throw new Error('Сначала сохрани правки.');
      const current = useStore.getState().project!;
      const saved = await seriesApi<Project>(`/api/series-prompter/${project.slug}/restore`, { rev:current.rev });
      const latest = useStore.getState();
      if (latest.project === current && latest.save === 'saved') useStore.setState({ project:saved });
      refreshPreparation();
    } catch(e) { setError(e instanceof Error ? e.message : 'Не удалось восстановить.'); }
    finally { setBusy(false); }
  };
  const running = data?.state?.status === 'running';
  const changed = data?.project.seriesFill && JSON.stringify(seriesFormFingerprint(project)) !== JSON.stringify(seriesFormFingerprint(data.project));
  return <section className={styles.panel} aria-label="Подготовка по серии">
    <div className={styles.row}><Text variant="label" medium>Из производства · {project.title}</Text><Text variant="caption" role="status">{changed && !running ? 'Форма изменена · проверка устарела' : preparationLabel(data)}</Text></div>
    <Text variant="caption" tone="secondary">Агент заполнит форму по режиссуре всей серии и исходному фото. Ручные поля сохранятся; после критика — не больше одного исправления.</Text>
    {data?.contextProblem && <Text role="alert" variant="caption">{data.contextProblem}</Text>}
    {!!data?.state?.issues.length && <ul className={styles.issues}>{data.state.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
    <label className={styles.choice}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={running || busy} />Передать фото и контекст серии в моё ChatGPT-подключение · до 4 вызовов</label>
    <div className={styles.row}>
      <Button variant="primary" size="s" loading={busy || running} disabled={!consent || !!data?.contextProblem} onClick={() => void start()}>{reset ? 'Заполнить заново с заменой ручных полей' : 'Заполнить по серии'}</Button>
      <Button variant="ghost" size="s" disabled={busy || running} onClick={() => setReset(!reset)}>{reset ? 'Отменить сброс' : 'Полный сброс и заполнение'}</Button>
      {project.seriesFill && <Button variant="border" size="s" disabled={busy || running} onClick={() => void restore()}>Вернуть предыдущую форму</Button>}
    </div>
    {reset && <Text variant="caption">Этот запуск заменит ручные поля. Предыдущую форму можно будет восстановить.</Text>}
    {(error || pollError) && <Text role="alert" variant="caption">{error || pollError}</Text>}
  </section>;
}
