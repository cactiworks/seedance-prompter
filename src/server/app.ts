import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { asyncRequests } from './asyncRequests.ts';
import { archiveDirectory, downloadRoutes } from './downloads.ts';
import { APP_NAME, APP_VERSION } from '../core/meta.ts';
import { isActive, needsAttention } from '../core/gen/jobStatus.ts';
import { staleFields, type FieldsOutput } from '../core/compose.ts';
import { buildCriticSystem, buildCriticUser, CRITIC_SCHEMA, verifyCritique, type CriticOutput, type SymptomCatalog } from '../core/llm/buildCritic.ts';
import { buildFieldsUser, FIELDS_SCHEMA, normalizeFields, validateFields } from '../core/llm/buildFields.ts';
import { buildPlannerUser, extractLines, PLANNER_SCHEMA, validatePlan, type PlannerOutput, type PlannerShooting } from '../core/llm/buildPlanner.ts';
import { buildPrompterSystem, buildPrompterUser, cardFile, EMPTY_SHOT, hasStyles, normalizePrompter, PROMPTER_MAX_REFS, PROMPTER_REF_ROLES, PROMPTER_SCHEMA, validatePrompter, type PrompterOutput, type PrompterRequest, type PrompterShot, type PrompterTemplate } from '../core/llm/buildPrompter.ts';
import { buildVisionUser, flagsFromVision, VISION_SCHEMA, VISION_SYSTEM, type VisionOutput } from '../core/llm/buildVision.ts';
import { VERDICT_SYMPTOMS, withLearnings } from '../core/gen/calibration.ts';
import { findModel, modelsOf, sourceTitleRu } from '../core/gen/models.ts';
import type { FewShot } from '../core/llm/buildWriter.ts';
import { buildRegionPrompt, regionProblems, type Box } from '../core/gen/regionEdit.ts';
import { buildEditInstructionUser, EDIT_INSTRUCTION_SCHEMA, EDIT_INSTRUCTION_SYSTEM, needsTranslation, validateEditInstruction, type EditInstructionOutput } from '../core/llm/buildEditInstruction.ts';
import { forgetMedia } from '../core/model/canvas.ts';
import { LearningSchema, MoodboardSchema, RefSourceSchema, VerdictSchema } from '../core/model/media.ts';
import { durationOf, newProject, ProjectSchema, storyboardFrames } from '../core/model/project.ts';
import { agentShooting, buildShot, type PackBundle } from '../core/pipeline.ts';
import { cropArgs, frameArgs, probeVideo, resizeArgs, runFfmpeg, trimArgs, type FfmpegRunner } from './gen/ffmpeg.ts';
import { validateMediaFile } from './gen/validateMedia.ts';
import { GEN_HTTP, GenError } from './gen/provider.ts';
import { createGenRuntime, SubmitError, type GenRuntime } from './gen/runtime.ts';
import type { ImageInput } from './llm/codexCli/args.ts';
import { DEFAULT_LLM_MODEL, LlmError, runCodex } from './llm/codexCli/provider.ts';
import { writeShot, type Runner } from './llm/tasks/write.ts';
import { createProductionRuntime, type ProductionRuntime } from './production/runtime.ts';
import { productionRoutes } from './production/routes.ts';
import { createCharacters, type Characters } from './production/characters.ts';
import { characterRoutes } from './production/characterRoutes.ts';
import { createFlows } from './storage/flows.ts';
import { createJournal } from './storage/journal.ts';
import { createMoodboards } from './storage/moodboards.ts';
import { createStore, StoreError } from './storage/fsStore.ts';

export const HOST = '127.0.0.1';
/** SP_PORT — второй экземпляр для проверки, пока основной занят (с SP_DATA_DIR, чтобы не делить данные). */
export const PORT = Number(process.env.SP_PORT ?? 4317);

/** Заголовок, который обязан прислать наш клиент на любой мутации. */
export const CLIENT_HEADER = 'x-sp-client';

const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_REF_BYTES = 30 * 1024 * 1024;
/** Свой файл в библиотеку (съёмка, чужая картинка): до 1 ГБ — видео с телефона бывают крупными. */
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;
const IMPORT_EXT: Record<string, { ext: string; kind: 'image' | 'video' }> = {
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
};
/** Копия для vision ≤1568 px в JPEG — это сотни КБ; 4 млн знаков base64 ≈ 3 МБ — с запасом, но не «что угодно». */
const MAX_VISION_BASE64 = 4_000_000;

export interface AppOptions {
  /** Корень репозитория: отсюда читается packs/. */
  rootDir: string;
  /** Каталог пользовательских данных (в .gitignore). */
  dataDir: string;
  /** Exact public HTTPS origins behind an authenticated reverse proxy. Host stays loopback. */
  publicOrigins?: string[];
  /** Подменяется в тестах: живой вызов тратит квоту подписки. */
  runLlm?: Runner;
  writerModel?: string;
  production?: ProductionRuntime;
  characters?: Characters;
  /** Показать папку экспорта в Finder. По умолчанию — `open` на macOS; в тестах отключается. */
  reveal?: ((dir: string) => void) | false;
  /** Генерация и библиотека. По умолчанию — живые провайдеры, фоновый опрос не запущен (его запускает index.ts). */
  gen?: GenRuntime;
  /** ffmpeg для кадра из видео; в тестах — подмена, которая пишет файл сама. */
  ffmpeg?: FfmpegRunner;
  validateMedia?: typeof validateMediaFile;
  probeVideo?: typeof probeVideo;
}

function revealInFinder(target: string): void {
  // Под тестами Finder не открываем никогда: иначе прогон тестов раскрывает окна с временными папками.
  if (process.platform !== 'darwin' || process.env.VITEST !== undefined) return;
  // Файл — выделить в его папке; папку — открыть.
  const args = /\.[a-z0-9]{2,4}$/i.test(target) ? ['-R', target] : [target];
  spawn('open', args, { stdio: 'ignore', detached: true }).unref();
}

function loadPack(rootDir: string, id: string): PackBundle {
  const dir = path.join(rootDir, 'packs', id);
  const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as T;
  const kits: PackBundle['kits'] = {};
  for (const file of readdirSync(path.join(dir, 'kits'))) {
    if (!file.endsWith('.json')) continue;
    const kit = read<PackBundle['kits'][string]>(path.join('kits', file));
    kits[kit.id] = kit;
  }
  // Режимы съёмки — не у каждого pack: без файла остаётся только метод гайда.
  const shooting = existsSync(path.join(dir, 'shooting.json')) ? read<NonNullable<PackBundle['shooting']>>('shooting.json') : undefined;
  return { id, verbatim: read('verbatim.json'), kits, dialects: read('dialects.json'), lexicon: read('lexicon.json'), lintParams: read('lint.json'), ...(shooting === undefined ? {} : { shooting }) };
}

const STATUS: Record<StoreError['code'], 400 | 404 | 409 | 422> = { BAD_SLUG: 400, BAD_FILE: 400, NOT_FOUND: 404, CONFLICT: 409, INVALID: 422 };

export function createApp(options: AppOptions) {
  const store = createStore(options.dataDir);
  const gen = options.gen ?? createGenRuntime({ dataDir: options.dataDir });
  const flows = createFlows(options.dataDir);
  /** Удалённые файлы библиотеки — вон из сохранённых flows: ноды остаются без файла, а не со ссылкой в никуда. */
  const forgetInFlows = async (mediaIds: string[]): Promise<void> => {
    if (mediaIds.length === 0) return;
    for (const item of await flows.list()) {
      const flow = await flows.get(item.id);
      if (flow === undefined) continue;
      const next = forgetMedia(flow, mediaIds);
      if (next !== flow) await flows.save(next.id, next);
    }
  };
  const moodboards = createMoodboards(options.dataDir);
  const journal = createJournal(options.dataDir);
  const app = new Hono();
  const allowedOrigins = new Set([...ALLOWED_ORIGINS, ...(options.publicOrigins ?? (process.env.SP_PUBLIC_ORIGINS ?? '').split(',').filter(Boolean))]);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== 'https:' && !ALLOWED_ORIGINS.has(origin))) throw new Error('SP_PUBLIC_ORIGINS requires exact HTTPS origins');
  }

  // Сервер локальный, но любая веб-страница в браузере владельца может стучаться в localhost.
  // Без этих проверок она смогла бы тратить квоту LLM и читать референсы.
  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!ALLOWED_HOSTS.has(host)) return c.json({ error: 'FORBIDDEN_HOST' }, 403);

    const origin = c.req.header('origin');
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return c.json({ error: 'FORBIDDEN_ORIGIN' }, 403);
    }
    if (!SAFE_METHODS.has(c.req.method) && c.req.header(CLIENT_HEADER) === undefined) {
      return c.json({ error: 'MISSING_CLIENT_HEADER' }, 403);
    }
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  // Registered after Host/Origin/CSRF validation; detached requests pass those checks again.
  asyncRequests(app);
  downloadRoutes(app, options.dataDir);

  app.onError((error, c) => {
    if (error instanceof SyntaxError) return c.json({ error: 'BAD_JSON', messageRu: 'Некорректный JSON запроса.' }, 400);
    if (error instanceof StoreError) return c.json({ error: error.code, messageRu: error.message }, STATUS[error.code]);
    if (error instanceof SubmitError) return c.json({ error: error.code, messageRu: error.messageRu, ...error.details }, error.status);
    if (error instanceof GenError) return c.json({ error: error.code, messageRu: error.messageRu }, GEN_HTTP[error.code]);
    console.error(error);
    return c.json({ error: 'INTERNAL', messageRu: 'Внутренняя ошибка сервера.' }, 500);
  });

  const characters = options.characters ?? createCharacters({ dataDir: options.dataDir });
  app.route('/api/characters', characterRoutes(characters));
  app.route('/api/production', productionRoutes(options.production ?? createProductionRuntime({ dataDir: options.dataDir, runLlm: options.runLlm, gen }), characters));

  const routes = app
    .get('/api/health', (c) => c.json({ ok: true, name: APP_NAME, version: APP_VERSION, revision: process.env.SP_RELEASE ?? null }))
    .get('/api/packs/:id', (c) => c.json(loadPack(options.rootDir, c.req.param('id'))))
    .get('/api/projects', async (c) => c.json(await store.list()))
    .post('/api/projects', async (c) => {
      const body = (await c.req.json()) as { slug?: string; title?: string; copyFrom?: string };
      const slug = body.slug ?? '';
      const title = body.title ?? 'Без названия';
      // Копия ноды Seedance-промптера в canvas: черновик продолжается с того же места, но попытки — история оригинала.
      if (typeof body.copyFrom === 'string' && body.copyFrom !== '') {
        const source = await store.read(body.copyFrom);
        const project = await store.write(slug, { ...source, slug, title, rev: 0, shots: source.shots.map((shot) => ({ ...shot, attempts: [] })) }, null);
        await store.copyRefs(source.slug, slug);
        return c.json(project, 201);
      }
      const project = await store.write(slug, newProject(slug, title), null);
      return c.json(project, 201);
    })
    .get('/api/projects/:slug', async (c) => c.json(await store.read(c.req.param('slug'))))
    .put('/api/projects/:slug', async (c) => {
      const ifMatch = c.req.header('if-match');
      const saved = await store.write(c.req.param('slug'), await c.req.json(), ifMatch === undefined ? null : Number(ifMatch));
      return c.json(saved);
    })
    .put('/api/projects/:slug/refs/:file', async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > MAX_REF_BYTES) return c.json({ error: 'TOO_LARGE', messageRu: 'Картинка больше 30 МБ — Seedance такую не примет.' }, 413);
      await store.writeRef(c.req.param('slug'), c.req.param('file'), bytes);
      return c.json({ ok: true });
    })
    // Писатель запускается только по клику владельца. Клиент присылает текущий снимок проекта,
    // чтобы не было гонки с автосейвом; отмена запроса убивает дочерний процесс.
    .post('/api/llm/write', async (c) => {
      const body = (await c.req.json()) as { project?: unknown; shotId?: string; segmentIds?: string[] };
      const project = ProjectSchema.parse(body.project);
      const packDir = path.join(options.rootDir, 'packs', project.packId);
      try {
        const result = await writeShot({
          project,
          shotId: body.shotId ?? '',
          segmentIds: Array.isArray(body.segmentIds) ? body.segmentIds : undefined,
          pack: loadPack(options.rootDir, project.packId),
          rules: readFileSync(path.join(packDir, 'prompts/writer.system.md'), 'utf8'),
          fewshot: JSON.parse(readFileSync(path.join(packDir, 'prompts/fewshot/k2.json'), 'utf8')) as FewShot,
          run: options.runLlm ?? runCodex,
          model: options.writerModel ?? process.env.SP_WRITER_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL,
          signal: c.req.raw.signal,
        });
        return c.json(result);
      } catch (error) {
        if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.messageRu }, error.code === 'USAGE_LIMIT' ? 429 : 502);
        return c.json({ error: 'WRITE_FAILED', messageRu: error instanceof Error ? error.message : 'Писатель не сработал.' }, 422);
      }
    })
    // Агент полей: русские тезисы владельца (место, погода, имена, последствия, своя камера, реквизит) →
    // английские фрагменты под слоты компилятора. Первый шаг кнопки «Собрать промпт», только по клику.
    .post('/api/llm/fields', async (c) => {
      const body = (await c.req.json()) as { project?: unknown; shotId?: string };
      const project = ProjectSchema.parse(body.project);
      const shot = project.shots.find((s) => s.id === body.shotId);
      if (shot === undefined) return c.json({ error: 'NO_SHOT', messageRu: 'Кадр не найден.' }, 404);
      const items = staleFields(project, shot, 'compose');
      const asked = items.filter((item) => item.ru !== '');
      if (asked.length === 0) return c.json({ items, output: null, problems: [], meta: null });
      const system = readFileSync(path.join(options.rootDir, 'packs', project.packId, 'prompts/fields.system.md'), 'utf8');
      const run = options.runLlm ?? runCodex;
      const request = { system, jsonSchema: FIELDS_SCHEMA, model: options.writerModel ?? process.env.SP_FIELDS_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL, effort: 'low' as const, timeoutMs: 150_000, signal: c.req.raw.signal, taskRu: 'Агент полей' };
      try {
        const user = buildFieldsUser(project, items);
        let result = await run<FieldsOutput>({ ...request, user });
        let output = normalizeFields(result.data, items);
        let problems = validateFields(output, items, project);
        if (problems.length > 0) {
          result = await run<FieldsOutput>({ ...request, user: `${user}\n\nYour previous answer was rejected:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nPrevious answer:\n${JSON.stringify(result.data)}` });
          output = normalizeFields(result.data, items);
          problems = validateFields(output, items, project);
        }
        return c.json({ items, output, problems, meta: result.meta });
      } catch (error) {
        if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.messageRu }, error.code === 'USAGE_LIMIT' ? 429 : 502);
        throw error;
      }
    })
    // Итоговая проверка критиком — по клику, когда блокеров нет: тратить квоту на заведомо несобранный промпт незачем.
    .post('/api/llm/critique', async (c) => {
      const body = (await c.req.json()) as { project?: unknown; shotId?: string; visionSummaries?: Record<string, string> };
      const project = ProjectSchema.parse(body.project);
      const shot = project.shots.find((s) => s.id === body.shotId);
      if (shot === undefined) return c.json({ error: 'NO_SHOT', messageRu: 'Кадр не найден.' }, 404);
      const pack = loadPack(options.rootDir, project.packId);
      const build = buildShot(project, shot, pack);
      if (build.blockers.length > 0) return c.json({ error: 'BLOCKED', messageRu: `Сначала сними блокеры сборки (${build.blockers.length}): критик проверяет только собранный промпт.` }, 422);
      const packDir = path.join(options.rootDir, 'packs', project.packId);
      const catalog = JSON.parse(readFileSync(path.join(packDir, 'symptoms.json'), 'utf8')) as SymptomCatalog;
      const system = buildCriticSystem(readFileSync(path.join(packDir, 'prompts/critic.system.md'), 'utf8'), catalog);
      const user = buildCriticUser({ project, shot, paragraphs: build.paragraphs, resolvedParagraphs: build.resolvedParagraphs, durationSec: durationOf(project, shot), findings: build.findings, visionSummaries: body.visionSummaries, shooting: agentShooting(shot, pack) });
      try {
        // Критик читает большой контекст и пишет длинный JSON; сохраняем отдельный лимит времени.
        const result = await (options.runLlm ?? runCodex)<CriticOutput>({ system, user, jsonSchema: CRITIC_SCHEMA, model: options.writerModel ?? process.env.SP_CRITIC_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL, effort: 'medium', timeoutMs: 300_000, signal: c.req.raw.signal, taskRu: 'Критик' });
        const verified = verifyCritique(result.data, build.resolvedParagraphs);
        return c.json({ critique: { ...verified.critique, prompt: build.prompt, createdAt: new Date().toISOString(), model: result.meta.model, droppedRu: verified.droppedRu }, meta: result.meta });
      } catch (error) {
        if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.messageRu }, error.code === 'USAGE_LIMIT' ? 429 : 502);
        return c.json({ error: 'CRITIQUE_FAILED', messageRu: error instanceof Error ? error.message : 'Критик не сработал.' }, 422);
      }
    })
    // Панель кадра пронумерованными файлами в data/projects/<slug>/export/<shotId>/ + Finder.
    .post('/api/projects/:slug/shots/:shotId/export', async (c) => {
      const project = await store.read(c.req.param('slug'));
      const shot = project.shots.find((s) => s.id === c.req.param('shotId'));
      if (shot === undefined) return c.json({ error: 'NO_SHOT', messageRu: 'Кадр не найден.' }, 404);
      const items = shot.panel.map((key) => {
        const file = project.refs.find((r) => r.key === key)?.file ?? null;
        return { key, fileName: file === null ? null : file.split('?')[0] ?? null };
      });
      const result = await store.exportPanel(project.slug, shot.id, items);
      if (options.reveal !== false) (options.reveal ?? revealInFinder)(result.dir);
      const downloadUrl = process.env.SP_SERVE_STATIC === '1' ? await archiveDirectory(options.dataDir, result.dir) : undefined;
      return c.json({ ...result, downloadUrl });
    })
    // Починка после неудачной генерации: симптомы попытки → минимальные правки абзацев (как предложение).
    .post('/api/llm/fix', async (c) => {
      const body = (await c.req.json()) as { project?: unknown; shotId?: string; attemptN?: number };
      const project = ProjectSchema.parse(body.project);
      const attempt = project.shots.find((s) => s.id === body.shotId)?.attempts.find((a) => a.n === body.attemptN);
      if (attempt === undefined) return c.json({ error: 'NO_ATTEMPT', messageRu: 'Попытка не найдена.' }, 404);
      const packDir = path.join(options.rootDir, 'packs', project.packId);
      const catalog = (JSON.parse(readFileSync(path.join(packDir, 'symptoms.json'), 'utf8')) as { symptoms: { id: string; titleRu: string; fixEn: string }[] }).symptoms;
      const symptoms = catalog.filter((s) => attempt.symptomIds.includes(s.id) && s.fixEn.trim() !== '');
      if (symptoms.length === 0 && attempt.failedRu.trim() === '') return c.json({ error: 'NOTHING_TO_FIX', messageRu: 'Отметь симптомы или опиши, что не получилось, — агенту нужен повод для правки.' }, 422);
      try {
        const result = await writeShot({
          project,
          shotId: body.shotId ?? '',
          pack: loadPack(options.rootDir, project.packId),
          rules: readFileSync(path.join(packDir, 'prompts/writer.system.md'), 'utf8'),
          fewshot: JSON.parse(readFileSync(path.join(packDir, 'prompts/fewshot/k2.json'), 'utf8')) as FewShot,
          run: options.runLlm ?? runCodex,
          model: options.writerModel ?? process.env.SP_WRITER_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL,
          signal: c.req.raw.signal,
          fix: { symptoms, workedRu: attempt.workedRu, failedRu: attempt.failedRu },
        });
        return c.json(result);
      } catch (error) {
        if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.messageRu }, error.code === 'USAGE_LIMIT' ? 429 : 502);
        return c.json({ error: 'FIX_FAILED', messageRu: error instanceof Error ? error.message : 'Починка не сработала.' }, 422);
      }
    })
    .get('/api/packs/:id/symptoms', (c) => c.json(JSON.parse(readFileSync(path.join(options.rootDir, 'packs', c.req.param('id'), 'symptoms.json'), 'utf8')) as unknown))
    // Vision-анализ одного референса — только по кнопке: картинка уходит в OpenAI через Codex.
    // Отправляется уменьшенная копия <key>-vision.jpg, которую браузер делает при загрузке.
    .post('/api/llm/vision', async (c) => {
      const body = (await c.req.json()) as { slug?: string; refKey?: string };
      const project = await store.read(body.slug ?? '');
      const ref = project.refs.find((r) => r.key === body.refKey);
      if (ref === undefined || ref.file === null) return c.json({ error: 'NO_IMAGE', messageRu: 'У референса нет картинки.' }, 422);
      let bytes: Uint8Array;
      try {
        bytes = await store.readRef(project.slug, `${ref.key}-vision.jpg`);
      } catch {
        return c.json({ error: 'NO_VISION_COPY', messageRu: 'Нет уменьшенной копии для анализа — загрузи картинку референса заново.' }, 422);
      }
      try {
        const result = await (options.runLlm ?? runCodex)<VisionOutput>({
          system: VISION_SYSTEM,
          user: buildVisionUser(ref),
          images: [{ mediaType: 'image/jpeg', base64: Buffer.from(bytes).toString('base64') }],
          jsonSchema: VISION_SCHEMA,
          model: process.env.SP_VISION_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL,
          effort: 'low',
          timeoutMs: 90_000,
          signal: c.req.raw.signal,
        });
        return c.json({ report: result.data, flags: flagsFromVision(result.data, ref.kind), meta: result.meta });
      } catch (error) {
        if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.messageRu }, error.code === 'USAGE_LIMIT' ? 429 : 502);
        throw error;
      }
    })
    // Планировщик: русский синопсис кадра → отрезки по времени. Реплики вынуты из синопсиса заранее.
    .post('/api/llm/plan', async (c) => {
      const body = (await c.req.json()) as { project?: unknown; shotId?: string; synopsisRu?: string };
      const project = ProjectSchema.parse(body.project);
      const shot = project.shots.find((s) => s.id === body.shotId);
      // Длительность — свойство кадра: от неё зависят бюджет событий и число отрезков.
      const durationSec = durationOf(project, shot ?? { durationSec: null });
      // Как снято и кадры раскадровки: при кадрах отрезков ровно столько же, отрезок N открывается на кадре N.
      const shooting: PlannerShooting | undefined = shot === undefined ? undefined : { ...agentShooting(shot, loadPack(options.rootDir, project.packId)), frames: storyboardFrames(project, shot).map((ref) => ({ label: ref.label, ...(ref.note !== undefined && ref.note.trim() !== '' ? { whatIsInIt: ref.note.trim().slice(0, 600) } : {}) })) };
      const exact = shooting?.frames.length ?? 0;
      const { text, newLines } = extractLines(body.synopsisRu ?? '', project.lines);
      if (text.trim() === '') return c.json({ error: 'EMPTY', messageRu: 'Опиши кадр по-русски — хотя бы парой предложений.' }, 422);
      const lineIds = [...text.matchAll(/\bL\d+\b/g)].map((m) => m[0]).filter((id, i, all) => all.indexOf(id) === i);
      const system = readFileSync(path.join(options.rootDir, 'packs', project.packId, 'prompts/planner.system.md'), 'utf8');
      const run = options.runLlm ?? runCodex;
      const request = { system, jsonSchema: PLANNER_SCHEMA, model: options.writerModel ?? process.env.SP_WRITER_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL, effort: 'medium' as const, timeoutMs: 180_000, signal: c.req.raw.signal };
      try {
        const user = buildPlannerUser(project, text, lineIds, durationSec, shooting);
        let result = await run<PlannerOutput>({ ...request, user });
        let problems = validatePlan(result.data, lineIds, durationSec, exact);
        if (problems.length > 0) {
          result = await run<PlannerOutput>({ ...request, user: `${user}\n\nYour previous plan was rejected:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nPrevious plan:\n${JSON.stringify(result.data)}` });
          problems = validatePlan(result.data, lineIds, durationSec, exact);
        }
        return c.json({ plan: result.data, newLines, problems, meta: result.meta });
      } catch (error) {
        if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.messageRu }, error.code === 'USAGE_LIMIT' ? 429 : 502);
        throw error;
      }
    })
    // Точечная правка кистью (решение 32): рамки выделения + русская инструкция → английский промпт для Seedream 5 Pro.
    // Только по клику «Изменить»; генерацию запускает клиент тем же /api/gen/jobs с гейтом цены.
    .post('/api/llm/region-edit', async (c) => {
      const body = (await c.req.json()) as { instructionRu?: unknown; boxes?: unknown };
      const instructionRu = typeof body.instructionRu === 'string' ? body.instructionRu.trim() : '';
      const isCoord = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 999;
      const boxes = (Array.isArray(body.boxes) ? body.boxes : []) as Box[];
      const valid = boxes.every((b) => isCoord(b.x1) && isCoord(b.y1) && isCoord(b.x2) && isCoord(b.y2) && b.x2 > b.x1 && b.y2 > b.y1);
      const problems = valid ? regionProblems(boxes, instructionRu) : ['Рамки выделения не прочитаны.'];
      if (problems.length > 0) return c.json({ error: 'BAD_REGION', messageRu: problems.join(' ') }, 422);
      if (!needsTranslation(instructionRu)) return c.json({ prompt: buildRegionPrompt(boxes, instructionRu), instructionEn: instructionRu, meta: null });
      const run = options.runLlm ?? runCodex;
      const request = { system: EDIT_INSTRUCTION_SYSTEM, jsonSchema: EDIT_INSTRUCTION_SCHEMA, model: process.env.SP_EDIT_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL, effort: 'low' as const, timeoutMs: 60_000, signal: c.req.raw.signal, taskRu: 'Перевод правки' };
      try {
        const user = buildEditInstructionUser(instructionRu, boxes.length);
        let result = await run<EditInstructionOutput>({ ...request, user });
        let issues = validateEditInstruction(result.data);
        if (issues.length > 0) {
          result = await run<EditInstructionOutput>({ ...request, user: `${user}\n\nYour previous answer was rejected:\n${issues.map((p) => `- ${p}`).join('\n')}\n\nPrevious answer:\n${JSON.stringify(result.data)}` });
          issues = validateEditInstruction(result.data);
        }
        if (issues.length > 0) return c.json({ error: 'BAD_TRANSLATION', messageRu: 'Инструкция не перевелась чисто — переформулируй короче.' }, 422);
        const instructionEn = result.data.instructionEn.trim();
        return c.json({ prompt: buildRegionPrompt(boxes, instructionEn), instructionEn, meta: result.meta });
      } catch (error) {
        if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.messageRu }, error.code === 'USAGE_LIMIT' ? 429 : 502);
        throw error;
      }
    })
    // Калибровка (этап 4, решение 33): наборы тестов, оценки владельца и его правила для моделей.
    .get('/api/calibration', (c) => c.json(JSON.parse(readFileSync(path.join(options.rootDir, 'packs', 'prompter', 'calibration.json'), 'utf8')) as unknown))
    .get('/api/verdicts', async (c) => c.json(await journal.verdicts.list()))
    .put('/api/verdicts/:mediaId', async (c) => {
      const mediaId = c.req.param('mediaId');
      const body = (await c.req.json()) as { verdict?: unknown; symptoms?: unknown; noteRu?: unknown };
      const entry = VerdictSchema.safeParse({ mediaId, verdict: body.verdict, symptoms: Array.isArray(body.symptoms) ? body.symptoms.filter((s) => VERDICT_SYMPTOMS.some((v) => v.id === s)) : [], noteRu: typeof body.noteRu === 'string' ? body.noteRu.trim() : '', at: new Date().toISOString() });
      if (!entry.success) return c.json({ error: 'BAD_VERDICT', messageRu: 'Оценка — годно, почти или мимо.' }, 422);
      if (!(await gen.library.list()).some((m) => m.id === mediaId)) return c.json({ error: 'NOT_FOUND', messageRu: 'Файла нет в библиотеке.' }, 404);
      return c.json(await journal.verdicts.update((list) => [...list.filter((v) => v.mediaId !== mediaId), entry.data]));
    })
    .delete('/api/verdicts/:mediaId', async (c) => {
      const mediaId = c.req.param('mediaId');
      return c.json(await journal.verdicts.update((list) => list.filter((v) => v.mediaId !== mediaId)));
    })
    .get('/api/learnings', async (c) => c.json(await journal.learnings.list()))
    .post('/api/learnings', async (c) => {
      const body = (await c.req.json()) as { modelId?: unknown; textRu?: unknown; evidence?: unknown };
      const learning = LearningSchema.safeParse({ id: `l-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, modelId: body.modelId, textRu: typeof body.textRu === 'string' ? body.textRu.trim() : '', evidence: Array.isArray(body.evidence) ? body.evidence.filter((e) => typeof e === 'string') : [], at: new Date().toISOString() });
      if (!learning.success || findModel(learning.data.modelId) === undefined) return c.json({ error: 'BAD_LEARNING', messageRu: 'Правилу нужна модель и текст до 400 знаков.' }, 422);
      return c.json(await journal.learnings.update((list) => [...list, learning.data]), 201);
    })
    .delete('/api/learnings/:id', async (c) => {
      const id = c.req.param('id');
      return c.json(await journal.learnings.update((list) => list.filter((l) => l.id !== id)));
    })
    // Рецепты починки (этап 2): данные pack — «Правка» в просмотре работы подставляет модель и формулировку.
    .get('/api/prompter/fixes', (c) => c.json(JSON.parse(readFileSync(path.join(options.rootDir, 'packs', 'prompter', 'fixes.json'), 'utf8')) as unknown))
    // Шаблоны промптера (этап 3): лист персонажа, лист предмета — данные pack.
    .get('/api/prompter/templates', (c) => c.json(JSON.parse(readFileSync(path.join(options.rootDir, 'packs', 'prompter', 'templates.json'), 'utf8')) as unknown))
    // Свои мудборды (этап 3): набор картинок стиля под именем; удаление мудборда картинки не трогает.
    .get('/api/moodboards', async (c) => c.json(await moodboards.list()))
    .post('/api/moodboards', async (c) => {
      const body = (await c.req.json()) as { name?: unknown; images?: unknown };
      const board = MoodboardSchema.safeParse({ id: `mb-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, name: typeof body.name === 'string' ? body.name.trim() : '', images: body.images, createdAt: new Date().toISOString() });
      if (!board.success || board.data.images.length === 0) return c.json({ error: 'BAD_MOODBOARD', messageRu: 'Мудборду нужно имя и от 1 до 8 картинок.' }, 422);
      return c.json(await moodboards.update((list) => [board.data, ...list]), 201);
    })
    .delete('/api/moodboards/:id', async (c) => {
      const id = c.req.param('id');
      return c.json(await moodboards.update((list) => list.filter((m) => m.id !== id)));
    })
    // Промптер (решение 28): идея по-русски → промпт под модель. Только по клику; генерацию не запускает.
    .post('/api/llm/prompter', async (c) => {
      const body = (await c.req.json()) as Partial<PrompterRequest> & { images?: unknown };
      const kind = body.kind === 'video' ? 'video' : 'image';
      const ideaRu = typeof body.ideaRu === 'string' ? body.ideaRu.trim() : '';
      if (ideaRu === '') return c.json({ error: 'EMPTY', messageRu: 'Опиши идею по-русски — хотя бы одним предложением.' }, 422);
      const modelId = typeof body.modelId === 'string' ? body.modelId : 'auto';
      const candidates = modelId === 'auto' ? modelsOf(kind) : modelsOf(kind).filter((m) => m.id === modelId);
      if (candidates.length === 0) return c.json({ error: 'NO_MODEL', messageRu: 'Такой модели нет в студии.' }, 422);
      // Референсы: роль и комментарий владельца + уменьшенная копия (браузер делает JPEG ≤1568 px) в том же порядке.
      const refs = Array.isArray(body.refs) ? body.refs : [];
      const images = Array.isArray(body.images) ? (body.images as ImageInput[]) : [];
      const frameInImage = kind === 'image' && refs.some((r) => r.role === 'start' || r.role === 'end');
      if (refs.length > PROMPTER_MAX_REFS || images.length !== refs.length || frameInImage || refs.some((r) => !(PROMPTER_REF_ROLES as readonly string[]).includes(r.role) || typeof r.commentRu !== 'string')) {
        return c.json({ error: 'BAD_REFS', messageRu: `Референсы не прочитаны: до ${PROMPTER_MAX_REFS} картинок, у каждой роль и комментарий; кадры видео — только для видео.` }, 422);
      }
      if (images.some((image) => !['image/jpeg', 'image/png', 'image/webp'].includes(image.mediaType) || typeof image.base64 !== 'string' || image.base64.length > MAX_VISION_BASE64)) {
        return c.json({ error: 'BAD_IMAGE', messageRu: 'Картинка референса не подошла — нужна уменьшенная копия JPEG / PNG / WebP до ~3 МБ.' }, 422);
      }
      const prev = body.previous;
      const previous = prev !== undefined && typeof prev.prompt === 'string' && typeof prev.modelId === 'string' ? { modelId: prev.modelId, prompt: prev.prompt, params: prev.params, styleName: typeof prev.styleName === 'string' ? prev.styleName : '' } : undefined;
      const rawShot = (body.shot ?? {}) as Partial<Record<keyof PrompterShot, unknown>>;
      const shot = Object.fromEntries(Object.keys(EMPTY_SHOT).map((key) => [key, typeof rawShot[key as keyof PrompterShot] === 'string' ? rawShot[key as keyof PrompterShot] : ''])) as unknown as PrompterShot;
      // Комплект камеры — тот же pack, что у «Кадров»; для картинки агент берёт из него только видимое.
      const kit = shot.cameraKitId === '' || shot.cameraKitId === 'custom' ? undefined : loadPack(options.rootDir, 'cinema-doc').kits[shot.cameraKitId];
      if (shot.cameraKitId !== '' && shot.cameraKitId !== 'custom' && kit === undefined) return c.json({ error: 'NO_KIT', messageRu: 'Такого комплекта камеры нет.' }, 422);
      const camera = kit === undefined ? null : { titleRu: kit.titleRu, anchor: kit.anchor, look: (kit.layout === 'split' ? [kit.cameraSpecs, kit.lensSpecs] : [kit.look, kit.lensNote]).filter((part) => typeof part === 'string' && part !== '').join(' ') };
      const dir = path.join(options.rootDir, 'packs', 'prompter');
      const templateId = typeof body.template === 'string' ? body.template : '';
      const template = templateId === '' ? null : ((JSON.parse(readFileSync(path.join(dir, 'templates.json'), 'utf8')) as { templates: PrompterTemplate[] }).templates.find((t) => t.id === templateId && t.kind === kind) ?? null);
      if (templateId !== '' && template === null) return c.json({ error: 'NO_TEMPLATE', messageRu: 'Такого шаблона нет.' }, 422);
      const request: PrompterRequest = { ideaRu, kind, modelId, template: templateId, refs, shot, commentRu: typeof body.commentRu === 'string' ? body.commentRu : undefined, previous };
      const learnings = await journal.learnings.list();
      const system = buildPrompterSystem(
        readFileSync(path.join(dir, 'system.md'), 'utf8'),
        readFileSync(path.join(dir, 'routing.md'), 'utf8'),
        // Правила владельца из калибровки дописываются в карточку — они главнее заявлений вендора.
        candidates.map((m) => ({ modelId: m.id, text: withLearnings(readFileSync(path.join(dir, 'models', cardFile(m.id)), 'utf8'), learnings.filter((l) => l.modelId === m.id)) })),
      );
      // Мудборды — подсказка агенту; Higgsfield не ответил — промпт пишется без них.
      const styles = candidates.some(hasStyles) ? (await gen.styles('higgsfield').catch(() => [])).map((s) => ({ id: s.id, name: s.name })) : [];
      const run = options.runLlm ?? runCodex;
      const llm = { system, jsonSchema: PROMPTER_SCHEMA, model: options.writerModel ?? process.env.SP_PROMPTER_MODEL ?? process.env.SP_LLM_MODEL ?? DEFAULT_LLM_MODEL, effort: 'medium' as const, images, timeoutMs: 150_000 + images.length * 15_000, signal: c.req.raw.signal, taskRu: 'Промптер' };
      try {
        const user = buildPrompterUser(request, candidates, styles, camera, template);
        let result = await run<PrompterOutput>({ ...llm, user });
        let problems = validatePrompter(result.data, candidates, styles, refs, shot, template);
        if (problems.length > 0) {
          result = await run<PrompterOutput>({ ...llm, user: `${user}\n\nYour previous answer was rejected:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nPrevious answer:\n${JSON.stringify(result.data)}` });
          problems = validatePrompter(result.data, candidates, styles, refs, shot, template);
        }
        const output = normalizePrompter(result.data, styles, refs, shot);
        if (output === null) return c.json({ error: 'BAD_MODEL', messageRu: 'Агент выбрал модель, которой нет в студии. Попробуй ещё раз.' }, 422);
        return c.json({ result: output, problems, meta: result.meta });
      } catch (error) {
        if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.messageRu }, error.code === 'USAGE_LIMIT' ? 429 : 502);
        throw error;
      }
    })
    .get('/api/projects/:slug/refs/:file', async (c) => {
      const file = c.req.param('file');
      const bytes = await store.readRef(c.req.param('slug'), file);
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'content-type': MIME[file.split('.').pop() ?? ''] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    })
    // Генерация (решения 21–22): ключ провайдера и баланс; баланс — только по запросу, это обращение наружу.
    .get('/api/gen/status', async (c) => c.json(await gen.status(c.req.query('balance') === '1')))
    // Готовые мудборды провайдера (Soul 2 — Higgsfield). Нет ключа — пустой список, форма работает без стиля.
    .get('/api/gen/styles', async (c) => c.json(await gen.styles(c.req.query('provider') === 'higgsfield' ? 'higgsfield' : 'kie')))
    // Только по клику: сервер сверяет подтверждённую сумму с оценкой и согласие на отправку рефов.
    .post('/api/gen/jobs', async (c) => c.json(await gen.submit(await c.req.json()), 202))
    // Замер входа апскейла (длинная сторона, секунды видео) — тот же, что при запуске: цена на кнопке = гейт. Бесплатно, локально.
    .post('/api/gen/measure', async (c) => c.json(await gen.measure(await c.req.json())))
    .get('/api/gen/jobs', async (c) => {
      const { slug, shotId, sessionId, kind } = c.req.query();
      const all = await gen.jobs.all();
      return c.json(
        all
          .filter((job) => (slug === undefined || job.origin?.projectSlug === slug) && (shotId === undefined || job.origin?.shotId === shotId) && (sessionId === undefined || job.sessionId === sessionId) && (kind === undefined || job.kind === kind))
          .filter((job, index) => index < 300 || isActive(job) || needsAttention(job)),
      );
    })
    // Canvas: flows пишет клиент (автосейв), сервер хранит. Генерации из нод идут тем же /api/gen/jobs.
    .get('/api/canvas/flows', async (c) => c.json(await flows.list()))
    .post('/api/canvas/flows', async (c) => {
      const body = (await c.req.json()) as { name?: string };
      return c.json(await flows.create(body.name ?? ''), 201);
    })
    .get('/api/canvas/flows/:id', async (c) => {
      const flow = await flows.get(c.req.param('id'));
      return flow === undefined ? c.json({ error: 'NOT_FOUND', messageRu: 'Flow не найден.' }, 404) : c.json(flow);
    })
    .put('/api/canvas/flows/:id', async (c) => {
      const saved = await flows.save(c.req.param('id'), await c.req.json());
      return saved === null ? c.json({ error: 'INVALID', messageRu: 'Flow не сохранён: неверная структура.' }, 422) : c.json(saved);
    })
    .post('/api/canvas/flows/:id/restore', async (c) => {
      const flow = await flows.restore(c.req.param('id'));
      return flow === undefined ? c.json({ messageRu: 'Удалённый холст не найден.' }, 404) : c.json(flow);
    })
    .delete('/api/canvas/flows/:id', async (c) => ((await flows.remove(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'NOT_FOUND', messageRu: 'Flow не найден.' }, 404)))
    // Сессии студии: лента генераций одного типа (Картинки / Видео).
    .get('/api/studio/sessions', async (c) => {
      const kind = c.req.query('kind');
      return c.json(await gen.sessions.list(kind === 'image' || kind === 'video' ? kind : undefined));
    })
    .post('/api/studio/sessions', async (c) => {
      const body = (await c.req.json()) as { kind?: string; title?: string };
      if (body.kind !== 'image' && body.kind !== 'video') return c.json({ error: 'BAD_KIND', messageRu: 'Тип сессии — image или video.' }, 422);
      return c.json(await gen.sessions.create(body.kind, body.title ?? ''), 201);
    })
    .patch('/api/studio/sessions/:id', async (c) => {
      const body = (await c.req.json()) as { title?: unknown; pinned?: unknown };
      const updated = await gen.sessions.update(c.req.param('id'), { ...(typeof body.title === 'string' ? { title: body.title } : {}), ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}) });
      return updated === undefined ? c.json({ error: 'NOT_FOUND', messageRu: 'Сессия не найдена.' }, 404) : c.json(updated);
    })
    // Удаляется только сессия; файлы остаются в библиотеке.
    .delete('/api/studio/sessions/:id', async (c) => ((await gen.sessions.remove(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'NOT_FOUND', messageRu: 'Сессия не найдена.' }, 404)))
    // Убрать задачу из ленты вместе с её файлами. Идущую — нельзя: её ещё опрашивает сервер, а деньги уже потрачены.
    .delete('/api/gen/jobs/:id', async (c) => {
      const job = await gen.jobs.get(c.req.param('id'));
      if (job === undefined) return c.json({ error: 'NOT_FOUND', messageRu: 'Задача не найдена.' }, 404);
      if (['submitting', 'queued', 'running', 'downloading'].includes(job.status)) return c.json({ error: 'ACTIVE', messageRu: 'Задача ещё идёт — дождись результата или ошибки.' }, 409);
      const removed = job.mediaIds.filter((m): m is string => m !== null);
      for (const mediaId of removed) await gen.library.remove(mediaId);
      await gen.jobs.remove(job.id);
      await forgetInFlows(removed);
      return c.json({ ok: true });
    })
    .get('/api/gen/jobs/:id', async (c) => {
      const job = await gen.jobs.get(c.req.param('id'));
      return job === undefined ? c.json({ error: 'NOT_FOUND', messageRu: 'Задача не найдена.' }, 404) : c.json(job);
    })
    // «Скачать снова» после download_failed и «Проверить снова» после таймаута опроса. Новых кредитов не тратит.
    .post('/api/gen/jobs/:id/retry', async (c) => c.json(await gen.retry(c.req.param('id'))))
    .get('/api/library', async (c) => c.json({ items: await gen.library.list(), favorites: await gen.library.favorites(), folders: await gen.library.folders() }))
    // Папки библиотеки (как проекты в Assets у Higgsfield). Удаление папки файлы не трогает.
    .post('/api/library/folders', async (c) => {
      const body = (await c.req.json()) as { name?: unknown };
      const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 80) : 'Новая папка';
      const folder = { id: `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name, mediaIds: [], createdAt: new Date().toISOString() };
      await gen.library.updateFolders((list) => [...list, folder]);
      return c.json(folder, 201);
    })
    .patch('/api/library/folders/:id', async (c) => {
      const body = (await c.req.json()) as { name?: unknown };
      const id = c.req.param('id');
      if (typeof body.name !== 'string' || body.name.trim() === '') return c.json({ error: 'BAD_NAME', messageRu: 'Пустое имя папки.' }, 422);
      const name = body.name.trim().slice(0, 80);
      const folders = await gen.library.updateFolders((list) => list.map((f) => (f.id === id ? { ...f, name } : f)));
      return c.json({ folders });
    })
    .delete('/api/library/folders/:id', async (c) => {
      const id = c.req.param('id');
      return c.json({ folders: await gen.library.updateFolders((list) => list.filter((f) => f.id !== id)) });
    })
    .post('/api/library/folders/:id/items', async (c) => {
      const id = c.req.param('id');
      const body = (await c.req.json()) as { mediaIds?: unknown; on?: unknown };
      const ids = Array.isArray(body.mediaIds) ? body.mediaIds.filter((m): m is string => typeof m === 'string') : [];
      const known = new Set((await gen.library.list()).map((m) => m.id));
      const valid = ids.filter((m) => known.has(m));
      const folders = await gen.library.updateFolders((list) =>
        list.map((f) => (f.id !== id ? f : { ...f, mediaIds: body.on === false ? f.mediaIds.filter((m) => !valid.includes(m)) : [...new Set([...f.mediaIds, ...valid])] })),
      );
      return c.json({ folders });
    })
    .post('/api/library/:id/favorite', async (c) => {
      const item = await gen.library.get(c.req.param('id'));
      if (item === undefined) return c.json({ error: 'NOT_FOUND', messageRu: 'Файла нет в библиотеке.' }, 404);
      const body = (await c.req.json()) as { on?: unknown };
      return c.json({ favorites: await gen.library.setFavorite(item.id, body.on === true) });
    })
    .get('/api/library/:id/file', async (c) => {
      const item = await gen.library.get(c.req.param('id'));
      if (item === undefined) return c.json({ error: 'NOT_FOUND', messageRu: 'Файла нет в библиотеке.' }, 404);
      return gen.library.respond(item, c.req.header('range'));
    })
    // Кадр из видео библиотеки (первый / последний) — локально через ffmpeg, бесплатно. Нужен, чтобы
    // последний кадр клипа стал стартовым кадром следующего. Повторный запрос отдаёт уже извлечённый кадр.
    .post('/api/library/:id/frame', async (c) => {
      const video = await gen.library.get(c.req.param('id'));
      if (video === undefined || video.kind !== 'video') return c.json({ error: 'NOT_VIDEO', messageRu: 'Кадр извлекается только из видео библиотеки.' }, 422);
      const body = (await c.req.json()) as { which?: unknown };
      const which = body.which === 'first' ? 'first' : 'last';
      const label = which === 'last' ? 'Последний кадр видео' : 'Первый кадр видео';
      const existing = (await gen.library.list()).find((m) => m.modelId === 'local/frame' && m.params.extractor === 'decoded-v2' && m.prompt === label && m.refs.some((r) => r.source.type === 'media' && r.source.mediaId === video.id));
      if (existing !== undefined) return c.json(existing);
      const out = path.join(gen.library.root, `.frame-${video.id}-${which}-${randomBytes(4).toString('hex')}.png`);
      try {
        await (options.ffmpeg ?? runFfmpeg)(frameArgs(gen.library.pathOf(video), out, which));
        await (options.validateMedia ?? validateMediaFile)(out, 'image');
        const item = await gen.library.importFile(out, 'png', {
          kind: 'image',
          jobId: 'local-frame',
          taskId: null,
          provider: 'local',
          modelId: 'local/frame',
          providerModel: 'ffmpeg',
          prompt: label,
          params: { extractor: 'decoded-v2' },
          refs: [{ label: 'Видео', source: { type: 'media', mediaId: video.id }, role: 'ref' }],
          origin: video.origin,
          sessionId: null,
          index: 0,
          sourceUrl: '',
          creditsConsumed: 0,
          createdAt: new Date().toISOString(),
        });
        return c.json(item, 201);
      } catch (error) {
        return c.json({ error: 'FRAME_FAILED', messageRu: error instanceof Error ? error.message : 'Кадр не извлёкся.' }, 500);
      } finally { await rm(out, { force: true }); }
    })
    // Размер площадки (решение 36): нода canvas «Размер» — картинка или видео под W×H, ffmpeg локально, бесплатно.
    .post('/api/media/resize', async (c) => {
      const body = (await c.req.json()) as { source?: unknown; width?: unknown; height?: unknown; fit?: unknown };
      const source = RefSourceSchema.safeParse(body.source);
      // Стороны чётные: H.264 в yuv420p нечётных не принимает, а картинке это не вредит.
      const side = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 16 && v <= 8192 && v % 2 === 0 ? v : null);
      const width = side(body.width);
      const height = side(body.height);
      const fit = body.fit === 'contain' ? 'contain' : 'cover';
      if (!source.success || width === null || height === null) return c.json({ error: 'BAD_RESIZE', messageRu: 'Нужен файл и чётный размер от 16 до 8192 px по каждой стороне. Нечётный размер не округляется автоматически.' }, 422);
      let input: string;
      let kind: 'image' | 'video' = 'image';
      let tmpInput: string | null = null;
      if (source.data.type === 'media') {
        const item = await gen.library.get(source.data.mediaId);
        if (item === undefined) return c.json({ error: 'NOT_FOUND', messageRu: 'Файла нет в библиотеке.' }, 404);
        input = gen.library.pathOf(item);
        kind = item.kind;
      } else if (source.data.type === 'upload') {
        const found = await gen.uploads.read(source.data.uploadId);
        if (found === undefined) return c.json({ error: 'NOT_FOUND', messageRu: 'Загруженная картинка не найдена.' }, 404);
        await mkdir(gen.library.root, { recursive: true });
        tmpInput = path.join(gen.library.root, `.resize-in-${Date.now().toString(36)}-${found.upload.fileName}`);
        await writeFile(tmpInput, found.bytes);
        input = tmpInput;
      } else {
        return c.json({ error: 'BAD_SOURCE', messageRu: 'Картинку референса проекта сначала добавь в библиотеку.' }, 422);
      }
      const label = `Размер ${width}×${height} · ${fit === 'cover' ? 'заполнить' : 'вписать'}`;
      const sourceId = source.data.type === 'media' ? source.data.mediaId : null;
      const existing = sourceId === null ? undefined : (await gen.library.list()).find((m) => m.modelId === 'local/resize' && m.prompt === label && m.refs.some((r) => r.source.type === 'media' && r.source.mediaId === sourceId));
      if (existing !== undefined) return c.json(existing);
      const ext = kind === 'video' ? 'mp4' : 'png';
      const out = path.join(gen.library.root, `.resize-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.${ext}`);
      try {
        await (options.ffmpeg ?? runFfmpeg)(resizeArgs(input, out, width, height, fit, kind === 'video'));
        await (options.validateMedia ?? validateMediaFile)(out, kind);
        const item = await gen.library.importFile(out, ext, {
          kind,
          jobId: 'local-resize',
          taskId: null,
          provider: 'local',
          modelId: 'local/resize',
          providerModel: 'ffmpeg',
          prompt: label,
          params: {},
          refs: [{ label: 'Исходник', source: source.data, role: 'ref' }],
          origin: null,
          sessionId: null,
          index: 0,
          sourceUrl: '',
          creditsConsumed: 0,
          createdAt: new Date().toISOString(),
        });
        return c.json(item, 201);
      } catch (error) {
        return c.json({ error: 'RESIZE_FAILED', messageRu: error instanceof Error ? error.message : 'Размер не подогнался.' }, 500);
      } finally {
        if (tmpInput !== null) await rm(tmpInput, { force: true });
        await rm(out, { force: true });
      }
    })
    // Свой файл в библиотеку (решение 36): съёмку можно резать, брать из неё кадр и отдавать в canvas, как сгенерированное.
    .post('/api/library/import', async (c) => {
      const type = IMPORT_EXT[(c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? ''];
      if (type === undefined) return c.json({ error: 'BAD_TYPE', messageRu: 'Подходят PNG, JPG, WebP и видео MP4, MOV, WebM.' }, 415);
      if (Number(c.req.header('content-length') ?? 0) > MAX_IMPORT_BYTES) return c.json({ error: 'TOO_LARGE', messageRu: 'Файл больше 1 ГБ.' }, 413);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength === 0) return c.json({ error: 'EMPTY', messageRu: 'Пустой файл.' }, 422);
      if (bytes.byteLength > MAX_IMPORT_BYTES) return c.json({ error: 'TOO_LARGE', messageRu: 'Файл больше 1 ГБ — сожми или обрежь его заранее.' }, 413);
      const name = (c.req.query('name') ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 120);
      const tmp = path.join(gen.library.root, `.import-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.${type.ext}`);
      await mkdir(gen.library.root, { recursive: true });
      await writeFile(tmp, bytes);
      try { await (options.validateMedia ?? validateMediaFile)(tmp, type.kind); }
      catch { await rm(tmp, { force: true }); return c.json({ error: 'BAD_MEDIA', messageRu: 'Файл повреждён или его содержимое не соответствует выбранному типу.' }, 422); }
      const item = await gen.library.importFile(tmp, type.ext, {
        kind: type.kind,
        jobId: 'local-import',
        taskId: null,
        provider: 'local',
        modelId: 'local/import',
        providerModel: 'upload',
        prompt: name === '' ? 'Свой файл' : name,
        params: {},
        refs: [],
        origin: null,
        sessionId: null,
        index: 0,
        sourceUrl: '',
        creditsConsumed: 0,
        createdAt: new Date().toISOString(),
      });
      return c.json(item, 201);
    })
    // Обрезка видео по времени (решение 35): нода canvas «Обрезка», бесплатно, локально ffmpeg; результат — новое видео библиотеки.
    .post('/api/library/:id/trim', async (c) => {
      const video = await gen.library.get(c.req.param('id'));
      if (video === undefined || video.kind !== 'video') return c.json({ error: 'NOT_VIDEO', messageRu: 'Обрезать по времени можно видео из библиотеки.' }, 422);
      const body = (await c.req.json()) as { start?: unknown; end?: unknown };
      const start = typeof body.start === 'number' && Number.isFinite(body.start) && body.start >= 0 ? Math.round(body.start * 100) / 100 : null;
      const end = typeof body.end === 'number' && Number.isFinite(body.end) && body.end >= 0 ? Math.round(body.end * 100) / 100 : null;
      if (start === null || end === null || (end !== 0 && end - start < 0.2)) return c.json({ error: 'BAD_TRIM', messageRu: 'Конец должен быть позже начала хотя бы на 0.2 с (0 — до конца).' }, 422);
      const info = await (options.probeVideo ?? probeVideo)(gen.library.pathOf(video)).catch(() => null);
      if (info === null || start >= info.durationSec || (end !== 0 && end > info.durationSec) || (end === 0 ? info.durationSec : end) - start < 0.2) return c.json({ error: 'BAD_TRIM', messageRu: 'Отрезок должен находиться внутри видео и длиться хотя бы 0.2 с.' }, 422);
      const label = `Обрезка ${start.toFixed(2)}–${end === 0 ? 'конец' : `${end.toFixed(2)} с`}`;
      // Тот же отрезок того же видео — тот же файл: повторный клик не плодит копии.
      const existing = (await gen.library.list()).find((m) => m.modelId === 'local/trim' && m.params.start === start && m.params.end === end && m.refs.some((r) => r.source.type === 'media' && r.source.mediaId === video.id));
      if (existing !== undefined) return c.json(existing);
      const out = path.join(gen.library.root, `.trim-${video.id}-${randomBytes(4).toString('hex')}.mp4`);
      try {
        await (options.ffmpeg ?? runFfmpeg)(trimArgs(gen.library.pathOf(video), out, start, end));
        await (options.validateMedia ?? validateMediaFile)(out, 'video');
        const item = await gen.library.importFile(out, 'mp4', {
          kind: 'video',
          jobId: 'local-trim',
          taskId: null,
          provider: 'local',
          modelId: 'local/trim',
          providerModel: 'ffmpeg',
          prompt: label,
          params: { start, end },
          refs: [{ label: 'Видео', source: { type: 'media', mediaId: video.id }, role: 'ref' }],
          origin: video.origin,
          sessionId: video.sessionId,
          index: 0,
          sourceUrl: '',
          creditsConsumed: 0,
          createdAt: new Date().toISOString(),
        });
        return c.json(item, 201);
      } catch (error) {
        return c.json({ error: 'TRIM_FAILED', messageRu: error instanceof Error ? error.message : 'Видео не обрезалось.' }, 500);
      } finally { await rm(out, { force: true }); }
    })
    // Обрезка (решение 34): бесплатно, локально ffmpeg; результат — новая версия (исходник — референс), провайдер не нужен.
    .post('/api/library/:id/crop', async (c) => {
      const image = await gen.library.get(c.req.param('id'));
      if (image === undefined || image.kind !== 'image') return c.json({ error: 'NOT_IMAGE', messageRu: 'Обрезать можно картинку из библиотеки.' }, 422);
      const body = (await c.req.json()) as { x?: unknown; y?: unknown; w?: unknown; h?: unknown; labelRu?: unknown };
      const part = (v: unknown): number | null => (typeof v === 'number' && v >= 0 && v <= 1 ? Math.round(v * 10_000) / 10_000 : null);
      const [x, y, w, h] = [part(body.x), part(body.y), part(body.w), part(body.h)];
      if (x === null || y === null || w === null || h === null || w < 0.02 || h < 0.02 || x + w > 1.0001 || y + h > 1.0001) return c.json({ error: 'BAD_CROP', messageRu: 'Рамка обрезки вышла за картинку или слишком мала.' }, 422);
      const out = path.join(gen.library.root, `.crop-${image.id}-${Date.now().toString(36)}.png`);
      try {
        await (options.ffmpeg ?? runFfmpeg)(cropArgs(gen.library.pathOf(image), out, { x, y, w, h }));
        const item = await gen.library.importFile(out, 'png', {
          kind: 'image',
          jobId: 'local-crop',
          taskId: null,
          provider: 'local',
          modelId: 'local/crop',
          providerModel: 'ffmpeg',
          prompt: typeof body.labelRu === 'string' && body.labelRu.trim() !== '' ? `Обрезка · ${body.labelRu.trim().slice(0, 40)}` : 'Обрезка',
          params: {},
          refs: [{ label: 'Исходник', source: { type: 'media', mediaId: image.id }, role: 'ref' }],
          origin: image.origin,
          sessionId: image.sessionId,
          index: 0,
          sourceUrl: '',
          creditsConsumed: 0,
          createdAt: new Date().toISOString(),
        });
        return c.json(item, 201);
      } catch (error) {
        return c.json({ error: 'CROP_FAILED', messageRu: error instanceof Error ? error.message : 'Обрезка не удалась.' }, 500);
      }
    })
    // Удалить файл навсегда (решение 36): файл, описание, избранное, папки, оценки; задача без файлов уходит из ленты.
    .delete('/api/library/:id', async (c) => {
      const id = c.req.param('id');
      if (!(await gen.library.remove(id))) return c.json({ error: 'NOT_FOUND', messageRu: 'Файла нет в библиотеке.' }, 404);
      for (const job of await gen.jobs.all()) {
        if (!job.mediaIds.includes(id)) continue;
        const mediaIds = job.mediaIds.map((m) => (m === id ? null : m));
        if (job.status === 'saved' && mediaIds.every((m) => m === null)) await gen.jobs.remove(job.id);
        else await gen.jobs.put({ ...job, mediaIds });
      }
      await journal.verdicts.update((list) => list.filter((v) => v.mediaId !== id));
      await forgetInFlows([id]);
      return c.json({ ok: true });
    })
    // Выгрузка для монтажа: копии выбранных файлов в data/exports/<дата> с понятными именами + Finder. Оригиналы на месте.
    .post('/api/library/export', async (c) => {
      const body = (await c.req.json()) as { mediaIds?: unknown };
      const ids = Array.isArray(body.mediaIds) ? body.mediaIds.filter((m): m is string => typeof m === 'string') : [];
      const items = (await Promise.all(ids.map((id) => gen.library.get(id)))).filter((m): m is NonNullable<typeof m> => m !== undefined);
      if (items.length === 0) return c.json({ error: 'EMPTY', messageRu: 'Выбери файлы для выгрузки.' }, 422);
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
      const dir = path.join(options.dataDir, 'exports', `${stamp}-${randomBytes(4).toString('hex')}`);
      await mkdir(dir, { recursive: true });
      const slug = (text: string): string =>
        text
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim()
          .split(/\s+/)
          .slice(0, 6)
          .join(' ')
          .slice(0, 48);
      const files: string[] = [];
      for (const [i, item] of items.entries()) {
        const ext = item.file.split('.').pop() ?? 'bin';
        const name = `${String(i + 1).padStart(2, '0')} ${sourceTitleRu(item.modelId)} ${slug(item.prompt)}`.trim().replace(/\/+/g, '-');
        await copyFile(gen.library.pathOf(item), path.join(dir, `${name}.${ext}`));
        files.push(`${name}.${ext}`);
      }
      if (options.reveal !== false) (options.reveal ?? revealInFinder)(dir);
      const downloadUrl = process.env.SP_SERVE_STATIC === '1' ? await archiveDirectory(options.dataDir, dir) : undefined;
      return c.json({ dir, files, downloadUrl });
    })
    .post('/api/library/:id/reveal', async (c) => {
      const item = await gen.library.get(c.req.param('id'));
      if (item === undefined) return c.json({ error: 'NOT_FOUND', messageRu: 'Файла нет в библиотеке.' }, 404);
      if (options.reveal !== false) (options.reveal ?? revealInFinder)(gen.library.pathOf(item));
      return c.json({ ok: true });
    })
    // Картинки для студии с диска / из буфера. Тип — по content-type запроса, только jpg / png / webp.
    .post('/api/uploads', async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > MAX_REF_BYTES) return c.json({ error: 'TOO_LARGE', messageRu: 'Картинка больше 30 МБ — модели такую не примут.' }, 413);
      const upload = await gen.uploads.save(bytes, (c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? '');
      return upload === null ? c.json({ error: 'BAD_TYPE', messageRu: 'Подходят только JPG, PNG и WebP.' }, 415) : c.json(upload, 201);
    })
    .get('/api/uploads/:id', async (c) => {
      const found = await gen.uploads.read(c.req.param('id'));
      if (found === undefined) return c.json({ error: 'NOT_FOUND', messageRu: 'Картинка не найдена.' }, 404);
      return c.body(found.bytes as Uint8Array<ArrayBuffer>, 200, { 'content-type': found.upload.mime, 'cache-control': 'private, max-age=31536000, immutable' });
    });

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
