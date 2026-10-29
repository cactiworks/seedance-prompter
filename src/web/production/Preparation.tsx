import { ui } from '../language.ts';
import type { ProductionRun } from '../../core/production/model.ts';
import { hasStoryEvents, sceneForShot } from '../../core/production/plan.ts';
import { useProduction } from './store.ts';
import { Button, Tag, Text } from '../ui/components/index.ts';
import styles from './Production.module.css';

export function Preparation({ run }: { run: ProductionRun }) {
  const { act, busy } = useProduction();
  const state = run.preparation;
  const plan = run.scenePlan;
  const broll = run.contentMode === 'broll';
  if (!state) return null;
  const calls = state.calls;
  const failed = state.status === 'failed' || state.status === 'interrupted';
  const unknownUsage = calls.some((c) => c.inputTokens === null || c.outputTokens === null);
  const tokens = calls.reduce((n, c) => n + (c.inputTokens ?? 0) + (c.outputTokens ?? 0), 0);
  const scenes = plan?.scenes ?? (plan ? [{ ...plan.scene, id: 'legacy' }] : []);
  return <>
    <div className={styles.preparationRoles}>
      <div><Text variant="label" medium>{ui("1. Режиссёр")}</Text><Text variant="caption" tone="secondary">{broll ? ui("Самостоятельные идеи, одежда, локации и свет") : ui("Смысловые моменты, события, локации и кадры")}</Text><Tag tone={plan ? 'success' : failed ? 'warning' : 'accent'}>{plan ? ui("План сохранён") : failed ? ui("Остановлен") : ui("Готовит план")}</Tag></div>
      <div><Text variant="label" medium>{ui("2. Агент prompts")}</Text><Text variant="caption" tone="secondary">{ui("Prompts фотографий и движения по зафиксированному плану")}</Text><Tag tone={run.promptPlan ? 'success' : plan && !failed ? 'accent' : 'neutral'}>{run.promptPlan ? ui("Prompts сохранены") : !plan ? ui("Ожидает план") : failed ? ui("Остановлен") : ui("Пишет prompts")}</Tag></div>
    </div>
    <Text variant="caption" tone="secondary">{calls.length} {ui(" вызовов Codex завершено · ")}{tokens.toLocaleString('ru-RU')} {ui(" токенов по полученным отчётам")}{unknownUsage ? ui(" · расход прерванных вызовов неизвестен") : ''}{ui(". Этот этап расходует лимиты или API-баланс твоего подключения.")}</Text>
    {failed && <div className={styles.error} role="alert"><div><Text variant="label" medium>{ui("Подготовка остановлена")}</Text><Text variant="label">{state.error}</Text></div><Button variant="border" disabled={busy || run.paused} onClick={() => void act({ type: 'retryPreparation' })}>{ui("Повторить этап Codex")}</Button><Text variant="caption">{ui("Повтор расходует лимиты или API-баланс подключения. Уже сохранённый план используется повторно.")}</Text></div>}
    {!plan && !failed && <Text variant="label" tone="secondary">{broll ? ui("Codex придумывает самостоятельные B-roll по визуальному вектору.") : ui("Codex читает сценарий и визуальный вектор.")} {ui(" Готовый план появится здесь; медиа ждут окончания подготовки.")}</Text>}
    {plan && <>
      <Text as="h2" variant="title-s">{broll ? ui("Подборка B-roll") : plan.scene.title}</Text>
      {plan.artDirection && <div className={styles.notice}><Text variant="label" medium>{ui("Художественная идея")}</Text><Text variant="label">{plan.artDirection.concept}</Text><Text variant="label">{ui("Визуальный акцент: ")}{plan.artDirection.visualHook}</Text><Text variant="caption" tone="secondary">{ui("Характер изображения: ")}{plan.artDirection.captureTexture}</Text></div>}
      {scenes.map(scene => <details className={styles.detail} key={scene.id}><summary>{ui("Сцена · ")}{scene.title}</summary><dl className={styles.planFields}>{[[ui("Локация"), scene.location], [ui("Персонаж"), scene.subject], [ui("Одежда"), scene.wardrobe], [ui("Время"), scene.timeOfDay], [ui("Погода"), scene.weather], [ui("Свет"), scene.lighting], [ui("Палитра"), scene.palette]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><Text variant="label" medium>{ui("Сохраняется внутри этой сцены")}</Text><ul className={styles.planNotes}>{scene.continuity.map((note, i) => <li key={i}>{note}</li>)}</ul></details>)}
      {plan.assumptions.length > 0 && <div><Text variant="label" medium>{ui("Что режиссёр определил сам")}</Text><ul className={styles.planNotes}>{plan.assumptions.map((note, i) => <li key={i}>{note}</li>)}</ul></div>}
      {(plan.warnings.length > 0 || !!run.promptPlan?.warnings.length) && <div className={styles.notice}><Text variant="label" medium>{ui("Что учесть")}</Text><ul className={styles.planNotes}>{[...plan.warnings, ...(run.promptPlan?.warnings ?? [])].map((note, i) => <li key={i}>{note}</li>)}</ul></div>}
      {run.promptPlan?.masterPrompt && <details className={styles.detail}><summary>{ui("Prompt опорного кадра · Soul 2")}</summary><pre>{run.promptPlan.masterPrompt}</pre></details>}
      <div className={styles.shotPlan}>{plan.shots.map((shot, index) => {
        const prompts = run.promptPlan?.shots.find((p) => p.shotId === shot.id);
        return <article key={shot.id} className={styles.planShot}>
          <Text as="h3" variant="label" medium>{String(index + 1).padStart(2, '0')} · {shot.title}</Text>
          <Text variant="caption" tone="secondary">{shot.framing} · {shot.durationSec} {ui(" с по плану")}</Text>
          {shot.scriptExcerpt && <blockquote className={styles.scriptQuote}>{shot.scriptExcerpt}</blockquote>}
          {shot.concept && <Text variant="label">{ui("Идея: ")}{shot.concept}</Text>}
          {shot.beat && <Text variant="label">{ui("Смысл: ")}{shot.beat}</Text>}
          {shot.sceneId && <Text variant="caption" tone="secondary">{ui("Сцена: ")}{sceneForShot(plan, shot).title}</Text>}
          <Text variant="label">{shot.action}</Text><Text variant="label" tone="secondary">{shot.camera}</Text>
          {shot.startFrame && <Text variant="label">{ui("На стартовом фото: ")}{shot.startFrame}</Text>}
          <Text variant="caption" tone="secondary">{ui("Для монтажа: ")}{shot.purpose}</Text>
          {shot.visualAnchor && <Text variant="label">{ui("Визуальный приём: ")}{shot.visualAnchor}</Text>}
          {shot.intentionalEffect && <Text variant="caption" tone="secondary">{ui("Эффект по замыслу: ")}{shot.intentionalEffect}</Text>}
          {prompts ? <details className={styles.detail}><summary>{ui("Prompts кадра · фото и движение")}</summary><Text variant="caption" medium>{ui("Фото · Soul 2")}</Text><pre>{prompts.imagePrompt}</pre><Text variant="caption" medium>{ui("Движение · будущий Seedance 2.5 · запуск отключён")}</Text><pre>{prompts.motionPrompt}</pre></details> : <Text variant="caption" tone="tertiary">{ui("Prompts появятся после второго агента.")}</Text>}
        </article>;
      })}</div>
      <Text variant="caption" tone="secondary">{run.mode === 'photos' ? hasStoryEvents(plan) ? ui("У каждой {0} — самостоятельный кадр. Soul ID и профиль сохраняют внешность; композиция master не переносится. Критик проверит {1} перед приёмкой. Видео и upscale отключены.", broll ? ui("идеи") : ui("событийной сцены"), broll ? ui("реализацию замысла и детали") : ui("события")) : ui("Старый план с общим reference сцены. Новая режиссура по сценарию создаёт отдельные события и допускает разные локации.") : ui("Это текстовый план Codex; далее используются условные mock-файлы. Они не иллюстрируют события плана.")}</Text>
    </>}
    {calls.length > 0 && <details className={styles.detail}><summary>{ui("Вызовы Codex и расход квоты")}</summary><ul className={styles.planNotes}>{calls.map((c, i) => <li key={i}>{c.stage === 'scene' ? ui("Режиссёр") : 'Prompts'} · {c.model ?? ui("модель не указана")} · {Math.round(c.durationMs / 1000)} {ui(" с · ")}{c.status === 'accepted' ? ui("ответ принят") : c.message} · input {c.inputTokens ?? ui("неизвестно")} / output {c.outputTokens ?? ui("неизвестно")}</li>)}</ul></details>}
  </>;
}
