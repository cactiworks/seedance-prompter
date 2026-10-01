import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { FolderSchema, MediaItemSchema, type Folder, type MediaItem } from '../../core/model/media.ts';

export const MEDIA_ID = /^m-[a-z0-9-]{6,64}$/;
const MONTH = /^\d{4}-\d{2}$/;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};
export const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]));
MIME_BY_EXT.jpeg = 'image/jpeg';

export class DownloadError extends Error {
  /** HTTP-статус ответа; 0 — сеть. */
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const newMediaId = (): string => `m-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

function extOf(url: string, mime: string, kind: MediaItem['kind']): string {
  const byMime = EXT_BY_MIME[mime];
  if (byMime !== undefined) return byMime;
  const byUrl = /\.([a-z0-9]{3,4})(?:$|[?#])/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  if (byUrl !== undefined && MIME_BY_EXT[byUrl] !== undefined) return byUrl === 'jpeg' ? 'jpg' : byUrl;
  return kind === 'video' ? 'mp4' : 'png';
}

export type MediaMeta = Omit<MediaItem, 'id' | 'file' | 'mime' | 'bytes' | 'sha256' | 'savedAt'>;

/** Библиотека всего сгенерированного: data/library/<yyyy-mm>/<id>.<ext> + <id>.json. Не зависит от проектов. */
export function createLibrary(dataDir: string, options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const root = path.join(dataDir, 'library');
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const index = new Map<string, MediaItem>();
  let loaded = false;

  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    await mkdir(root, { recursive: true });
    for (const month of await readdir(root)) {
      if (!MONTH.test(month)) continue;
      for (const file of await readdir(path.join(root, month))) {
        if (!file.endsWith('.json') || !MEDIA_ID.test(file.slice(0, -5))) continue;
        try {
          const item = MediaItemSchema.parse(JSON.parse(await readFile(path.join(root, month, file), 'utf8')));
          index.set(item.id, item);
        } catch {
          /* битое описание не роняет библиотеку */
        }
      }
    }
  }

  /** Абсолютный путь файла; путь из описания проверяется, чтобы не выйти за пределы библиотеки. */
  const pathOf = (item: MediaItem): string => {
    const full = path.resolve(root, item.file);
    if (!full.startsWith(root + path.sep)) throw new Error('Путь файла вне библиотеки.');
    return full;
  };

  return {
    load,
    root,
    pathOf,

    /**
     * Скачать результат потоком, посчитать sha256, положить файл и описание рядом. Описание пишется
     * последним: если есть .json, файл точно на месте.
     */
    async download(url: string, meta: MediaMeta): Promise<MediaItem> {
      await load();
      let res: Response;
      try {
        res = await doFetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
      } catch (error) {
        throw new DownloadError(0, error instanceof Error ? error.message : 'сеть');
      }
      if (!res.ok || res.body === null) throw new DownloadError(res.status, `HTTP ${res.status}`);

      const id = newMediaId();
      const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const ext = extOf(url, mime, meta.kind);
      const month = new Date(now()).toISOString().slice(0, 7);
      const dir = path.join(root, month);
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, `${id}.${ext}`);
      const tmp = `${target}.part`;

      const hash = createHash('sha256');
      let bytes = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          bytes += chunk.length;
          done(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body as WebReadableStream), tap, createWriteStream(tmp));
      } catch (error) {
        await rm(tmp, { force: true });
        throw new DownloadError(0, `обрыв при скачивании: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (bytes === 0) {
        await rm(tmp, { force: true });
        throw new DownloadError(res.status, 'пустой файл');
      }
      await rename(tmp, target);

      const item = MediaItemSchema.parse({
        ...meta,
        id,
        file: `${month}/${id}.${ext}`,
        mime: MIME_BY_EXT[ext] ?? (mime || 'application/octet-stream'),
        bytes,
        sha256: hash.digest('hex'),
        savedAt: new Date(now()).toISOString(),
      });
      const sidecar = path.join(dir, `${id}.json`);
      await writeFile(`${sidecar}.tmp`, `${JSON.stringify(item, null, 1)}\n`);
      await rename(`${sidecar}.tmp`, sidecar);
      index.set(id, item);
      return item;
    },

    /** Положить в библиотеку локальный файл (например, кадр, извлечённый ffmpeg). Файл переносится. */
    async importFile(source: string, ext: string, meta: MediaMeta): Promise<MediaItem> {
      await load();
      const bytes = await readFile(source);
      if (bytes.byteLength === 0) throw new Error('Пустой файл.');
      const id = newMediaId();
      const month = new Date(now()).toISOString().slice(0, 7);
      const dir = path.join(root, month);
      await mkdir(dir, { recursive: true });
      await rename(source, path.join(dir, `${id}.${ext}`));
      const item = MediaItemSchema.parse({
        ...meta,
        id,
        file: `${month}/${id}.${ext}`,
        mime: MIME_BY_EXT[ext] ?? 'application/octet-stream',
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        savedAt: new Date(now()).toISOString(),
      });
      const sidecar = path.join(dir, `${id}.json`);
      await writeFile(`${sidecar}.tmp`, `${JSON.stringify(item, null, 1)}\n`);
      await rename(`${sidecar}.tmp`, sidecar);
      index.set(id, item);
      return item;
    },

    async get(id: string): Promise<MediaItem | undefined> {
      await load();
      return MEDIA_ID.test(id) ? index.get(id) : undefined;
    },

    /** Новые первыми. */
    async list(): Promise<MediaItem[]> {
      await load();
      return [...index.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },

    /**
     * Удалить файл навсегда: сам файл, описание, отметки в избранном и папках. Сначала описание — если процесс
     * упадёт посередине, библиотека просто не увидит осиротевший файл.
     */
    async remove(id: string): Promise<boolean> {
      await load();
      const item = MEDIA_ID.test(id) ? index.get(id) : undefined;
      if (item === undefined) return false;
      const file = pathOf(item);
      await rm(file.replace(/\.[a-z0-9]+$/i, '.json'), { force: true });
      await rm(file, { force: true });
      index.delete(id);
      const favorites = await this.favorites();
      if (favorites.includes(id)) await this.setFavorite(id, false);
      const folders = await this.folders();
      if (folders.some((f) => f.mediaIds.includes(id))) await this.updateFolders((list) => list.map((f) => ({ ...f, mediaIds: f.mediaIds.filter((m) => m !== id) })));
      return true;
    },

    /** Избранное — отдельный файл: описания файлов после сохранения не меняются. */
    async favorites(): Promise<string[]> {
      try {
        const ids = JSON.parse(await readFile(path.join(root, 'favorites.json'), 'utf8')) as unknown;
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && MEDIA_ID.test(id)) : [];
      } catch {
        return [];
      }
    },

    async setFavorite(id: string, on: boolean): Promise<string[]> {
      const current = await this.favorites();
      const next = on ? [...new Set([...current, id])] : current.filter((f) => f !== id);
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'favorites.json.tmp'), `${JSON.stringify(next)}\n`);
      await rename(path.join(root, 'favorites.json.tmp'), path.join(root, 'favorites.json'));
      return next;
    },

    async folders(): Promise<Folder[]> {
      try {
        return z.array(FolderSchema).parse(JSON.parse(await readFile(path.join(root, 'folders.json'), 'utf8')));
      } catch {
        return [];
      }
    },

    /** Правка папок одной функцией над списком; запись атомарная. */
    async updateFolders(recipe: (folders: Folder[]) => Folder[]): Promise<Folder[]> {
      const next = z.array(FolderSchema).parse(recipe(await this.folders()));
      await mkdir(root, { recursive: true });
      const tmp = path.join(root, `folders.json.${randomBytes(3).toString('hex')}.tmp`);
      await writeFile(tmp, `${JSON.stringify(next, null, 1)}\n`);
      await rename(tmp, path.join(root, 'folders.json'));
      return next;
    },

    async readBytes(item: MediaItem): Promise<Uint8Array> {
      return readFile(pathOf(item));
    },

    /** Ответ с поддержкой Range — видео в <video> перематывается без скачивания целиком. */
    async respond(item: MediaItem, rangeHeader: string | undefined): Promise<Response> {
      const file = pathOf(item);
      const size = (await stat(file)).size;
      const base = { 'content-type': item.mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000, immutable' };
      const range = rangeHeader === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (range !== null && (range[1] !== '' || range[2] !== '')) {
        const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
        if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream;
        return new Response(body, { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
      }
      const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
      return new Response(body, { status: 200, headers: { ...base, 'content-length': String(size) } });
    },
  };
}

export type Library = ReturnType<typeof createLibrary>;
