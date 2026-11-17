import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { aiInputContext, aiPromptProblems } from '../../core/canvas/ai.ts';
import { inputFingerprint } from '../../core/canvas/freshness.ts';
import { planRun } from '../../core/canvas/plan.ts';
import { withLearnings } from '../../core/gen/calibration.ts';
import { findModel, paramsFor } from '../../core/gen/models.ts';
import { cardFile, EMPTY_SHOT, validatePrompter, type PrompterRef } from '../../core/llm/buildPrompter.ts';
import type { CanvasAiPreview } from '../../core/model/canvasAi.ts';
import { CanvasNodeSchema, FlowSchema, type CanvasAiVersion, type Flow } from '../../core/model/canvas.ts';
import type { CanvasOrigin, RefSource } from '../../core/model/media.ts';
import { characterReady } from '../../core/production/character.ts';
import { imageSize } from '../gen/imageSize.ts';
import type { GenRuntime } from '../gen/runtime.ts';
import type { ImageInput } from '../llm/codexCli/args.ts';
import { DEFAULT_LLM_MODEL, LlmError, runCodex } from '../llm/codexCli/provider.ts';
import type { Runner } from '../llm/tasks/write.ts';
import type { Characters } from '../production/characters.ts';
import { visionCopy } from '../production/vision.ts';
import type { Flows } from '../storage/flows.ts';
import { createStore } from '../storage/fsStore.ts';
import { createJournal } from '../storage/journal.ts';
import { createCanvasAiStore } from './store.ts';
import { IDEA_SYSTEM, IdeaOutputSchema, PROMPT_SYSTEM, PromptOutputSchema } from './prompts.ts';
import { CanvasAiError, publicRun, type CanvasAiRun, type CanvasAiSnapshot, type StoredCanvasAiRun } from './types.ts';

const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const fail = (code: string, message: string, status: 404 | 409 | 422 = 422): never => { throw new CanvasAiError(code, message, status); };
const MAX_IMAGES = 14;
interface StartInput { flowId: string; nodeId: string; stage: 'idea' | 'prompt'; requestId: string; flow: Flow; feedbackRu: string; previewDigest: string }
interface SnapshotResult { snapshot: CanvasAiSnapshot; images: ImageInput[]; modelCard: string; inputFingerprint: string; parentRunId: string | null }

export function createCanvasAi(options: { dataDir: string; rootDir: string; flows: Flows; gen: GenRuntime; characters: Characters; runLlm?: Runner; runLlmForAccount?: (id?: string) => Runner; model?: string }) {
  const store = createCanvasAiStore(options.dataDir);
  const projects = createStore(options.dataDir);
  const journal = createJournal(options.dataDir);
  const pending = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const llmModel = options.model ?? process.env.SP_CANVAS_AI_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL;

  async function required(id: string): Promise<StoredCanvasAiRun> { return await store.get(id) ?? fail('NOT_FOUND', 'AI-запуск не найден.', 404); }
  async function mediaMap() {
    const jobs = await options.gen.jobs.all();
    const map = new Map(jobs.map(j => [j.id, j.status === 'saved' ? j.mediaIds.find((id): id is string => id !== null) ?? null : null]));
    return (id: string) => map.get(id) ?? null;
  }
  async function savedSnapshot(raw: Flow, flowId = raw.id): Promise<Flow> {
    const snapshot = FlowSchema.parse(raw);
    const saved = await options.flows.get(flowId);
    if (!saved) return fail('NOT_FOUND', 'Холст не найден.', 404);
    if (snapshot.id !== saved.id || snapshot.rev !== saved.rev || JSON.stringify({ ...snapshot, updatedAt: saved.updatedAt }) !== JSON.stringify(saved)) return fail('FLOW_CONFLICT', 'Холст изменился. Сохрани текущий черновик и повтори действие.', 409);
    return saved;
  }
  async function readImage(source: RefSource): Promise<ImageInput> {
    let bytes: Uint8Array; let mime: string;
    if (source.type === 'upload') {
      const value = await options.gen.uploads.read(source.uploadId);
      if (!value) return fail('REF_NOT_FOUND', 'Загруженный AI-референс не найден.');
      bytes = value.bytes; mime = value.upload.mime;
    } else if (source.type === 'projectRef') {
      bytes = await projects.readRef(source.slug, source.file.split('?')[0] ?? '');
      mime = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<string, string>)[source.file.split('?')[0]?.split('.').pop() ?? ''] ?? '';
    } else {
      const item = await options.gen.library.get(source.mediaId);
      if (!item || item.kind !== 'image') return fail('REF_NOT_IMAGE', 'AI-нода принимает только сохранённые изображения.');
      bytes = await options.gen.library.readBytes(item); mime = item.mime;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) || bytes.byteLength > 30 * 1024 * 1024) return fail('BAD_IMAGE', 'Нужен JPG, PNG или WebP до 30 МБ.');
    const size = imageSize(bytes);
    if (!size) return fail('BAD_IMAGE', 'Не удалось прочитать изображение AI-референса.');
    if (bytes.byteLength > 3 * 1024 * 1024 || Math.max(size.width, size.height) > 1568) return visionCopy(bytes);
    return { mediaType: mime as ImageInput['mediaType'], base64: Buffer.from(bytes).toString('base64') };
  }
  async function context(flow: Flow, nodeId: string, stage: 'idea' | 'prompt', previewDigest?: string): Promise<SnapshotResult> {
    const mediaOf = await mediaMap();
    const input = aiInputContext(flow, nodeId, mediaOf);
    if (input.problems.length) return fail('INVALID_CONTEXT', input.problems.join(' '));
    const node = flow.nodes.find(n => n.id === nodeId)!;
    const target = input.target!;
    const model = findModel(target.modelId)!;
    if (!['higgsfield/soul-2', 'higgsfield/seedance-2-5'].includes(model.id) || model.kind !== target.kind || model.tool) return fail('BAD_MODEL', 'Выбери модель нужного вида для генератора.');
    const modelCard = withLearnings(await readFile(path.join(options.rootDir, 'packs/prompter/models', cardFile(model.id)), 'utf8'), (await journal.learnings.list()).filter(l => findModel(l.modelId)?.id === model.id));
    const generationRefs = planRun(flow, target.id, mediaOf).refs;
    const snapshot: CanvasAiSnapshot = { taskRu: node.text.trim(), contexts: input.contexts, refs: input.refs, generationRefs,
      target: { id: target.id, kind: target.kind, modelId: model.id, params: paramsFor(model, target.params) }, identity: null,
      attachments: [], approvedIdeaVersionId: null, modelCardHash: hash(modelCard), contextDigest: '' };
    const images: ImageInput[] = [];
    const add = async (source: RefSource, role: 'context' | 'generation' | 'identity', label: string) => {
      if (images.length >= MAX_IMAGES) return fail('TOO_MANY_REFS', 'К AI можно передать до восьми референсов и шести фото выбранного Soul ID.');
      const image = await readImage(source); images.push(image);
      snapshot.attachments.push({ file: `image-${images.length}.${({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const)[image.mediaType]}`, mediaType: image.mediaType, sha256: hash(image.base64), role, label });
    };
    const seen = new Set<string>();
    if (input.refs.length > 8) return fail('TOO_MANY_REFS', 'Подключи к AI не больше восьми референсов.');
    for (const ref of input.refs) {
      const key = JSON.stringify(ref.source); if (seen.has(key)) continue; seen.add(key); await add(ref.source, 'context', ref.label);
    }
    const soulId = target.params.soulId;
    if (typeof soulId === 'string' && soulId.trim()) {
      const character = (await options.characters.listStored()).find(c => c.referenceId === soulId && characterReady(c));
      if (!character && stage === 'prompt') return fail('IDENTITY_NOT_FOUND', 'Выбранный Soul ID не найден среди готовых персонажей с локальными фото.');
      const all = [...new Set(character?.uploadIds ?? [])];
      if (!all.length && stage === 'prompt') return fail('IDENTITY_REFS_MISSING', 'У выбранного Soul ID нет локальных фото. Добавь локальные референсы внешности.');
      const ids = all.length <= 6 ? all : Array.from({ length: 6 }, (_, i) => all[Math.round(i * (all.length - 1) / 5)]!);
      snapshot.identity = { characterId: character?.id ?? '', name: character?.name ?? 'Выбранный Soul ID', referenceId: soulId, uploadIds: ids };
      for (const id of ids) await add({ type: 'upload', uploadId: id }, 'identity', character?.name ?? 'Выбранный Soul ID');
    }
    if (previewDigest !== undefined && hash({ ...snapshot, approvedIdeaVersionId: null, contextDigest: '' }) !== previewDigest) return fail('PREVIEW_CHANGED', 'Набор входов изменился после просмотра. Обнови preview и проверь выбранные референсы перед новым запуском.', 409);
    let parentRunId: string | null = null;
    if (stage === 'prompt') {
      const idea = (await store.list(flow.id, nodeId)).find(r => r.stage === 'idea' && r.status === 'approved' && r.version?.id === node.ai?.idea?.id);
      if (!idea?.version?.approval || idea.inputFingerprint !== input.inputFingerprint || idea.version.approval.inputFingerprint !== input.inputFingerprint) return fail('IDEA_APPROVAL_REQUIRED', 'Сначала одобри актуальную идею.');
      snapshot.approvedIdeaVersionId = idea.version.id; parentRunId = idea.id;
    }
    if (stage === 'prompt' && parentRunId) {
      const approved = await required(parentRunId);
      const baseDigest = hash({ ...snapshot, approvedIdeaVersionId: null, contextDigest: '' });
      if (baseDigest !== approved.snapshot.contextDigest) return fail('STALE_IDEA', 'Референсы или правила модели изменились. Перепроверь и одобри идею для текущих входов.', 409);
    }
    snapshot.contextDigest = hash({ ...snapshot, contextDigest: '' });
    return { snapshot, images, modelCard, inputFingerprint: input.inputFingerprint, parentRunId };
  }

  async function project(run: StoredCanvasAiRun, materialize = false, setCurrent = false): Promise<Flow> {
    return options.flows.ensureProduction(run.flowId, '', flow => {
      const node = flow.nodes.find(n => n.id === run.nodeId && n.type === 'ai');
      if (!node || inputFingerprint(flow, node.id) !== run.inputFingerprint) return flow;
      // An older call may finish after a newer request; it cannot become the current projection.
      if (!setCurrent && node.ai?.runId && node.ai.runId !== run.id) return flow;
      const ai = { runId: run.id, status: run.status === 'running' ? 'running' as const : run.status === 'failed' ? 'failed' as const : run.status === 'interrupted' || run.status === 'cancelled' ? 'interrupted' as const : 'ready' as const,
        stage: run.stage, idea: node.ai?.idea ?? null, prompt: node.ai?.prompt ?? null, errorRu: run.errorRu };
      if (run.version) ai[run.stage] = run.version;
      if (run.status === 'running') ai[run.stage] = null;
      if (run.stage === 'idea') ai.prompt = null;
      let nodes = flow.nodes.map(n => n.id === node.id ? { ...n, ai, stale: false } : n.aiSource?.aiNodeId === node.id && (run.stage === 'idea' || run.status === 'running') ? { ...n, stale: true, aiApproval: undefined } : n);
      if (run.stage === 'idea' || run.status === 'running') nodes = nodes.map(n => n.id === node.targetGeneratorId ? { ...n, stale: true, acceptedJobId: null, acceptedMediaId: null } : n);
      let edges = flow.edges;
      if (materialize && run.stage === 'prompt' && run.version && node.targetGeneratorId) {
        const existing = nodes.find(n => n.type === 'prompt' && n.aiSource?.aiNodeId === node.id);
        const id = existing?.id ?? `p-${randomUUID()}`;
        const prompt = CanvasNodeSchema.parse({ ...existing, id, type: 'prompt', x: existing?.x ?? node.x + 370, y: existing?.y ?? node.y,
          text: run.version.text, stale: false, aiSource: { aiNodeId: node.id, versionId: run.version.id, inputFingerprint: run.inputFingerprint },
          aiApproval: run.version.approval ?? undefined });
        nodes = existing ? nodes.map(n => n.id === id ? prompt : n) : [...nodes, prompt];
        edges = flow.edges.filter(e => !(e.from === id && e.port === 'prompt') && !(e.to === id && e.port === 'idea'));
        edges = [...edges, { id: `e-${node.id}-${id}`, from: node.id, to: id, port: 'idea' as const }, { id: `e-${id}-${node.targetGeneratorId}`, from: id, to: node.targetGeneratorId, port: 'prompt' as const }];
      }
      return { ...flow, nodes, edges };
    });
  }

  function launch(run: StoredCanvasAiRun, images: ImageInput[], modelCard: string) {
    const controller = new AbortController();
    const job = { controller, done: Promise.resolve() }; pending.set(run.id, job);
    job.done = (async () => {
      try {
        const parent = run.parentRunId ? await required(run.parentRunId) : null;
        const history = (await store.list(run.flowId, run.nodeId)).filter(r => r.id !== run.id).reverse();
        const previous = [...history].reverse().find(r => r.stage === run.stage && r.version);
        const data = { ...run.snapshot, feedbackRu: run.feedbackRu, approvedIdeaRu: parent?.version?.text ?? null, previous: previous?.version?.text ?? null,
          priorFeedback: history.filter(r => r.feedbackRu).map(r => ({ stage: r.stage, feedbackRu: r.feedbackRu })),
          referenceRouting: run.snapshot.generationRefs.map((r, i, refs) => ({ label: r.role === 'start' ? 'first frame' : r.role === 'end' ? 'last frame' : findModel(run.snapshot.target.modelId)?.promptRefs === 'at-image' ? `@Image${refs.slice(0, i + 1).filter(x => x.role === 'ref').length}` : `image ${refs.slice(0, i + 1).filter(x => x.role === 'ref').length}`, how: r.role === 'ref' ? 'name this generation reference and its purpose' : 'describe motion from the frame; do not use an image number', role: r.role, source: r.source })) };
        const runner = options.runLlmForAccount ? options.runLlmForAccount(run.codexAccountId) : options.runLlm ?? runCodex;
        const llmInput = { system: `${run.stage === 'idea' ? IDEA_SYSTEM : PROMPT_SYSTEM}\n\n# Fixed model card\n${modelCard}`, user: JSON.stringify(data), model: llmModel };
        await store.update(run.id, current => { current.llmInput = llmInput; });
        if (controller.signal.aborted) return;
        const result = await runner<unknown>({ ...llmInput,
          jsonSchema: run.stage === 'idea' ? z.toJSONSchema(IdeaOutputSchema) : z.toJSONSchema(PromptOutputSchema),
          model: llmModel, effort: 'medium', images, timeoutMs: 180_000 + images.length * 15_000, signal: controller.signal, taskRu: run.stage === 'idea' ? 'Идея Canvas' : 'Промпт Canvas' });
        if (controller.signal.aborted) return;
        await store.update(run.id, current => { if (current.status === 'running') current.calls.at(-1)!.meta = result.meta; });
        const text = run.stage === 'idea' ? IdeaOutputSchema.parse(result.data).textRu : PromptOutputSchema.parse(result.data).prompt;
        if (run.stage === 'idea' && !/[А-Яа-яЁё]/.test(text)) return fail('INVALID_OUTPUT', 'Агент вернул идею не по-русски. Повтори этап явно.');
        if (run.stage === 'prompt') {
          const refs: PrompterRef[] = run.snapshot.generationRefs.map(r => ({ role: r.role === 'ref' ? 'other' : r.role, commentRu: r.label }));
          const problems = validatePrompter({ modelId: run.snapshot.target.modelId, prompt: text, params: [], styleName: '', reasonRu: 'Фиксированная модель', weakSpotsRu: [], alternativesRu: '' }, [findModel(run.snapshot.target.modelId)!], [], refs, EMPTY_SHOT);
          if (problems.length) return fail('INVALID_OUTPUT', `Промпт не прошёл проверку: ${problems.join(' ')}`);
        }
        const completed = await store.update(run.id, current => {
          if (current.status !== 'running' || controller.signal.aborted) return;
          const version: CanvasAiVersion = { id: `v-${randomUUID()}`, text, inputFingerprint: current.inputFingerprint, createdAt: stamp(), parentVersionId: current.snapshot.approvedIdeaVersionId, approval: null };
          current.version = version; current.versions.push(version); current.status = 'ready';
          if (run.stage === 'idea') { const output = IdeaOutputSchema.parse(result.data); current.assumptionsRu = output.assumptionsRu; current.referenceNotesRu = output.referenceNotesRu; }
          else { const output = PromptOutputSchema.parse(result.data); current.summaryRu = output.summaryRu; current.referenceNotesRu = output.referenceNotesRu; }
          const call = current.calls.at(-1)!; call.status = 'complete'; call.finishedAt = stamp(); call.meta = result.meta;
        });
        await project(completed, true);
      } catch (error) {
        const failed = await store.update(run.id, current => {
          if (current.status !== 'running') return;
          current.status = controller.signal.aborted ? 'cancelled' : 'failed';
          current.errorRu = controller.signal.aborted ? 'Вызов остановлен. Повтор запускается только по твоему действию.' : error instanceof LlmError ? error.messageRu : error instanceof CanvasAiError ? error.message : 'Ответ AI не прошёл проверку. История сохранена; автоматического повтора нет.';
          const call = current.calls.at(-1)!; call.status = controller.signal.aborted ? 'cancelled' : 'failed'; call.finishedAt = stamp(); call.errorRu = current.errorRu;
        });
        await project(failed);
      }
    })().catch(() => { /* The durable running record is recovered as interrupted, never replayed. */ }).finally(() => pending.delete(run.id));
  }

  async function recover(id: string) {
    let run = await required(id);
    if (run.status === 'running' && !pending.has(id)) {
      run = await store.update(id, current => {
        if (current.status !== 'running') return;
        current.status = 'interrupted'; current.errorRu = 'Сервер перезапущен. AI сам не повторяется; продолжи этап явным действием.';
        const call = current.calls.at(-1); if (call?.status === 'running') { call.status = 'interrupted'; call.finishedAt = stamp(); call.errorRu = current.errorRu; }
      });
      await project(run);
    }
    return run;
  }
  async function start(input: StartInput, accountId?: string) {
    const flow = await savedSnapshot(input.flow, input.flowId);
    if (!/^[a-f0-9]{64}$/.test(input.previewDigest)) return fail('PREVIEW_REQUIRED', 'Сначала просмотри актуальный набор входов AI.');
    if (options.runLlmForAccount && !accountId) return fail('ACCOUNT_REQUIRED', 'Подключи свой ChatGPT или API key перед запуском AI.');
    return store.exclusive(`${flow.id}-${input.nodeId}`, async () => {
      const prepared = await context(flow, input.nodeId, input.stage, input.previewDigest);
      const requestDigest = hash([input.flowId, input.nodeId, input.stage, prepared.inputFingerprint, prepared.snapshot.contextDigest, input.feedbackRu]);
      const id = `cai-${input.requestId}`;
      const prior = await store.get(id);
      if (prior) {
        if (prior.requestDigest !== requestDigest) return fail('REQUEST_CONFLICT', 'Этот requestId уже использован для другого контекста.', 409);
        return { run: publicRun(await recover(id)), flow: await options.flows.get(flow.id) ?? flow };
      }
      const running = (await store.list(flow.id, input.nodeId)).find(r => r.status === 'running' && pending.has(r.id));
      if (running) return fail('ALREADY_RUNNING', 'Дождись текущего AI-вызова или останови его.', 409);
      const time = stamp();
      const run = await store.create({ id, requestId: input.requestId, requestDigest, flowId: flow.id, nodeId: input.nodeId, stage: input.stage,
        summaryRu: '', assumptionsRu: [], referenceNotesRu: [], status: 'running', revision: 1, inputFingerprint: prepared.inputFingerprint, feedbackRu: input.feedbackRu, version: null,
        parentRunId: prepared.parentRunId, supersedesRunId: null, snapshot: prepared.snapshot, flowSnapshot: flow, versions: [], codexAccountId: accountId,
        calls: [{ stage: input.stage, status: 'running', startedAt: time, finishedAt: null, errorRu: null, meta: null }], errorRu: null, createdAt: time, updatedAt: time });
      for (const [i, image] of prepared.images.entries()) await store.saveImage(run.id, run.snapshot.attachments[i]!.file, Buffer.from(image.base64, 'base64'));
      const projected = await project(run, false, true);
      launch(run, prepared.images, prepared.modelCard);
      return { run: publicRun(run), flow: projected };
    });
  }
  async function approve(id: string, raw: Flow, expectedRevision: number, revalidate = false) {
    const flow = await savedSnapshot(raw);
    return store.exclusive(`${flow.id}-approval`, async () => {
      const run = await recover(id);
      if (run.flowId !== flow.id) return fail('FLOW_CONFLICT', 'AI-запуск относится к другому холсту.', 409);
      if (run.revision !== expectedRevision) return fail('RUN_CONFLICT', 'Версия AI изменилась. Обнови результат перед подтверждением.', 409);
      if (!run.version || !['ready', 'approved'].includes(run.status)) return fail('NOT_READY', 'Сначала дождись готового результата AI.', 409);
      const current = await context(flow, run.nodeId, run.stage);
      const node = flow.nodes.find(n => n.id === run.nodeId)!;
      if (!revalidate && node.ai?.[run.stage]?.id !== run.version.id) return fail('VERSION_CONFLICT', 'Выбрана другая версия AI. Открой актуальную историю.', 409);
      const changed = current.inputFingerprint !== run.inputFingerprint || current.snapshot.contextDigest !== run.snapshot.contextDigest;
      if (!changed && !revalidate && run.status === 'approved') return { run: publicRun(run), flow };
      if (changed && !revalidate) return fail('STALE_VERSION', 'Входы изменились. Перепроверь результат и явно подтверди его для новых входов.', 409);
      let updated: StoredCanvasAiRun;
      if (revalidate) {
        const requestId = randomUUID(); const newId = `cai-${requestId}`; const time = stamp();
        const version: CanvasAiVersion = { ...run.version, id: `v-${randomUUID()}`, inputFingerprint: current.inputFingerprint,
          createdAt: time, parentVersionId: run.stage === 'prompt' ? current.snapshot.approvedIdeaVersionId : run.version.id,
          approval: null };
        version.approval = { versionId: version.id, inputFingerprint: current.inputFingerprint, approvedAt: time };
        for (const [i, image] of current.images.entries()) await store.saveImage(newId, current.snapshot.attachments[i]!.file, Buffer.from(image.base64, 'base64'));
        updated = await store.create({ ...run, id: newId, requestId, requestDigest: hash(['revalidate', run.id, run.revision, current.snapshot.contextDigest]),
          revision: 1, status: 'approved', inputFingerprint: current.inputFingerprint, snapshot: current.snapshot, flowSnapshot: flow,
          version, versions: [version], parentRunId: current.parentRunId, supersedesRunId: run.id, calls: [],
          codexAccountId: undefined, llmInput: undefined, feedbackRu: '', errorRu: null,
          summaryRu: 'Ты переподтвердил прежний текст для текущих входов без нового вызова AI.', referenceNotesRu: [],
          createdAt: time, updatedAt: time });
      } else {
        updated = await store.update(id, stored => {
          const version = { ...stored.version! };
          version.approval = { versionId: version.id, inputFingerprint: current.inputFingerprint, approvedAt: stamp() };
          stored.version = version; stored.versions = stored.versions.map(v => v.id === version.id ? version : v);
          stored.status = 'approved'; stored.errorRu = null;
        });
      }
      const projected = await project(updated, true, true);
      return { run: publicRun(updated), flow: projected };
    });
  }
  async function validateSubmission(body: unknown): Promise<CanvasOrigin | undefined> {
    if (!body || typeof body !== 'object' || !('canvas' in body) || !body.canvas) return;
    const raw = body as { canvas: { flowId?: unknown; nodeId?: unknown }; modelId?: unknown; prompt?: unknown; params?: unknown; refs?: unknown; count?: unknown };
    if (typeof raw.canvas.flowId !== 'string' || typeof raw.canvas.nodeId !== 'string') return fail('INVALID_CANVAS', 'Нужны холст и generator для запуска.');
    const flow = await options.flows.get(raw.canvas.flowId);
    if (!flow) return fail('NOT_FOUND', 'Холст не найден.', 404);
    const node = flow.nodes.find(n => n.id === raw.canvas.nodeId && n.type === 'generator');
    if (!node) return fail('NOT_FOUND', 'Генератор не найден.', 404);
    const plan = planRun(flow, node.id, await mediaMap());
    if (plan.problems.length) return fail('CANVAS_BLOCKED', plan.problems.join(' '));
    if (raw.modelId !== plan.modelId || raw.prompt !== plan.prompt || hash(raw.params ?? {}) !== hash(plan.params) || hash(raw.refs ?? []) !== hash(plan.refs) || (raw.count !== undefined && raw.count !== 1)) return fail('CANVAS_MISMATCH', 'Запрос не совпадает с сохранённым generator. Сохрани холст и проверь prompt.', 409);
    const prompts = flow.edges.filter(e => e.to === node.id && e.port === 'prompt').map(e => flow.nodes.find(n => n.id === e.from)).filter(n => n?.type === 'prompt');
    const managed = prompts.find(p => p?.aiSource);
    const targeted = flow.nodes.filter(n => n.type === 'ai' && n.targetGeneratorId === node.id);
    if (targeted.length && (!managed?.aiSource || targeted.length !== 1 || managed.aiSource.aiNodeId !== targeted[0]?.id)) return fail('APPROVAL_REQUIRED', 'Для AI-ветки нужен связанный одобренный prompt.', 409);
    if (!managed?.aiSource) return { flowId: flow.id, nodeId: node.id, inputFingerprint: inputFingerprint(flow, node.id) };
    if (prompts.length !== 1 || node.text.trim()) return fail('CANVAS_MISMATCH', 'Для AI-ветки нужен один одобренный prompt без дополнительного текста.', 409);
    const problems = aiPromptProblems(flow, managed, node.id);
    if (problems.length) return fail('APPROVAL_REQUIRED', problems.join(' '), 409);
    const run = (await store.list(flow.id, managed.aiSource.aiNodeId)).find(r => r.stage === 'prompt' && r.version?.id === managed.aiSource?.versionId && r.status === 'approved');
    if (!run?.version?.approval || run.version.text !== managed.text || run.version.approval.approvedAt !== managed.aiApproval?.approvedAt) return fail('APPROVAL_REQUIRED', 'Сервер не подтверждает approval этой версии prompt.', 409);
    const prepared = await context(flow, run.nodeId, 'prompt');
    if (prepared.inputFingerprint !== run.inputFingerprint || prepared.snapshot.contextDigest !== run.snapshot.contextDigest) return fail('STALE_VERSION', 'Контекст prompt изменился. Перепроверь и одобри его заново.', 409);
    return { flowId: flow.id, nodeId: node.id, aiNodeId: run.nodeId, ideaVersionId: run.snapshot.approvedIdeaVersionId ?? undefined, promptVersionId: run.version.id, inputFingerprint: run.inputFingerprint };
  }
  return {
    start, approve,
    async preview(flowId: string, nodeId: string): Promise<CanvasAiPreview> {
      const flow = await options.flows.get(flowId);
      if (!flow) return fail('NOT_FOUND', 'Холст не найден.', 404);
      const prepared = await context(flow, nodeId, 'idea');
      const warningsRu: string[] = [];
      if (prepared.snapshot.identity && prepared.snapshot.identity.uploadIds.length === 0) warningsRu.push('У выбранного Soul ID нет доступных локальных фото. Идею можно обсудить, но перед подготовкой prompt добавь референсы внешности.');
      return { flowId: flow.id, flowRev: flow.rev ?? 0, inputFingerprint: prepared.inputFingerprint, snapshot: prepared.snapshot, warningsRu };
    },
    revalidate: (id: string, flow: Flow, revision: number) => approve(id, flow, revision, true),
    get: async (id: string) => publicRun(await recover(id)),
    list: async (flowId: string, nodeId?: string): Promise<CanvasAiRun[]> => Promise.all((await store.list(flowId, nodeId)).map(async r => publicRun(await recover(r.id)))),
    async cancel(id: string, raw: Flow) {
      const flow = await savedSnapshot(raw); const run = await recover(id);
      if (run.flowId !== flow.id) return fail('FLOW_CONFLICT', 'AI-запуск относится к другому холсту.', 409);
      if (run.status !== 'running') return { run: publicRun(run), flow };
      pending.get(id)?.controller.abort();
      const cancelled = await store.update(id, current => {
        if (current.status !== 'running') return;
        current.status = 'cancelled'; current.errorRu = 'Вызов остановлен. Повтор запускается только по твоему действию.';
        const call = current.calls.at(-1)!; call.status = 'cancelled'; call.finishedAt = stamp(); call.errorRu = current.errorRu;
      });
      return { run: publicRun(cancelled), flow: await project(cancelled) };
    },
    async retry(id: string, raw: Flow, requestId: string, previewDigest: string, accountId?: string) {
      const run = await recover(id);
      if (!['failed', 'cancelled', 'interrupted'].includes(run.status)) return fail('RETRY_NOT_ALLOWED', 'Повтор доступен после ошибки или остановки.', 409);
      return start({ flowId: run.flowId, nodeId: run.nodeId, stage: run.stage, flow: raw, requestId, previewDigest, feedbackRu: run.feedbackRu }, accountId);
    },
    validateSubmission,
    async acceptMedia(input: { flowId: string; nodeId: string; flow: Flow; jobId: string; mediaId: string }) {
      const flow = await savedSnapshot(input.flow, input.flowId);
      const node = flow.nodes.find(n => n.id === input.nodeId && n.type === 'generator' && n.kind === 'image');
      const job = await options.gen.jobs.get(input.jobId);
      const item = await options.gen.library.get(input.mediaId);
      if (!node || node.jobIds[node.selected] !== input.jobId || !job || job.status !== 'saved' || !job.mediaIds.includes(input.mediaId) || item?.jobId !== job.id || item.kind !== 'image') return fail('MEDIA_MISMATCH', 'Принять можно только выбранное сохранённое фото этого generator.', 409);
      if (!job.canvas || job.canvas.flowId !== flow.id || job.canvas.nodeId !== node.id) return fail('MEDIA_MISMATCH', 'У фото нет подтверждённой связи с этим generator.', 409);
      const plan = planRun(flow, node.id, await mediaMap());
      const lineage = await validateSubmission({ canvas: { flowId: flow.id, nodeId: node.id }, modelId: plan.modelId, prompt: plan.prompt, params: plan.params, refs: plan.refs, count: 1 });
      if (hash(lineage) !== hash(job.canvas)) return fail('STALE_MEDIA', 'Фото создано для другой версии входов. Сверь актуальную ветку перед приёмкой.', 409);
      const next = await options.flows.save(flow.id, { ...flow, nodes: flow.nodes.map(n => n.id === node.id ? { ...n, acceptedJobId: input.jobId, acceptedMediaId: input.mediaId } : n) });
      if (!next) return fail('FLOW_CONFLICT', 'Не удалось сохранить приёмку фото.', 409);
      return next;
    },
    wait: async (id: string) => { await pending.get(id)?.done; },
  };
}
export type CanvasAi = ReturnType<typeof createCanvasAi>;
