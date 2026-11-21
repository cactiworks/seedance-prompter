import { Dialog as RadixDialog } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import type { CanvasAiRun, CanvasAiPreview } from '../../core/model/canvasAi.ts';
import type { CanvasAiVersion, CanvasNode, Flow } from '../../core/model/canvas.ts';
import { aiInputContext, aiPromptProblems, promptIdeaSource } from '../../core/canvas/ai.ts';
import { inputFingerprint } from '../../core/canvas/freshness.ts';
import { findModel } from '../../core/gen/models.ts';
import { savedMediaOf, thumbOf, useGen } from '../gen/genStore.ts';
import { ui } from '../language.ts';
import { referenceImageUrl } from '../references/api.ts';
import { Button, Icon, Text } from '../ui/components/index.ts';
import { canvasAiApi, CanvasAiApiError, canvasAiPreview, canvasAiRuns, currentCanvasFlow, type CanvasAiResponse } from './canvasAiApi.ts';
import { useCanvas } from './canvasStore.ts';
import { nodeTitle } from './nodeTitle.ts';
import styles from './CanvasAi.module.css';

const STATUS_RU: Record<CanvasAiRun['status'], string> = {
  running: 'AI работает', ready: 'Ждёт твоей проверки', approved: 'Одобрено', failed: 'Ошибка подготовки',
  cancelled: 'Остановлено', interrupted: 'Прервано — повтор только по клику',
};

const approved = (version: CanvasAiVersion | null | undefined, flow: Flow, node: CanvasNode): boolean =>
  !!version?.approval && !node.stale && version.approval.versionId === version.id
  && version.approval.inputFingerprint === inputFingerprint(flow, node.id)
  && version.inputFingerprint === version.approval.inputFingerprint;

/** The card stays compact. Conversations and stage controls live outside the transformed graph. */
export function AiNodeCard({ node }: { node: CanvasNode }) {
  const { flow, openAi } = useCanvas();
  useEffect(() => {
    if (!flow || node.ai?.status !== 'running') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const state = useCanvas.getState();
      const captured = state.flow;
      try {
        if (captured?.id === flow.id) {
          const saved = await currentCanvasFlow(flow.id);
          if (!stopped && (saved.rev ?? 0) > (captured.rev ?? 0)) useCanvas.getState().applyServerFlow(saved, captured);
        }
      } catch { /* The drawer displays actionable status errors. Polling never starts work. */ }
      if (!stopped) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [flow?.id, node.ai?.status]);
  const target = flow?.nodes.find(n => n.id === node.targetGeneratorId);
  const version = node.ai?.idea;
  const promptNode = flow?.nodes.find(n => n.type === 'prompt' && promptIdeaSource(flow, n)?.id === node.id);
  const changed = !!node.stale && !!(node.ai?.idea || node.ai?.prompt);
  return <>
    <Text variant="caption" tone="secondary">{target ? nodeTitle(target) : ui('Выбери целевую генерацию')}</Text>
    <Text variant="label" className={styles.cardSummary}>{version?.text || ui('Подключи комментарий и предложи AI разработать один шот.')}</Text>
    <Text variant="caption" tone={changed ? 'accent' : 'secondary'} role="status">{
      changed ? ui('Вход изменился · нужна повторная проверка')
        : node.ai?.status === 'running' && node.ai.stage === 'idea' ? ui('AI разрабатывает идею')
          : node.ai?.stage === 'idea' && node.ai.errorRu ? node.ai.errorRu
            : flow && approved(node.ai?.idea, flow, node) ? ui('Идея одобрена · следующий шаг: AI · промпт')
              : node.ai?.idea ? ui('Идея ждёт твоего решения') : ui('Идея ещё не подготовлена')
    }</Text>
    <Button variant="border" size="s" onClick={() => openAi(node.id, 'idea')}>
      {ui('Обсудить идею')}
    </Button>
    {flow && approved(node.ai?.idea, flow, node) && <Button variant="dark" size="s" onClick={() => {
      const id = promptNode?.id ?? useCanvas.getState().addAiPrompt(node.id);
      if (id) { useCanvas.getState().focusNode(id); openAi(node.id, 'prompt'); }
    }}>{ui('Перейти к AI · промпт')}</Button>}
  </>;
}

export function ManagedPromptCard({ node }: { node: CanvasNode }) {
  const { flow, openAi } = useCanvas();
  const source = flow ? promptIdeaSource(flow, node) : undefined;
  const problems = flow ? aiPromptProblems(flow, node) : [];
  const working = source?.ai?.stage === 'prompt' && source.ai.status === 'running';
  const promptError = source?.ai?.stage === 'prompt' ? source.ai.errorRu : null;
  const idea = source?.ai?.idea;
  const ideaCurrent = !!flow && !!source && approved(idea, flow, source);
  return <>
    <Text variant="caption" tone="secondary">{ui('Вход: одобренная идея → выход: prompt для модели')}</Text>
    {idea && <div className={styles.ideaPreview}><Text variant="caption" tone="secondary">{ui('Идея из связанной ноды')}</Text><Text variant="label" className={styles.cardSummary}>{idea.text}</Text></div>}
    <Text variant="caption" tone={problems.length ? 'accent' : 'secondary'} role="status">{working ? ui('AI собирает промпт') : promptError || (problems[0] ? ui(problems[0]) : ui('Точная версия prompt одобрена'))}</Text>
    {node.text ? <pre className={styles.promptPreview}>{node.text}</pre> : <Text variant="label" tone="secondary">{ui(ideaCurrent ? 'Идея одобрена. Открой этот блок, чтобы собрать промпт для модели.' : 'Prompt ещё не собран. Открой этот блок после одобрения идеи.')}</Text>}
    <Button variant={node.text ? 'border' : 'dark'} size="s" disabled={!source} onClick={() => source && openAi(source.id, 'prompt')}>
      {ui(node.text ? 'Обсудить промпт' : 'Открыть AI · промпт')}
    </Button>
    {!ideaCurrent && source && <Button variant="ghost" size="s" onClick={() => { useCanvas.getState().focusNode(source.id); openAi(source.id, 'idea'); }}>{ui('Перейти к идее')}</Button>}
    <Text variant="caption" tone="tertiary">{ui('Правки — в обсуждении по-русски. Генерация запускается отдельно.')}</Text>
  </>;
}

/** Human decisions are separate from preparation and never submit a generation request. */
export function ManagedGenerationActions({ node }: { node: CanvasNode }) {
  const { flow, createCorrectionBranch } = useCanvas();
  const jobs = useGen(s => s.jobs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!flow?.nodes.some(n => n.type === 'ai' && n.targetGeneratorId === node.id)) return null;
  const jobId = node.jobIds[node.selected];
  const mediaId = jobId ? savedMediaOf(jobs, jobId) : null;
  if (!jobId || !mediaId) return null;
  const accepted = node.acceptedJobId === jobId && node.acceptedMediaId === mediaId;
  const accept = async () => {
    setBusy(true); setError('');
    try {
      if (!await useCanvas.getState().flush()) throw new Error('Сначала сохрани изменения холста.');
      const snapshot = useCanvas.getState().flow;
      if (!snapshot || snapshot.id !== flow.id) return;
      const saved = await canvasAiApi<Flow>('/api/canvas-ai/accept-media', { flowId: snapshot.id, nodeId: node.id, flow: snapshot, jobId, mediaId });
      if (!useCanvas.getState().applyServerFlow(saved, snapshot)) throw new Error('Выбор сохранён на сервере. На холсте появились новые правки; обнови его после сохранения.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось принять фото.'); }
    finally { setBusy(false); }
  };
  return <>
    {node.kind === 'image' && <Button variant="border" size="s" loading={busy} disabled={accepted || node.stale} onClick={() => void accept()}>{accepted ? ui('Фото принято для видео') : ui('Принять фото для видео')}</Button>}
    <Button variant="ghost" size="s" disabled={busy} onClick={() => createCorrectionBranch(node.id)}>{ui('Создать ветку правок')}</Button>
    {node.kind === 'video' && <Text variant="caption" tone="tertiary">{ui('В ветке правок опиши дефект текстом. AI не просматривает видео и не получает его звук.')}</Text>}
    {error && <Text variant="caption" tone="accent" role="alert">{error}</Text>}
  </>;
}

/** Reading status never starts or retries a model call. Closing the drawer does not cancel a run. */
export function CanvasAiDrawer() {
  const { flow, aiDrawer, closeAi, openAi, patchNode } = useCanvas();
  const save = useCanvas(s => s.save);
  const node = flow?.nodes.find(n => n.id === aiDrawer?.nodeId && n.type === 'ai');
  const jobs = useGen(s => s.jobs);
  const [runs, setRuns] = useState<CanvasAiRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [preview, setPreview] = useState<CanvasAiPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [consent, setConsent] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const nodeId = node?.id;
  const flowId = flow?.id;
  const stage = aiDrawer?.stage ?? 'idea';
  const draftKey = `${flowId}:${nodeId}:${stage}`;
  const feedback = drafts[draftKey] ?? '';
  const consentContext = flow && node ? inputFingerprint(flow, node.id) : '';

  useEffect(() => { setConsent(false); setError(''); setPollError(''); setRuns([]); }, [flowId, nodeId]);
  useEffect(() => { setConsent(false); }, [consentContext]);
  useEffect(() => {
    setPreview(null); setPreviewError('');
    if (!flowId || !nodeId || save !== 'saved') return;
    let stopped = false;
    const captured = useCanvas.getState().flow;
    void canvasAiPreview(flowId, nodeId).then(value => {
      if (!stopped && useCanvas.getState().flow === captured) setPreview(value);
    }).catch((e: unknown) => { if (!stopped) setPreviewError(e instanceof Error ? e.message : 'Не удалось проверить входы AI.'); });
    return () => { stopped = true; };
  }, [flowId, nodeId, flow?.rev, consentContext, save, refresh]);
  useEffect(() => {
    if (!flowId || !nodeId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const list = await canvasAiRuns(flowId, nodeId);
        if (stopped) return;
        setRuns(list); setPollError('');
        // Completion may materialize a prompt on the server. The store rebases pending browser edits.
        const local = useCanvas.getState();
        const captured = local.flow;
        if (captured?.id === flowId) {
          const saved = await currentCanvasFlow(flowId);
          if (!stopped && (saved.rev ?? 0) > (captured.rev ?? 0)) useCanvas.getState().applyServerFlow(saved, captured);
        }
        if (!stopped) timer = setTimeout(() => void poll(), list.some(r => r.status === 'running') ? 1500 : 6000);
      } catch (e) {
        if (!stopped) { setPollError(e instanceof Error ? e.message : 'Статус AI недоступен.'); timer = setTimeout(() => void poll(), 6000); }
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [flowId, nodeId, refresh]);

  if (!flow || !node || !aiDrawer) return null;
  const context = aiInputContext(flow, node.id, id => savedMediaOf(jobs, id));
  const target = context.target;
  const activeRun = runs.find(run => run.status === 'running');
  const latest = runs.find(run => run.stage === stage);
  const ideaApproved = approved(node.ai?.idea, flow, node);
  const targetModel = target ? findModel(target.modelId) : undefined;
  const previewCurrent = !!preview && preview.flowId === flow.id && preview.flowRev === flow.rev && preview.inputFingerprint === context.inputFingerprint && save === 'saved';
  const missingIdentity = !!target?.params.soulId && !preview?.snapshot.identity?.uploadIds.length;
  const canStart = context.problems.length === 0 && !!target && previewCurrent && (stage === 'idea' || (ideaApproved && !missingIdentity));
  const mutate = async (path: string, body: (snapshot: Flow) => unknown, clearDraft = false): Promise<void> => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (!await useCanvas.getState().flush()) throw new Error('Сначала сохрани изменения холста.');
      const snapshot = useCanvas.getState().flow;
      if (!snapshot || snapshot.id !== flow.id || !snapshot.nodes.some(n => n.id === node.id)) throw new Error('Холст или AI-нода изменились.');
      const result = await canvasAiApi<CanvasAiResponse>(path, body(snapshot));
      if (!useCanvas.getState().applyServerFlow(result.flow, snapshot)) throw new Error('AI сохранил результат. На холсте появились новые правки; обнови статус после сохранения.');
      setRuns(previous => [result.run, ...previous.filter(run => run.id !== result.run.id)]);
      if (clearDraft) setDrafts(previous => ({ ...previous, [draftKey]: '' }));
      setRefresh(value => value + 1);
      if (result.run.stage === 'idea' && result.run.status === 'approved' && /\/(approve|revalidate|restore|prompt-node)$/.test(path)) {
        const prompt = result.flow.nodes.find(n => n.type === 'prompt' && promptIdeaSource(result.flow, n)?.id === node.id);
        if (prompt) useCanvas.getState().focusNode(prompt.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Действие не выполнено.');
      if (e instanceof CanvasAiApiError && e.code === 'PREVIEW_CHANGED') {
        setPreview(null); setConsent(false); setRefresh(value => value + 1);
      }
    }
    finally { setBusy(false); }
  };
  const start = () => {
    if (!previewCurrent || !preview) return;
    void mutate('/api/canvas-ai/runs', snapshot => ({
      flowId: snapshot.id, nodeId: node.id, stage, requestId: crypto.randomUUID(), flow: snapshot, feedbackRu: feedback.trim(), previewDigest: preview.snapshot.contextDigest, consent: true,
    }), true);
  };
  const review = (run: CanvasAiRun, revalidate = false) => void mutate(`/api/canvas-ai/runs/${encodeURIComponent(run.id)}/${revalidate ? 'revalidate' : 'approve'}`, snapshot => ({ flow: snapshot, expectedRevision: run.revision }));
  const shown = runs.filter(run => run.stage === stage).reverse();

  return <RadixDialog.Root open onOpenChange={open => { if (!open) closeAi(); }}>
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={styles.overlay} />
      <RadixDialog.Content className={styles.drawer} aria-describedby={undefined}
        onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={event => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus({ preventScroll: true }); } }}>
        <header className={styles.header}>
          <div><RadixDialog.Title asChild><Text as="h2" variant="title-s">{ui(stage === 'idea' ? 'AI · идея' : 'AI · промпт')}</Text></RadixDialog.Title><Text variant="caption" tone="secondary">{stage === 'idea' ? node.label || ui('Разработка одного шота') : ui('Промпт по одобренной идее')}</Text></div>
          <RadixDialog.Close asChild><Button variant="ghost" size="s" iconOnly aria-label={ui('Закрыть обсуждение')} icon={<Icon name="close" />} /></RadixDialog.Close>
        </header>
        <div className={styles.body}>
          <section className={styles.context} aria-label={ui('Контекст AI')}>
            <label className={styles.field}><Text as="span" variant="caption" tone="secondary">{ui('Целевая генерация')}</Text>
              <select value={node.targetGeneratorId ?? ''} disabled={stage === 'prompt' || busy || !!activeRun} onChange={event => patchNode(node.id, { targetGeneratorId: event.target.value || null })}>
                <option value="">{ui('Выбери ноду генерации')}</option>
                {flow.nodes.filter(n => n.type === 'generator' && (n.modelId.includes('soul') || n.modelId.includes('seedance'))).map(n => <option key={n.id} value={n.id}>{nodeTitle(n)} · {n.label || n.id.slice(-5)}</option>)}
              </select>
            </label>
            <Text variant="caption" tone="secondary">{ui('Параметры задаются в ноде генерации. AI учитывает их и подключённые изображения.')}</Text>
            {target && <details className={styles.details}><summary>{ui('Входы и параметры')}</summary>
              <Text variant="caption">{targetModel?.titleRu ?? target.modelId}</Text>
              <pre>{JSON.stringify(target.params, null, 2)}</pre>
              {context.contexts.map(item => <div key={item.nodeId}><Text variant="caption" tone="secondary">{ui('Комментарий')}</Text><Text variant="label" className={styles.preserve}>{item.text}</Text></div>)}
              {target.params.enhancePrompt === true && <Text variant="caption" tone="accent">{ui('Enhance prompt включён: провайдер может изменить текст внутри модели.')}</Text>}
            </details>}
            {!previewCurrent && !previewError && <Text variant="caption" tone="secondary" role="status">{save === 'saved' ? ui('Проверяю входы AI…') : ui('Сохрани изменения, чтобы проверить входы AI.')}</Text>}
            {previewError && <Text variant="caption" tone="accent" role="alert">{previewError}</Text>}
            {previewCurrent && preview && <>
              {(!preview.snapshot.libraryRefs || preview.snapshot.refs.length > 0) && <div>
                <Text variant="caption" medium>{ui(preview.snapshot.libraryRefs ? 'Изображения из нод · {0}' : 'Изображения для AI · {0}', preview.snapshot.refs.length)}</Text>
                {preview.snapshot.refs.length > 0 ? <div className={styles.references}>{preview.snapshot.refs.map((ref, i) => <figure key={i}><img src={thumbOf(ref.source)} alt={ref.label} /><Text as="figcaption" variant="caption">{ref.label}</Text></figure>)}</div> : <Text variant="caption" tone="secondary">{ui('Не подключены')}</Text>}
              </div>}
              {preview.snapshot.libraryRefs && <div>
                <Text variant="caption" medium>{ui('Подборка из библиотеки · {0}', preview.snapshot.libraryRefs.length)}</Text>
                <Text variant="caption" tone="secondary">{ui(stage === 'idea' ? 'Кадры и приёмы войдут в контекст идеи.' : 'В промптинг войдут роли и описание приёмов.')}</Text>
                <div className={styles.references}>{preview.snapshot.libraryRefs.map(ref => <figure key={ref.selection.id}>
                  <img src={referenceImageUrl(ref.selection.id)} alt={ref.sourceName} />
                  <Text as="figcaption" variant="caption">{ref.selection.role}</Text>
                </figure>)}</div>
                <details className={styles.details}><summary>{ui('Приёмы из подборки')}</summary>
                  {preview.snapshot.libraryRefs.map(ref => <Text key={ref.selection.id} variant="caption" tone="secondary">{ref.selection.role} · {ref.transfer}</Text>)}
                </details>
              </div>}
              {preview.snapshot.identity && <div><Text variant="caption" medium>{ui('Внешность · {0}', preview.snapshot.identity.name)}</Text><div className={styles.references}>{preview.snapshot.identity.uploadIds.map((uploadId, i) => <figure key={uploadId}><img src={thumbOf({ type: 'upload', uploadId })} alt={ui('Фото внешности {0}', i + 1)} /><Text as="figcaption" variant="caption">{ui('Фото {0}', i + 1)}</Text></figure>)}</div></div>}
              <div><Text variant="caption" medium>{ui('Референсы генерации · {0}', preview.snapshot.generationRefs.length)}</Text>{preview.snapshot.generationRefs.length > 0 ? <div className={styles.references}>{preview.snapshot.generationRefs.map((ref, i) => <figure key={i}><img src={thumbOf(ref.source)} alt={ref.label} /><Text as="figcaption" variant="caption">{ui(ref.role === 'start' ? 'Старт' : ref.role === 'end' ? 'Финал' : 'Реф')} · {ref.label}</Text></figure>)}</div> : <Text variant="caption" tone="secondary">{ui('Не передаются')}</Text>}</div>
              {preview.warningsRu.map((warning, i) => <Text key={i} variant="caption" tone="accent">{warning}</Text>)}
            </>}
            {stage === 'prompt' && node.ai?.idea && <details className={styles.details}><summary>{ui(ideaApproved ? 'Одобренная идея' : 'Текущая идея')}</summary><Text variant="label" className={styles.preserve}>{node.ai.idea.text}</Text></details>}
            {node.stale && (node.ai?.idea || node.ai?.prompt) && <Text variant="caption" tone="accent">{ui('Вход изменился. Прежние одобрения требуют пересмотра.')}</Text>}
            {context.problems.map((problem, i) => <Text key={`${problem}:${i}`} variant="caption" tone="accent">{ui(problem)}</Text>)}
          </section>

          {stage === 'prompt' && !ideaApproved && <div className={styles.nextStep}><Text variant="caption" tone="secondary">{ui('Сначала одобри актуальную идею в связанной AI-ноде.')}</Text><Button variant="border" size="s" onClick={() => { useCanvas.getState().focusNode(node.id); openAi(node.id, 'idea'); }}>{ui('Перейти к идее')}</Button></div>}

          <section className={styles.history} aria-label={ui(stage === 'idea' ? 'История идей' : 'История промптов')}>
            {shown.length === 0 && <Text variant="label" tone="secondary">{stage === 'idea' ? ui('AI сначала предложит решение. Все дополнения будут видны, а качество ты проверишь сам.') : ui('Prompt ещё не собран. Нажми «Собрать prompt», чтобы перевести одобренную идею для выбранной модели.')}</Text>}
            {shown.map(run => <article className={styles.message} key={run.id}>
              {run.feedbackRu && <div className={styles.ownerMessage}><Text variant="caption" tone="secondary">{ui('Ты · {0}', run.stage === 'idea' ? ui('идея') : 'prompt')}</Text><Text variant="label" className={styles.preserve}>{run.feedbackRu}</Text></div>}
              <div className={styles.messageHead}><Text variant="caption" medium>{run.stage === 'idea' ? ui('Идея') : 'Prompt'} · {new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text><Text variant="caption" tone="secondary" role="status">{ui(STATUS_RU[run.status])}</Text></div>
              {run.version && <Text as={run.stage === 'prompt' ? 'pre' : 'p'} variant="label" mono={run.stage === 'prompt'} className={styles.preserve}>{run.version.text}</Text>}
              {run.summaryRu && run.summaryRu !== run.version?.text && <Text variant="label" className={styles.preserve}>{run.summaryRu}</Text>}
              {!!run.assumptionsRu.length && <div><Text variant="caption" medium>{ui('Дополнения AI')}</Text>{run.assumptionsRu.map((item, i) => <Text key={i} variant="label" className={styles.preserve}>{item}</Text>)}</div>}
              {!!run.referenceNotesRu.length && <div><Text variant="caption" medium>{ui('Как учтены изображения')}</Text>{run.referenceNotesRu.map((item, i) => <Text key={i} variant="label" className={styles.preserve}>{item}</Text>)}</div>}
              {run.errorRu && <Text variant="caption" tone="accent" role="alert">{run.errorRu}</Text>}
              {run.snapshot.identity && <Text variant="caption" tone="secondary">{ui('Персонаж: {0} · фото внешности: {1}', run.snapshot.identity.name, run.snapshot.identity.uploadIds.length)}</Text>}
              {!!run.calls.length && <details className={styles.details}><summary>{ui('Ход выполнения')}</summary>{run.calls.map((call, i) => <Text key={i} variant="caption" tone="secondary">{call.stage} · {call.status}{call.errorRu ? ` · ${call.errorRu}` : ''}</Text>)}</details>}
              {latest?.id === run.id && run.status === 'ready' && run.inputFingerprint === context.inputFingerprint && !node.stale && <Button variant="border" size="s" disabled={busy || !!activeRun || (run.stage === 'prompt' && !ideaApproved)} onClick={() => review(run)}>{run.stage === 'idea' ? ui('Одобрить идею') : ui('Одобрить точный prompt')}</Button>}
              {(run.status === 'approved' || (latest?.id === run.id && run.status === 'ready')) && (node.stale || run.inputFingerprint !== context.inputFingerprint) && <Button variant="border" size="s" disabled={busy || !!activeRun || (run.stage === 'prompt' && !ideaApproved)} onClick={() => review(run, true)}>{ui('Перепроверил · одобрить для новых входов')}</Button>}
              {run.status === 'approved' && run.version && run.inputFingerprint === context.inputFingerprint && node.ai?.[run.stage]?.id !== run.version.id && <Button variant="border" size="s" disabled={busy || !!activeRun} onClick={() => void mutate(`/api/canvas-ai/runs/${encodeURIComponent(run.id)}/restore`, snapshot => ({ flow: snapshot, expectedRevision: run.revision }))}>{ui(run.stage === 'idea' ? 'Вернуть одобренную идею' : 'Вернуть одобренный промпт')}</Button>}
              {run.stage === 'idea' && run.status === 'approved' && run.version?.id === node.ai?.idea?.id && ideaApproved && <Button variant="dark" size="s" disabled={busy || !!activeRun} onClick={() => { const id = useCanvas.getState().addAiPrompt(node.id); if (id) { useCanvas.getState().focusNode(id); openAi(node.id, 'prompt'); } }}>{ui('Перейти к AI · промпт')}</Button>}
              {latest?.id === run.id && ['failed', 'cancelled', 'interrupted'].includes(run.status) && <Button variant="border" size="s" disabled={busy || !consent || !canStart || !!activeRun} onClick={() => {
                if (!previewCurrent || !preview) return;
                void mutate(`/api/canvas-ai/runs/${encodeURIComponent(run.id)}/retry`, snapshot => ({ flow: snapshot, requestId: crypto.randomUUID(), previewDigest: preview.snapshot.contextDigest, consent: true }));
              }}>{ui('Повторить этот шаг')}</Button>}
            </article>)}
          </section>
        </div>
        <footer className={styles.footer}>
          {(error || pollError) && <Text variant="caption" tone="accent" role="alert">{error || pollError}</Text>}
          <label className={styles.field}><Text as="span" variant="caption" tone="secondary">{stage === 'idea' ? ui('Задача или правки к идее') : ui('Правки к prompt по-русски')}</Text>
            <textarea rows={3} value={feedback} onChange={event => setDrafts(previous => ({ ...previous, [draftKey]: event.target.value }))} placeholder={ui('Опиши, что сохранить и что изменить…')} disabled={busy || !!activeRun} />
          </label>
          <label className={styles.consent}><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy || !!activeRun || !previewCurrent} /><Text as="span" variant="caption">{ui('Передать контекст, подключённые изображения и до 6 фото выбранного Soul ID в моё AI-подключение. Один запуск по клику.')}</Text></label>
          <div className={styles.actions}>
            {activeRun ? <Button variant="border" size="s" disabled={busy} onClick={() => void mutate(`/api/canvas-ai/runs/${encodeURIComponent(activeRun.id)}/cancel`, snapshot => ({ flow: snapshot }))}>{ui('Остановить AI')}</Button>
              : <Button variant="dark" size="s" loading={busy} disabled={!consent || !canStart} icon={<Icon name="sparkles" size={1} />} onClick={start}>{stage === 'idea' ? ui(node.ai?.idea ? 'Предложить правку идеи' : 'Предложить идею') : ui(node.ai?.prompt ? 'Пересобрать prompt' : 'Собрать prompt')}</Button>}
            <Button variant="ghost" size="s" onClick={() => setRefresh(value => value + 1)}>{ui('Обновить статус')}</Button>
          </div>
        </footer>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}
