import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from '../gen/imageSize.ts';
import { validateMediaFile } from '../gen/validateMedia.ts';

export const UPLOAD_ID = /^u-[a-z0-9-]{6,64}$/;
const UPLOAD_FILE = /^(u-[a-z0-9-]{6,64})\.(png|jpg|webp)$/;
const EXT_BY_MIME: Record<string, 'png' | 'jpg' | 'webp'> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const UPLOAD_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export interface Upload {
  id: string;
  fileName: string;
  mime: string;
}

/** Картинки, которые владелец кладёт в студию с диска: data/uploads/<id>.<ext>. Живут, пока их не удалят руками. */
export function createUploads(dataDir: string) {
  const dir = path.join(dataDir, 'uploads');

  async function find(id: string): Promise<Upload | undefined> {
    if (!UPLOAD_ID.test(id)) return undefined;
    await mkdir(dir, { recursive: true });
    const fileName = (await readdir(dir)).find((f) => UPLOAD_FILE.exec(f)?.[1] === id);
    if (fileName === undefined) return undefined;
    return { id, fileName, mime: UPLOAD_MIME[fileName.split('.').pop() ?? ''] ?? 'image/png' };
  }

  return {
    /** null — формат не картинка jpg/png/webp. */
    async save(bytes: Uint8Array, mime: string): Promise<Upload | null> {
      const ext = EXT_BY_MIME[mime];
      if (ext === undefined) return null;
      const size = imageSize(bytes);
      if (size === null || size.width < 1 || size.height < 1) return null;
      await mkdir(dir, { recursive: true });
      const id = `u-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
      const fileName = `${id}.${ext}`;
      await writeFile(path.join(dir, `${fileName}.tmp`), bytes);
      try { await validateMediaFile(path.join(dir, `${fileName}.tmp`), 'image'); }
      catch { await rm(path.join(dir, `${fileName}.tmp`), { force: true }); return null; }
      await rename(path.join(dir, `${fileName}.tmp`), path.join(dir, fileName));
      return { id, fileName, mime };
    },
    find,
    async read(id: string): Promise<{ upload: Upload; bytes: Uint8Array } | undefined> {
      const upload = await find(id);
      if (upload === undefined) return undefined;
      return { upload, bytes: await readFile(path.join(dir, upload.fileName)) };
    },
  };
}

export type Uploads = ReturnType<typeof createUploads>;
