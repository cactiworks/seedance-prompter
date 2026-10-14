import { z } from 'zod';

export const CHARACTER_ID = /^ch-[a-z0-9-]{6,70}$/;
export const CreateCharacterSchema = z.object({
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  uploadIds: z.array(z.string().regex(/^u-[a-z0-9-]{6,64}$/)).min(1).max(100).refine((ids) => new Set(ids).size === ids.length),
  consent: z.literal(true),
  costConfirmed: z.literal('unknown'),
}).strict();
export type CreateCharacterInput = z.infer<typeof CreateCharacterSchema>;
export type CharacterStatus = 'uploading' | 'submitting' | 'not_ready' | 'queued' | 'in_progress' | 'completed' | 'failed' | 'unknown';
export interface Character {
  id: string; name: string; referenceId: string | null; modelVersion: 'v2' | 'unknown';
  status: CharacterStatus; uploadIds: string[]; uploadedCount: number;
  createdAt: string; updatedAt: string; error: string | null;
}
export interface CharacterSelection { id: string; name: string; referenceId: string; modelVersion: 'v2'; selectedAt: string }
export const CHARACTER_STATUS: Record<CharacterStatus, string> = {
  uploading: 'Отправка фото', submitting: 'Создание Soul ID', not_ready: 'Подготовка', queued: 'В очереди',
  in_progress: 'Обучение', completed: 'Готов', failed: 'Ошибка', unknown: 'Результат отправки неизвестен',
};
export const characterPending = (character: Character): boolean => ['uploading', 'submitting', 'not_ready', 'queued', 'in_progress'].includes(character.status);
export const characterReady = (character: Character): boolean => character.status === 'completed' && character.referenceId !== null && character.modelVersion === 'v2';
