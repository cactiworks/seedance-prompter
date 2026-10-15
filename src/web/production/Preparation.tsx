import type { ProductionRun } from '../../core/production/model.ts';
import { hasStoryEvents, sceneForShot } from '../../core/production/plan.ts';
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
  const scenes = plan?.scenes ?? (plan ? [{ ...plan.scene, id: 'legacy' }] : []);
  return <>
    <div className={styles.preparationRoles}>
      <div><Text variant="label" medium>1. Режиссёр</Text><Text variant="caption" tone="secondary">Смысловые моменты, события, локации и кадры</Text><Tag tone={plan ? 'success' : failed ? 'warning' : 'accent'}>{plan ? 'План сохранён' : failed ? 'Остановлен' : 'Готовит план'}</Tag></div>
      <div><Text variant="label" medium>2. Агент prompts</Text><Text variant="caption" tone="secondary">Prompts фотографий и движения по зафиксированному плану</Text><Tag tone={run.promptPlan ? 'success' : plan && !failed ? 'accent' : 'neutral'}>{run.promptPlan ? 'Prompts сохранены' : !plan ? 'Ожидает план' : failed ? 'Остановлен' : 'Пишет prompts'}</Tag></div>
    </div>
    <Text variant="caption" tone="secondary">{calls.length} вызовов Codex завершено · {tokens.toLocaleString('ru-RU')} токенов по полученным отчётам{unknownUsage ? ' · расход прерванных вызовов неизвестен' : ''}. Этот этап расходует только квоту ChatGPT.</Text>
    {failed && <div className={styles.error} role="alert"><div><Text variant="label" medium>Подготовка остановлена</Text><Text variant="label">{state.error}</Text></div><Button variant="border" disabled={busy || run.paused} onClick={() => void act({ type: 'retryPreparation' })}>Повторить этап Codex</Button><Text variant="caption">Повтор расходует квоту ChatGPT. Уже сохранённый план используется повторно.</Text></div>}
    {!plan && !failed && <Text variant="label" tone="secondary">Codex читает сценарий и визуальный вектор. Готовый план появится здесь; медиа ждут окончания подготовки.</Text>}
    {plan && <>
      <Text as="h2" variant="title-s">{plan.scene.title}</Text>
      {plan.artDirection && <div className={styles.notice}><Text variant="label" medium>Художественная идея</Text><Text variant="label">{plan.artDirection.concept}</Text><Text variant="label">Визуальный акцент: {plan.artDirection.visualHook}</Text><Text variant="caption" tone="secondary">Характер изображения: {plan.artDirection.captureTexture}</Text></div>}
      {scenes.map(scene => <details className={styles.detail} key={scene.id}><summary>Сцена · {scene.title}</summary><dl className={styles.planFields}>{[['Локация', scene.location], ['Персонаж', scene.subject], ['Одежда', scene.wardrobe], ['Время', scene.timeOfDay], ['Погода', scene.weather], ['Свет', scene.lighting], ['Палитра', scene.palette]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><Text variant="label" medium>Сохраняется внутри этой сцены</Text><ul className={styles.planNotes}>{scene.continuity.map((note, i) => <li key={i}>{note}</li>)}</ul></details>)}
      {plan.assumptions.length > 0 && <div><Text variant="label" medium>Что режиссёр определил сам</Text><ul className={styles.planNotes}>{plan.assumptions.map((note, i) => <li key={i}>{note}</li>)}</ul></div>}
      {(plan.warnings.length > 0 || !!run.promptPlan?.warnings.length) && <div className={styles.notice}><Text variant="label" medium>Что учесть</Text><ul className={styles.planNotes}>{[...plan.warnings, ...(run.promptPlan?.warnings ?? [])].map((note, i) => <li key={i}>{note}</li>)}</ul></div>}
      {run.promptPlan?.masterPrompt && <details className={styles.detail}><summary>Prompt опорного кадра · Soul 2</summary><pre>{run.promptPlan.masterPrompt}</pre></details>}
      <div className={styles.shotPlan}>{plan.shots.map((shot, index) => {
        const prompts = run.promptPlan?.shots.find((p) => p.shotId === shot.id);
        return <article key={shot.id} className={styles.planShot}>
          <Text as="h3" variant="label" medium>{String(index + 1).padStart(2, '0')} · {shot.title}</Text>
          <Text variant="caption" tone="secondary">{shot.framing} · {shot.durationSec} с по плану</Text>
          <blockquote className={styles.scriptQuote}>{shot.scriptExcerpt}</blockquote>
          {shot.beat && <Text variant="label">Смысл: {shot.beat}</Text>}
          {shot.sceneId && <Text variant="caption" tone="secondary">Сцена: {sceneForShot(plan, shot).title}</Text>}
          <Text variant="label">{shot.action}</Text><Text variant="label" tone="secondary">{shot.camera}</Text>
          {shot.startFrame && <Text variant="label">На стартовом фото: {shot.startFrame}</Text>}
          <Text variant="caption" tone="secondary">Для монтажа: {shot.purpose}</Text>
          {shot.visualAnchor && <Text variant="label">Визуальный приём: {shot.visualAnchor}</Text>}
          {prompts ? <details className={styles.detail}><summary>Prompts кадра · фото и движение</summary><Text variant="caption" medium>Фото · Soul 2</Text><pre>{prompts.imagePrompt}</pre><Text variant="caption" medium>Движение · будущий Seedance 2.5 · запуск отключён</Text><pre>{prompts.motionPrompt}</pre></details> : <Text variant="caption" tone="tertiary">Prompts появятся после второго агента.</Text>}
        </article>;
      })}</div>
      <Text variant="caption" tone="secondary">{run.mode === 'photos' ? hasStoryEvents(plan) ? 'У каждого события — самостоятельный кадр. Soul ID и профиль сохраняют внешность; композиция master не переносится. Критик проверит события перед приёмкой. Видео и upscale отключены.' : 'Старый план с общим reference сцены. Новая режиссура по сценарию создаёт отдельные события и допускает разные локации.' : 'Это текстовый план Codex; далее используются условные mock-файлы. Они не иллюстрируют события плана.'}</Text>
    </>}
    {calls.length > 0 && <details className={styles.detail}><summary>Вызовы Codex и расход квоты</summary><ul className={styles.planNotes}>{calls.map((c, i) => <li key={i}>{c.stage === 'scene' ? 'Режиссёр' : 'Prompts'} · {c.model ?? 'модель не указана'} · {Math.round(c.durationMs / 1000)} с · {c.status === 'accepted' ? 'ответ принят' : c.message} · input {c.inputTokens ?? 'неизвестно'} / output {c.outputTokens ?? 'неизвестно'}</li>)}</ul></details>}
  </>;
}
