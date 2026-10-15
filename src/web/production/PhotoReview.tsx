import { useState } from 'react';
import type { ProductionRun } from '../../core/production/model.ts';
import { masterApproved, type ReviewResult } from '../../core/production/review.ts';
import { appearanceReady } from '../../core/production/appearance.ts';
import { Button, Tag, Text } from '../ui/components/index.ts';
import { useProduction } from './store.ts';
import styles from './Production.module.css';

export const VERDICT = { keep: 'Рекомендован', uncertain: 'Проверь вручную', reject: 'Есть замечание' };
const CHECKS = { face: 'Лицо', likeness: 'Сходство лица', character: 'Персонаж целиком', hands: 'Руки', continuity: 'Единство сцены', shotMatch: 'Соответствие кадру', visualInterest: 'Выразительность' };
const RESULT = { pass: 'без видимых проблем', variation: 'допустимое отклонение', fail: 'существенная проблема', uncertain: 'не уверен', not_visible: 'вне кадра', not_applicable: 'привязка к внешности не задана' };
export function PhotoVerdict({ result, compact = false }: { result?: ReviewResult; compact?: boolean }) {
  if (!result) return <Text variant="caption" tone="secondary">Проверяется</Text>;
  return <><Tag tone={result.verdict === 'keep' ? 'success' : 'warning'}>{VERDICT[result.verdict]}</Tag>{(!compact || result.verdict !== 'keep') && <Text variant="caption">{result.reason}</Text>}
    {!compact && <details className={styles.detail}><summary>Что увидел критик</summary><ul className={styles.planNotes}>
      {Object.entries(result.checks).map(([key, value]) => <li key={key}>{CHECKS[key as keyof typeof CHECKS]}: {RESULT[value]}</li>)}
      {result.observations.map((observation, i) => <li key={i}>{observation.region}: {observation.evidence}</li>)}
    </ul></details>}</>;
}
export function PhotoReview({ run, scope = 'series' }: { run: ProductionRun; scope?: 'master' | 'series' }) {
  const { photoCommand, busy } = useProduction();
  const [consent, setConsent] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const master = scope === 'master';
  const state = master ? run.masterReview : run.review;
  const activeMedia = run.photos?.status === 'running' || run.photos?.items.some(i => ['submitting', 'queued', 'running', 'downloading'].includes(i.status));
  const hasPhotos = master ? !!run.photos?.masterArtifactId && appearanceReady(run) : run.shots.some(s => s.photoId);
  if (['running', 'pending'].includes(state?.status ?? '') || activeMedia || !hasPhotos) return null;
  if (state?.status === 'complete' && (!master || masterApproved(run))) return null;
  return <details className={styles.detail} open={state?.status !== 'complete'}>
    <summary>{master ? 'Перепроверить этот кадр без генерации' : 'Повторить отбор фотографий'}</summary>
    {master && state?.status === 'complete' && <Text variant="caption">{state.criteriaVersion ? 'Кадр будет проверен заново; фото не перегенерируются.' : 'Короткие рукава и мелкие отличия одежды теперь допустимы. Кадр будет проверен заново; фото не перегенерируются.'}</Text>}
    <label className={styles.check}><input type="checkbox" checked={consent} disabled={busy || run.paused} onChange={e => setConsent(e.target.checked)} />Разрешаю отправить {master ? 'master' : 'фото серии'} и до шести фото Soul ID в Codex / OpenAI. Один вызов из квоты ChatGPT.</label>
    <Button variant="border" disabled={!consent || busy || run.paused} onClick={() => void photoCommand('review', { rev: run.rev, requestId, consent: true, scope, referenceLimit: 6 }).then(ok => { if (ok) { setConsent(false); setRequestId(crypto.randomUUID()); } })}>{master ? 'Перепроверить master' : 'Проверить фотографии'}</Button>
  </details>;
}
