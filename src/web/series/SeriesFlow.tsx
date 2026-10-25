import { useState } from 'react';
import type { Flow } from '../../core/model/canvas.ts';
import type { Project } from '../../core/model/project.ts';
import { useCanvas } from '../canvas/canvasStore.ts';
import { useProduction } from '../production/store.ts';
import { Button, Text } from '../ui/components/index.ts';
import { seriesApi } from './api.ts';
import { refreshPreparation } from './SeriesPreparation.tsx';
import styles from './Series.module.css';
export function SeriesFlow({ flow }: { flow: Flow }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const nodes = flow.nodes.filter(n => n.type === 'seedance' && n.production);
  const chosen = nodes.filter(n => selected.includes(n.id));
  const prepare = async () => {
    setBusy(true); setMessage('');
    try {
      if (!await useCanvas.getState().flush()) throw new Error('Сначала сохрани Canvas.');
      const drafts = await Promise.all(chosen.map(n => seriesApi<Project>(`/api/projects/${n.slug}`)));
      const result = await seriesApi<{ results: { slug:string; error?:string }[] }>('/api/series-prompter/prepare', { targets:drafts.map(p => ({ slug:p.slug, rev:p.rev })), consent });
      setMessage(`В подготовке: ${result.results.filter(r => !r.error).length}. ${result.results.filter(r => r.error).map(r => r.error).join(' ')}`);
      refreshPreparation();
    } catch(e) { setMessage(e instanceof Error ? e.message : 'Не удалось начать.'); }
    finally { setBusy(false); }
  };
  return <div className={styles.flowBar}>
    <div className={styles.row}><Text variant="caption" medium>Из производства · {flow.production!.title}</Text><Button size="xs" variant="ghost" onClick={() => { void useProduction.getState().select(flow.production!.runId); window.location.hash = '/production'; }}>Открыть серию</Button></div>
    <details><summary>Подготовить Prompter · выбрано {chosen.length} из {nodes.length}</summary><div className={styles.batch}>
      <Text variant="caption" tone="secondary">Отметь партию для заполнения. Видео запускается отдельно в каждом Prompter.</Text>
      <div className={styles.choices}>{nodes.map(n => <label key={n.id} className={styles.choice}><input type="checkbox" checked={selected.includes(n.id)} onChange={e => setSelected(e.target.checked ? [...selected, n.id] : selected.filter(id => id !== n.id))} />{n.label}</label>)}</div>
      <label className={styles.choice}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />Передать выбранные фото и контекст серии в моё AI-подключение · до 4 вызовов на кадр</label>
      <Button size="s" variant="primary" disabled={!chosen.length || !consent} loading={busy} onClick={() => void prepare()}>Заполнить по серии · {chosen.length}</Button>
      {message && <Text role="status" variant="caption">{message}</Text>}
    </div></details>
  </div>;
}
