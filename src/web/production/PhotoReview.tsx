import { useState } from 'react';
import type { ProductionRun } from '../../core/production/model.ts';
import { masterApproved, type ReviewResult } from '../../core/production/review.ts';
import { appearanceReady } from '../../core/production/appearance.ts';
import { Button, Tag, Text } from '../ui/components/index.ts';
import { useProduction } from './store.ts';
import styles from './Production.module.css';

export const VERDICT = { keep: 'Рекомендован', uncertain: 'Проверь вручную', reject: 'Критик отклонил' };
const CHECKS = { face: 'Лицо', likeness: 'Сходство лица', character: 'Персонаж целиком', hands: 'Руки', continuity: 'Единство сцены', shotMatch: 'Соответствие кадру', visualInterest: 'Выразительность' };
const RESULT = { pass: 'без видимых проблем', fail: 'есть замечание', uncertain: 'не уверен', not_visible: 'вне кадра', not_applicable: 'привязка к внешности не задана' };
export function PhotoVerdict({ result }: { result?: ReviewResult }) {
  if (!result) return <Text variant="caption" tone="secondary">Ожидает проверки критиком.</Text>;
  return <><Tag tone={result.verdict === 'keep' ? 'success' : 'warning'}>{VERDICT[result.verdict]}</Tag><Text variant="caption">{result.reason}</Text>
    <details className={styles.detail}><summary>Что увидел критик</summary><ul className={styles.planNotes}>
      {Object.entries(result.checks).map(([key, value]) => <li key={key}>{CHECKS[key as keyof typeof CHECKS]}: {RESULT[value]}</li>)}
      {result.observations.map((observation, i) => <li key={i}>{observation.region}: {observation.evidence}</li>)}
    </ul></details></>;
}
export function PhotoReview({ run, scope = 'series' }: { run: ProductionRun; scope?: 'master' | 'series' }) {
  const { photoCommand, busy } = useProduction();
  const [consent, setConsent] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const master = scope === 'master';
  const state = master ? run.masterReview : run.review;
  const activeMedia = run.photos?.status === 'running' || run.photos?.items.some((i) => ['submitting', 'queued', 'running', 'downloading'].includes(i.status));
  const hasPhotos = master ? !!run.photos?.masterArtifactId && appearanceReady(run) : run.shots.some((s) => s.photoId);
  if (state?.status === 'running') return <Text role="status">Codex рассматривает фотографии, опорную сцену и доступные фото-референсы внешности. Результат появится здесь; автоматической приёмки не будет.</Text>;
  if (state?.status === 'pending') return <Text role="status">{master ? 'Критик проверит master сразу после сохранения. Остальные кадры ждут положительного вердикта по внешности целиком, анатомии и сцене.' : 'Финальный отбор запустится после завершения генерации кадров.'} Проверка разрешена при подтверждении стоимости фото и расходует квоту ChatGPT.</Text>;
  if (state?.status === 'complete' && state.report && (!master || masterApproved(run))) {
    const shots = state.report.results.filter((r) => run.shots.some((s) => s.photoId === r.artifactId));
    return <><Text variant="label">{state.report.summary}</Text>{master ? <Text variant="label">Master прошёл обязательную проверку. {run.photos?.status === 'running' ? 'Отправка кадров разрешена.' : 'Продолжение кадров требует подтверждения стоимости.'}</Text> : <Text variant="caption">Рекомендовано: {shots.filter((r) => r.verdict === 'keep').length} · сомнительно: {shots.filter((r) => r.verdict === 'uncertain').length} · отклонено: {shots.filter((r) => r.verdict === 'reject').length}</Text>}
      <Text variant="caption" tone="secondary">Фото-референсов внешности: {state.identityCount}{!state.identityCount && ' — соответствие лицу не подтверждено'}. {state.model} · input {state.inputTokens ?? 'неизвестно'} / output {state.outputTokens ?? 'неизвестно'} токенов. Это мнение модели; финальное решение за тобой.</Text></>;
  }
  return <>
    {master && state?.status === 'complete' && <Text role="alert">Master не прошёл проверку. Остальные кадры заблокированы. {state.report?.summary}</Text>}
    {state?.error && <Text role="alert">{state.error}</Text>}
    <Text variant="label" tone="secondary">{master ? 'Без положительной проверки master кадры не запускаются. Сомнение, ошибка и отсутствие референсов не считаются одобрением. При отклонении можно создать новую серию или явно повторить только проверку.' : 'Перед milestone критик проверит персонажа целиком, лицо, руки, общую сцену, выполнение shot plan и выразительность.'} Отклонённые кадры сохраняются. Платных перегенераций нет.</Text>
    {hasPhotos && !activeMedia ? <>
      <label className={styles.check}><input type="checkbox" checked={consent} disabled={busy || run.paused} onChange={(e) => setConsent(e.target.checked)} />Разрешаю отправить {master ? 'master' : 'фото серии и опорную сцену'} и до шести локальных фото выбранного Soul ID в Codex / OpenAI. Один вызов расходует квоту ChatGPT.</label>
      <div><Button variant="primary" disabled={!consent || busy || run.paused} onClick={() => void photoCommand('review', { rev: run.rev, requestId, consent: true, scope, referenceLimit: 6 }).then((ok) => { if (ok) { setConsent(false); setRequestId(crypto.randomUUID()); } })}>{master ? 'Проверить master с Codex · без генерации' : state ? 'Повторить проверку с Codex' : 'Проверить фотографии с Codex'}</Button></div>
    </> : <Text variant="caption" tone="tertiary">Ожидает сохранённых фотографий и завершения генерации.</Text>}
  </>;
}
