import { Hono } from 'hono';
import { z } from 'zod';
import { CHARACTER_ID } from '../../core/production/character.ts';
import type { Characters } from './characters.ts';
import { SoulIdError } from './soulId.ts';
import { ProductionError } from '../../core/production/engine.ts';
import { PhotoStartSchema } from '../../core/production/photos.ts';
import { ReviewStartSchema } from '../../core/production/review.ts';
import { SubmitError } from '../gen/runtime.ts';
import { ActionSchema, CreateRunSchema } from '../../core/production/model.ts';
import type { ProductionRuntime } from './runtime.ts';

export function productionRoutes(runtime: ProductionRuntime, characters: Characters) {
  return new Hono()
    .onError((error, c) => {
      if (error instanceof SubmitError) return c.json({ messageRu: error.messageRu }, error.status);
      if (error instanceof SoulIdError) return c.json({ messageRu: error.message }, error.status);
      if (error instanceof ProductionError) return c.json({ messageRu: error.message }, error.code === 'CONFLICT' ? 409 : error.code === 'NOT_FOUND' ? 404 : 422);
      console.error('Production:', error);
      return c.json({ messageRu: 'Не удалось сохранить или прочитать серию.' }, 500);
    })
    .get('/', async (c) => c.json(await runtime.list()))
    .post('/', async (c) => {
      const input = CreateRunSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ messageRu: 'Нужны название, сценарий и визуальный вектор.' }, 422);
      const character = input.data.characterId ? await characters.select(input.data.characterId) : null;
      return c.json(await runtime.create(input.data, character), 201);
    })
    .get('/issues', (c) => c.json(runtime.issues()))
    .get('/:id', async (c) => c.json(await runtime.get(c.req.param('id'))))
    .post('/:id/review', async (c) => {
      const input = ReviewStartSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ messageRu: 'Подтверди передачу изображений и расход квоты Codex.' }, 422);
      return c.json(await runtime.review.start(c.req.param('id'), input.data));
    })
    .get('/:id/photos/quote', async (c) => c.json(await runtime.photos.quote(c.req.param('id'))))
    .post('/:id/photos/start', async (c) => {
      const input = PhotoStartSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ messageRu: 'Подтверди стоимость и передачу references.' }, 422);
      const run = await runtime.get(c.req.param('id'));
      if (run.characterId) {
        const current = await characters.select(run.characterId);
        if (current.referenceId !== run.character?.referenceId) return c.json({ messageRu: 'Soul ID изменился. Выбери персонажа заново.' }, 409);
      }
      return c.json(await runtime.photos.start(run.id, input.data));
    })
    .post('/:id/photos/retry', async (c) => {
      const input = z.object({ jobId: z.string().min(1).max(100) }).strict().safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ messageRu: 'Нужен ID сохранённой задачи.' }, 422);
      return c.json(await runtime.photos.retry(c.req.param('id'), input.data.jobId));
    })
    .post('/:id/fork-photos', async (c) => {
      const input = z.object({ rev: z.number().int().nonnegative(), requestId: z.uuid() }).strict().safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ messageRu: 'Нужна текущая версия серии.' }, 422);
      return c.json(await runtime.forkPhotos(c.req.param('id'), input.data.rev, input.data.requestId), 201);
    })
    .post('/:id/character', async (c) => {
      const input = z.object({ rev: z.number().int().nonnegative(), characterId: z.string().regex(CHARACTER_ID).nullable() }).strict().safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ messageRu: 'Некорректный выбор персонажа.' }, 422);
      const character = input.data.characterId ? await characters.select(input.data.characterId) : null;
      return c.json(await runtime.setCharacter(c.req.param('id'), input.data.rev, character));
    })
    .post('/:id/actions', async (c) => {
      const action = ActionSchema.safeParse(await c.req.json().catch(() => null));
      if (!action.success) return c.json({ messageRu: 'Действие или версия серии некорректны.' }, 422);
      return c.json(await runtime.act(c.req.param('id'), action.data));
    })
    .get('/:id/manifest', async (c) => {
      const run = await runtime.get(c.req.param('id'));
      const ids = new Set(run.shots.flatMap((s) => [s.acceptedPhotoId, ...(s.step === 'ready' ? [s.finalId] : [])]));
      c.header('content-disposition', `attachment; filename="${run.id}-manifest.json"`);
      return c.json({ mode: run.mode, character: run.character ?? null, title: run.title, script: run.script, direction: run.direction, planningMode: run.planningMode ?? 'mock', scenePlan: run.scenePlan ?? null, promptPlan: run.promptPlan ?? null, note: run.mode === 'photos' ? `Реальные фото. Приняты владельцем; ${run.review?.status === 'complete' ? 'отчёт критика приложен отдельно' : 'сохранены до подключения критика'}. Видео и upscale отключены.` : 'Медиа — локальные демонстрационные материалы, не иллюстрация реального плана. Итоговое видео остаётся 480p.', review: run.review ?? null, masterReview: run.masterReview ?? null, appearance: run.appearance ?? null, artifacts: run.artifacts.filter((a) => ids.has(a.id)), approvals: run.approvals });
    });
}
