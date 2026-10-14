import { Hono } from 'hono';
import { z } from 'zod';
import { CHARACTER_ID } from '../../core/production/character.ts';
import type { Characters } from './characters.ts';
import { SoulIdError } from './soulId.ts';
import { ProductionError } from '../../core/production/engine.ts';
import { ActionSchema, CreateRunSchema } from '../../core/production/model.ts';
import type { ProductionRuntime } from './runtime.ts';

export function productionRoutes(runtime: ProductionRuntime, characters: Characters) {
  return new Hono()
    .onError((error, c) => {
      if (error instanceof SoulIdError) return c.json({ messageRu: error.message }, error.status);
      if (error instanceof ProductionError) return c.json({ messageRu: error.message }, error.code === 'CONFLICT' ? 409 : error.code === 'NOT_FOUND' ? 404 : 422);
      console.error('Production:', error);
      return c.json({ messageRu: 'Не удалось сохранить или прочитать mock-серию.' }, 500);
    })
    .get('/', async (c) => c.json(await runtime.list()))
    .post('/', async (c) => {
      const input = CreateRunSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ messageRu: 'Нужны название, сценарий и визуальный вектор. Доступен только mock-режим.' }, 422);
      const character = input.data.characterId ? await characters.select(input.data.characterId) : null;
      return c.json(await runtime.create(input.data, character), 201);
    })
    .get('/:id', async (c) => c.json(await runtime.get(c.req.param('id'))))
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
      c.header('content-disposition', `attachment; filename="${run.id}-mock-manifest.json"`);
      return c.json({ mode: 'mock', character: run.character ?? null, title: run.title, script: run.script, direction: run.direction, planningMode: run.planningMode ?? 'mock', scenePlan: run.scenePlan ?? null, promptPlan: run.promptPlan ?? null, note: 'Медиа — локальные демонстрационные материалы, не иллюстрация реального плана. Итоговое видео остаётся 480p.', artifacts: run.artifacts.filter((a) => ids.has(a.id)), approvals: run.approvals });
    });
}
