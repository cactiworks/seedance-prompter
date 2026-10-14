import { Hono } from 'hono';
import type { Characters } from './characters.ts';
import { CreateCharacterSchema } from '../../core/production/character.ts';
import { SoulIdError } from './soulId.ts';

export function characterRoutes(characters: Characters) {
  return new Hono()
    .onError((error, c) => error instanceof SoulIdError ? c.json({ messageRu: error.message }, error.status) : c.json({ messageRu: 'Не удалось сохранить персонажа.' }, 500))
    .get('/', async (c) => c.json(await characters.list()))
    .post('/', async (c) => {
      const input = CreateCharacterSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ messageRu: 'Нужны имя, 1–100 фото, согласие на отправку и подтверждение неизвестной стоимости.' }, 422);
      return c.json(await characters.create(input.data), 202);
    })
    .post('/refresh', async (c) => c.json(await characters.refresh()))
    .post('/sync', async (c) => c.json(await characters.sync()));
}
