import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { APP_NAME, APP_VERSION } from '../core/meta.ts';
import { buildPlannerUser, extractLines, PLANNER_SCHEMA, validatePlan, type PlannerOutput } from '../core/llm/buildPlanner.ts';
import type { FewShot } from '../core/llm/buildWriter.ts';
import { newProject, ProjectSchema } from '../core/model/project.ts';
import type { PackBundle } from '../core/pipeline.ts';
import { LlmError, runClaude } from './llm/claudeCli/provider.ts';
import { writeShot, type Runner } from './llm/tasks/write.ts';
import { createStore, StoreError } from './storage/fsStore.ts';

export const HOST = '127.0.0.1';
export const PORT = 4317;

/** Заголовок, который обязан прислать наш клиент на любой мутации. */
export const CLIENT_HEADER = 'x-sp-client';

const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_REF_BYTES = 30 * 1024 * 1024;

export interface AppOptions {
  /** Корень репозитория: отсюда читается packs/. */
  rootDir: string;
  /** Каталог пользовательских данных (в .gitignore). */
  dataDir: string;
  /** Подменяется в тестах: живой вызов тратит квоту подписки. */
  runLlm?: Runner;
  writerModel?: string;
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
  return { id, verbatim: read('verbatim.json'), kits, dialects: read('dialects.json'), lexicon: read('lexicon.json'), lintParams: read('lint.json') };
}

const STATUS: Record<StoreError['code'], 400 | 404 | 409 | 422> = { BAD_SLUG: 400, BAD_FILE: 400, NOT_FOUND: 404, CONFLICT: 409, INVALID: 422 };

export function createApp(options: AppOptions) {
  const store = createStore(options.dataDir);
  const app = new Hono();

  // Сервер локальный, но любая веб-страница в браузере владельца может стучаться в localhost.
  // Без этих проверок она смогла бы тратить квоту LLM и читать референсы.
  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!ALLOWED_HOSTS.has(host)) return c.json({ error: 'FORBIDDEN_HOST' }, 403);

    const origin = c.req.header('origin');
    if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
      return c.json({ error: 'FORBIDDEN_ORIGIN' }, 403);
    }
    if (!SAFE_METHODS.has(c.req.method) && c.req.header(CLIENT_HEADER) === undefined) {
      return c.json({ error: 'MISSING_CLIENT_HEADER' }, 403);
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof StoreError) return c.json({ error: error.code, messageRu: error.message }, STATUS[error.code]);
    console.error(error);
    return c.json({ error: 'INTERNAL', messageRu: 'Внутренняя ошибка сервера.' }, 500);
  });

  const routes = app
    .get('/api/health', (c) => c.json({ ok: true, name: APP_NAME, version: APP_VERSION }))
    .get('/api/packs/:id', (c) => c.json(loadPack(options.rootDir, c.req.param('id'))))
    .get('/api/projects', async (c) => c.json(await store.list()))
    .post('/api/projects', async (c) => {
      const body = (await c.req.json()) as { slug?: string; title?: string };
      const project = await store.write(body.slug ?? '', newProject(body.slug ?? '', body.title ?? 'Без названия'), null);
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
      const body = (await c.req.json()) as { project?: unknown; shotId?: string };
      const project = ProjectSchema.parse(body.project);
      const packDir = path.join(options.rootDir, 'packs', project.packId);
      try {
        const result = await writeShot({
          project,
          shotId: body.shotId ?? '',
          pack: loadPack(options.rootDir, project.packId),
          rules: readFileSync(path.join(packDir, 'prompts/writer.system.md'), 'utf8'),
          fewshot: JSON.parse(readFileSync(path.join(packDir, 'prompts/fewshot/k2.json'), 'utf8')) as FewShot,
          run: options.runLlm ?? runClaude,
          model: options.writerModel ?? process.env.SP_WRITER_MODEL ?? 'opus',
          signal: c.req.raw.signal,
        });
        return c.json(result);
      } catch (error) {
        if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.messageRu }, error.code === 'USAGE_LIMIT' ? 429 : 502);
        return c.json({ error: 'WRITE_FAILED', messageRu: error instanceof Error ? error.message : 'Писатель не сработал.' }, 422);
      }
    })
    // Планировщик: русский синопсис кадра → отрезки по времени. Реплики вынуты из синопсиса заранее.
    .post('/api/llm/plan', async (c) => {
      const body = (await c.req.json()) as { project?: unknown; synopsisRu?: string };
      const project = ProjectSchema.parse(body.project);
      const { text, newLines } = extractLines(body.synopsisRu ?? '', project.lines);
      if (text.trim() === '') return c.json({ error: 'EMPTY', messageRu: 'Опиши кадр по-русски — хотя бы парой предложений.' }, 422);
      const lineIds = [...text.matchAll(/\bL\d+\b/g)].map((m) => m[0]).filter((id, i, all) => all.indexOf(id) === i);
      const translate = { place: project.world.place.en.trim() === '' && project.world.place.ru.trim() !== '', weather: project.world.weather.en.trim() === '' && project.world.weather.ru.trim() !== '' };
      const system = readFileSync(path.join(options.rootDir, 'packs', project.packId, 'prompts/planner.system.md'), 'utf8');
      const run = options.runLlm ?? runClaude;
      const request = { system, jsonSchema: PLANNER_SCHEMA, model: options.writerModel ?? process.env.SP_WRITER_MODEL ?? 'opus', fallbackModel: 'sonnet', effort: 'medium' as const, timeoutMs: 180_000, signal: c.req.raw.signal };
      try {
        const user = buildPlannerUser(project, text, lineIds, translate);
        let result = await run<PlannerOutput>({ ...request, user });
        let problems = validatePlan(result.data, lineIds);
        if (problems.length > 0) {
          result = await run<PlannerOutput>({ ...request, user: `${user}\n\nYour previous plan was rejected:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nPrevious plan:\n${JSON.stringify(result.data)}` });
          problems = validatePlan(result.data, lineIds);
        }
        return c.json({ plan: result.data, newLines, problems, meta: result.meta });
      } catch (error) {
        if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.messageRu }, error.code === 'USAGE_LIMIT' ? 429 : 502);
        throw error;
      }
    })
    .get('/api/projects/:slug/refs/:file', async (c) => {
      const file = c.req.param('file');
      const bytes = await store.readRef(c.req.param('slug'), file);
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'content-type': MIME[file.split('.').pop() ?? ''] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    });

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
