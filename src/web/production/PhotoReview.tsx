import { ui } from '../language.ts';
import { useState } from 'react';
import type { ProductionRun } from '../../core/production/model.ts';
import { masterApproved, LOGIC_CRITERIA, logicReviewed, logicReviewPassed, type ReviewResult } from '../../core/production/review.ts';
import { appearanceReady } from '../../core/production/appearance.ts';
import { Button, Tag, Text } from '../ui/components/index.ts';
import { useProduction } from './store.ts';
import styles from './Production.module.css';

export const VERDICT = { keep: 'Рекомендован', uncertain: 'Проверь вручную', reject: 'Есть замечание' };
const CHECKS = { face: 'Лицо', likeness: 'Сходство лица', character: 'Персонаж целиком', hands: 'Руки', identityLeakage: 'Лицо на других людях', text: 'Текст в кадре', continuity: 'Единство сцены', shotMatch: 'Соответствие кадру', visualInterest: 'Манера съёмки и выразительность', wardrobe: 'Целостность одежды', sceneLogic: 'Логика сцены' };
const RESULT = { pass: 'без видимых проблем', variation: 'допустимое отклонение', fail: 'существенная проблема', uncertain: 'не уверен', not_visible: 'вне кадра', not_applicable: 'привязка к внешности не задана' };
export function PhotoVerdict({ result, compact = false }: { result?: ReviewResult; compact?: boolean }) {
  if (!result) return <Text variant="caption" tone="secondary">{ui("Проверяется")}</Text>;
  const current = logicReviewed(result);
  return <><Tag tone={logicReviewPassed(result) ? 'success' : 'warning'}>{result.verdict === 'keep' && !current ? ui("Нужна проверка логики") : ui(VERDICT[result.verdict])}</Tag>{!current && <Text variant="caption" tone="secondary">{ui("Одежда и логика сцены ещё не проверены по новым критериям.")}</Text>}{(!compact || result.verdict !== 'keep') && <Text variant="caption">{result.reason}</Text>}
    {!compact && <details className={styles.detail}><summary>{ui("Что увидел критик")}</summary><ul className={styles.planNotes}>
      {Object.entries(result.checks).map(([key, value]) => <li key={key}>{ui(CHECKS[key as keyof typeof CHECKS])}: {ui(RESULT[value])}</li>)}
      {result.faceDetail && <li>{ui("Глаз слева на фото: ")}{ui(RESULT[result.faceDetail.leftEye])}{ui("; справа: ")}{ui(RESULT[result.faceDetail.rightEye])}{ui("; рот: ")}{ui(RESULT[result.faceDetail.mouth])}.</li>}
      {result.wardrobeDetail && <li>{ui("Верх: ")}{ui(RESULT[result.wardrobeDetail.upperBody])}{ui("; низ: ")}{ui(RESULT[result.wardrobeDetail.lowerBody])}{ui("; обувь: ")}{ui(RESULT[result.wardrobeDetail.footwear])}.</li>}
      {result.observations.map((observation, i) => <li key={i}>{observation.region}: {observation.evidence}</li>)}
    </ul></details>}</>;
}
export function PhotoReview({ run, scope = 'series', allowComplete = false }: { run: ProductionRun; scope?: 'master' | 'series'; allowComplete?: boolean }) {
  const { photoCommand, busy } = useProduction();
  const [consent, setConsent] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const master = scope === 'master';
  const state = master ? run.masterReview : run.review;
  const activeMedia = run.photos?.status === 'running' || run.photos?.items.some(i => ['submitting', 'queued', 'running', 'downloading'].includes(i.status));
  const hasPhotos = master ? !!run.photos?.masterArtifactId && appearanceReady(run) : run.shots.some(s => s.photoId);
  if (run.retouch?.status === 'running') return null;
  if (['running', 'pending'].includes(state?.status ?? '') || activeMedia || !hasPhotos) return null;
  const outdated = state?.status === 'complete' && state.criteriaVersion !== LOGIC_CRITERIA;
  if (master && state?.status === 'complete' && !outdated && masterApproved(run)) return null;
  if (state?.status === 'complete' && !outdated && !allowComplete && (!master || masterApproved(run))) return null;
  return <details className={styles.detail} open={state?.status !== 'complete'}>
    <summary>{state?.status === 'failed' ? ui("Повторить остановленную проверку без генерации") : state?.status === 'interrupted' ? ui("Продолжить проверку вручную") : outdated ? master ? ui("Перепроверить одежду и логику master") : ui("Перепроверить одежду и логику сцены") : master ? ui("Перепроверить этот кадр без генерации") : ui("Повторить отбор фотографий")}</summary>
    {state?.status === 'failed' && <Text role="alert" variant="label">{state.error ?? ui("Проверка остановилась технически. Повтори её явно; фото и бюджет сохранены.")}</Text>}
    {state?.status === 'interrupted' && <Text role="status" variant="label">{ui("Проверка прервана. Запусти её снова после подключения AI.")}</Text>}
    {outdated && <Text variant="caption">{ui("В прежнем отчёте нет отдельной проверки одежды и логики сцены. Сохранённые фото можно проверить заново; генерация не запускается.")}</Text>}
    {master && state?.status === 'complete' && <Text variant="caption">{state.criteriaVersion ? ui("Кадр будет проверен заново; фото не перегенерируются.") : ui("Короткие рукава и мелкие отличия одежды теперь допустимы. Кадр будет проверен заново; фото не перегенерируются.")}</Text>}
    <Text variant="caption" tone="secondary">{ui("Критик увидит общий кадр и четыре крупных фрагмента каждого исходника. Проверит глаза, рот, руки, фоновые лица, текст, комплект одежды, физическую логику сцены и выбранную манеру съёмки; художественные отклонения оценивает отдельно.")}</Text>
    <label className={styles.check}><input type="checkbox" checked={consent} disabled={busy || run.paused} onChange={e => setConsent(e.target.checked)} />{ui("Разрешаю отправить ")}{master ? 'master' : ui("фото серии")} {ui(" с крупными фрагментами и до шести фото Soul ID в Codex / OpenAI. Один вызов через твоё AI-подключение; крупные фрагменты увеличивают расход.")}</label>
    <Button variant="border" disabled={!consent || busy || run.paused} onClick={() => void photoCommand('review', { rev: run.rev, requestId, consent: true, scope, referenceLimit: 6 }).then(ok => { if (ok) { setConsent(false); setRequestId(crypto.randomUUID()); } })}>{master ? ui("Перепроверить master") : ui("Проверить фотографии")}</Button>
  </details>;
}
