import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CHARACTER_ID, CreateCharacterSchema, characterReady, type Character, type CharacterSelection, type CreateCharacterInput } from '../../core/production/character.ts';
import { imageSize } from '../gen/imageSize.ts';
import { createUploads, MAX_UPLOAD_BYTES } from '../storage/uploads.ts';
import { createSoulIdProvider, SoulIdError, type SoulIdProvider, type SoulReference } from './soulId.ts';

interface StoredCharacter extends Character { requestDigest?: string }
export function createCharacters(options: { dataDir: string; provider?: SoulIdProvider }) {
  const dir = path.join(options.dataDir, 'characters');
  const uploads = createUploads(options.dataDir);
  const provider = options.provider ?? createSoulIdProvider();
  const pending = new Map<string, Promise<void>>();
  let tail: Promise<unknown> = Promise.resolve();
  let refreshPromise: Promise<Character[]> | null = null;
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const result = tail.then(fn); tail = result.catch(() => undefined); return result; };
  const stamp = () => new Date().toISOString();
  async function read(id: string): Promise<StoredCharacter> {
    if (!CHARACTER_ID.test(id)) throw new SoulIdError('Персонаж не найден.', 404);
    try { return JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8')) as StoredCharacter; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SoulIdError('Персонаж не найден.', 404); throw error; }
  }
  async function write(character: StoredCharacter): Promise<StoredCharacter> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${character.id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(character), { mode: 0o600 }); await rename(`${file}.tmp`, file);
    return character;
  }
  async function readAll(): Promise<StoredCharacter[]> {
    await mkdir(dir, { recursive: true });
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json') && CHARACTER_ID.test(name.slice(0, -5)));
    return (await Promise.all(files.map((name) => read(name.slice(0, -5))))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function change(id: string, patch: Partial<StoredCharacter>): Promise<StoredCharacter> {
    return exclusive(async () => write({ ...await read(id), ...patch, updatedAt: stamp() }));
  }
  async function photo(id: string) {
    const file = await uploads.read(id);
    if (!file || file.bytes.byteLength > MAX_UPLOAD_BYTES) throw new SoulIdError('Фото не найдено или превышает 30 МБ.', 422);
    const size = imageSize(file.bytes);
    if (!size || size.width <= 0 || size.height <= 0) throw new SoulIdError('Не удалось прочитать фото. Нужен JPG, PNG или WebP.', 422);
    return file;
  }
  function launch(character: Character): void {
    const job = Promise.resolve().then(async () => {
      let submitted = false;
      try {
        const urls: string[] = [];
        for (const id of character.uploadIds) {
          const file = await photo(id);
          urls.push(await provider.upload(file.bytes, file.upload.mime));
          await change(character.id, { uploadedCount: urls.length });
        }
        await change(character.id, { status: 'submitting' });
        submitted = true;
        const reference = await provider.create(character.name, urls);
        await change(character.id, { referenceId: reference.id, status: reference.status, modelVersion: reference.model_version === undefined || reference.model_version === 'v2' ? 'v2' : 'unknown', error: null });
      } catch (error) {
        await change(character.id, {
          status: submitted ? 'unknown' : 'failed',
          error: submitted ? 'Не удалось подтвердить результат создания. Не создавай повторно: сначала проверь список Soul ID в Higgsfield. Автоповтора нет.' : error instanceof SoulIdError ? error.message : 'Отправка фото остановлена. Создание Soul ID не запускалось.',
        });
      }
    }).catch(() => { /* Persisted submitting/uploading state is recovered on the next read. Never resubmit. */ }).finally(() => pending.delete(character.id));
    pending.set(character.id, job);
  }
  async function list(): Promise<Character[]> {
    return exclusive(async () => {
      const characters = await readAll();
      for (const character of characters) if (['uploading', 'submitting'].includes(character.status) && !pending.has(character.id)) {
        const submitted = character.status === 'submitting';
        character.status = submitted ? 'unknown' : 'failed';
        character.error = submitted ? 'Создание прервано перезапуском. Проверь Soul ID в Higgsfield перед новой отправкой; автоповтора нет.' : 'Отправка фото прервана перезапуском. Soul ID не создавался.';
        character.updatedAt = stamp(); await write(character);
      }
      return characters;
    });
  }
  async function updateReference(character: Character, reference: SoulReference): Promise<StoredCharacter> {
    if (reference.id !== character.referenceId) throw new SoulIdError('Higgsfield вернул другой Soul ID.');
    return change(character.id, { status: reference.status, modelVersion: reference.model_version === undefined ? character.modelVersion : reference.model_version === 'v2' ? 'v2' : 'unknown', error: reference.status === 'failed' ? 'Higgsfield не смог подготовить персонажа.' : null });
  }
  return {
    list,
    async create(raw: CreateCharacterInput): Promise<Character> {
      const parsed = CreateCharacterSchema.safeParse(raw);
      if (!parsed.success) throw new SoulIdError('Нужны имя, 1–100 фото, согласие на отправку и подтверждение неизвестной стоимости.', 422);
      const input = parsed.data;
      const id = `ch-${input.requestId}`;
      const requestDigest = createHash('sha256').update(JSON.stringify([input.name, input.uploadIds])).digest('hex');
      return exclusive(async () => {
        const previous = await read(id).catch((error: unknown) => { if (error instanceof SoulIdError && error.status === 404) return null; throw error; });
        if (previous) {
          if (previous.requestDigest !== requestDigest) throw new SoulIdError('Эта отправка уже сохранена с другими фото или именем.', 409);
          return previous;
        }
        // Validate the entire batch before any remote upload or creation.
        for (const uploadId of input.uploadIds) await photo(uploadId);
        const character = await write({ id, name: input.name, requestDigest, referenceId: null, modelVersion: 'v2', uploadIds: input.uploadIds, uploadedCount: 0, status: 'uploading', createdAt: stamp(), updatedAt: stamp(), error: null });
        launch(character);
        return character;
      });
    },
    async refresh(): Promise<Character[]> {
      if (refreshPromise) return refreshPromise;
      refreshPromise = (async () => {
        for (const character of await list()) if (character.referenceId && !['completed', 'failed'].includes(character.status)) {
          try { await updateReference(character, await provider.get(character.referenceId)); }
          catch (error) { await change(character.id, { error: error instanceof SoulIdError ? error.message : 'Статус временно недоступен. Создание не повторялось.' }); }
        }
        return list();
      })().finally(() => { refreshPromise = null; });
      return refreshPromise;
    },
    async sync(): Promise<Character[]> {
      // List is read-only at Higgsfield. Never match ambiguous submissions by name.
      let page = 1; let total = 1;
      do {
        const result = await provider.list(page); total = result.total_pages;
        await exclusive(async () => {
          const existing = await readAll();
          for (const reference of result.items) {
            const previous = existing.find((c) => c.referenceId === reference.id);
            const time = stamp();
            await write({ ...(previous ?? { id: `ch-${reference.id}`, referenceId: reference.id, uploadIds: [], uploadedCount: 0, createdAt: time }), modelVersion: reference.model_version === undefined ? previous?.modelVersion ?? 'unknown' : reference.model_version === 'v2' ? 'v2' : 'unknown', name: reference.name, status: reference.status, updatedAt: time, error: null });
          }
        });
        page++;
      } while (page <= total);
      return list();
    },
    async select(id: string): Promise<CharacterSelection> {
      const character = await read(id);
      if (!characterReady(character)) throw new SoulIdError('Выбери готовый Soul ID версии v2.', 422);
      const updated = await updateReference(character, await provider.get(character.referenceId!));
      if (!characterReady(updated)) throw new SoulIdError('Soul ID ещё не готов или недоступен.', 422);
      return { id: character.id, name: character.name, referenceId: character.referenceId!, modelVersion: 'v2', selectedAt: stamp() };
    },
    wait: async (id: string): Promise<void> => { await pending.get(id); },
  };
}
export type Characters = ReturnType<typeof createCharacters>;
