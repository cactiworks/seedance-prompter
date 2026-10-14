import type { ProductionRun } from '../../core/production/model.ts';
import { useProduction } from './store.ts';
import { Button, Tag, Text } from '../ui/components/index.ts';
import styles from './Production.module.css';

export function Preparation({ run }: { run: ProductionRun }) {
  const { act, busy } = useProduction();
  const state = run.preparation;
  const plan = run.scenePlan;
  if (!state) return null;
  const calls = state.calls;
  const failed = state.status === 'failed' || state.status === 'interrupted';
  const unknownUsage = calls.some((c) => c.inputTokens === null || c.outputTokens === null);
  const tokens = calls.reduce((n, c) => n + (c.inputTokens ?? 0) + (c.outputTokens ?? 0), 0);
  const fields = plan ? [['Локация', plan.scene.location], ['Персонаж', plan.scene.subject], ['Одежда', plan.scene.wardrobe], ['Время', plan.scene.timeOfDay], ['Погода', plan.scene.weather], ['Свет', plan.scene.lighting], ['Палитра', plan.scene.palette]] : [];
  return <>
    <div className={styles.preparationRoles}>
      <div><Text variant="label" medium>1. Режиссёр</Text><Text variant="caption" tone="secondary">Единая сцена, свет, одежда, композиция и shot plan</Text><Tag tone={plan ? 'success' : failed ? 'warning' : 'accent'}>{plan ? 'Сцена сохранена' : failed ? 'Остановлен' : 'Готовит сцену'}</Tag></div>
      <div><Text variant="label" medium>2. Агент prompts</Text><Text variant="caption" tone="secondary">Prompts фотографий и движения по зафиксированному плану</Text><Tag tone={run.promptPlan ? 'success' : plan && !failed ? 'accent' : 'neutral'}>{run.promptPlan ? 'Prompts сохранены' : !plan ? 'Ожидает сцену' : failed ? 'Остановлен' : 'Пишет prompts'}</Tag></div>
    </div>
    <Text variant="caption" tone="secondary">{calls.length} вызовов Codex завершено · {tokens.toLocaleString('ru-RU')} токенов по полученным отчётам{unknownUsage ? ' · расход прерванных вызовов неизвестен' : ''}. Этот этап расходует только квоту ChatGPT.</Text>
    {failed && <div className={styles.error} role="alert"><div><Text variant="label" medium>Подготовка остановлена</Text><Text variant="label">{state.error}</Text></div><Button variant="border" disabled={busy || run.paused} onClick={() => void act({ type: 'retryPreparation' })}>Повторить этап Codex</Button><Text variant="caption">Повтор расходует квоту ChatGPT. Уже сохранённая сцена используется повторно.</Text></div>}
    {!plan && !failed && <Text variant="label" tone="secondary">Codex читает сценарий и визуальный вектор. Готовый паспорт появится здесь; медиа ждут окончания подготовки.</Text>}
    {plan && <>
      <Text as="h2" variant="title-s">{plan.scene.title}</Text>
      <dl className={styles.planFields}>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div><Text variant="label" medium>Общее для всех кадров</Text><ul className={styles.planNotes}>{plan.scene.continuity.map((note, i) => <li key={i}>{note}</li>)}</ul></div>
      {plan.assumptions.length > 0 && <div><Text variant="label" medium>Что режиссёр определил сам</Text><ul className={styles.planNotes}>{plan.assumptions.map((note, i) => <li key={i}>{note}</li>)}</ul></div>}
      {(plan.warnings.length > 0 || !!run.promptPlan?.warnings.length) && <div className={styles.notice}><Text variant="label" medium>Что учесть</Text><ul className={styles.planNotes}>{[...plan.warnings, ...(run.promptPlan?.warnings ?? [])].map((note, i) => <li key={i}>{note}</li>)}</ul></div>}
      {run.promptPlan?.masterPrompt && <details className={styles.detail}><summary>Prompt опорной сцены · Soul 2</summary><pre>{run.promptPlan.masterPrompt}</pre></details>}
      <div className={styles.shotPlan}>{plan.shots.map((shot, index) => {
        const prompts = run.promptPlan?.shots.find((p) => p.shotId === shot.id);
        return <article key={shot.id} className={styles.planShot}>
          <Text as="h3" variant="label" medium>{String(index + 1).padStart(2, '0')} · {shot.title}</Text>
          <Text variant="caption" tone="secondary">{shot.framing} · {shot.durationSec} с по плану</Text>
          <blockquote className={styles.scriptQuote}>{shot.scriptExcerpt}</blockquote>
          <Text variant="label">{shot.action}</Text><Text variant="label" tone="secondary">{shot.camera}</Text>
          <Text variant="caption" tone="secondary">Для монтажа: {shot.purpose}</Text>
          {prompts ? <details className={styles.detail}><summary>Prompts кадра · фото и движение</summary><Text variant="caption" medium>Фото · Soul 2</Text><pre>{prompts.imagePrompt}</pre><Text variant="caption" medium>Движение · будущий Seedance 2.5 · запуск отключён</Text><pre>{prompts.motionPrompt}</pre></details> : <Text variant="caption" tone="tertiary">Prompts появятся после второго агента.</Text>}
        </article>;
      })}</div>
      <Text variant="caption" tone="secondary">{run.mode === 'photos' ? 'Фото создаются в Soul 2 с общим reference сцены и выбранным Soul ID. Это помогает сохранять сцену, но сходство и детали нужно проверить на milestone. Видео и upscale отключены.' : 'Это реальный текстовый план Codex. В этой старой серии дальше используются условные mock-файлы. Для реальных фото создай новую серию по этому плану.'}</Text>
    </>}
    {calls.length > 0 && <details className={styles.detail}><summary>Вызовы Codex и расход квоты</summary><ul className={styles.planNotes}>{calls.map((c, i) => <li key={i}>{c.stage === 'scene' ? 'Режиссёр' : 'Prompts'} · {c.model ?? 'модель не указана'} · {Math.round(c.durationMs / 1000)} с · {c.status === 'accepted' ? 'ответ принят' : c.message} · input {c.inputTokens ?? 'неизвестно'} / output {c.outputTokens ?? 'неизвестно'}</li>)}</ul></details>}
  </>;
}
