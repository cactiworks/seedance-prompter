import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MoodboardSchema, type Moodboard } from '../../core/model/media.ts';

/** Свои мудборды: data/moodboards.json. Картинки не копируются — это ссылки на загрузки и библиотеку. */
export function createMoodboards(dataDir: string) {
  const file = path.join(dataDir, 'moodboards.json');

  async function list(): Promise<Moodboard[]> {
    try {
      return z.array(MoodboardSchema).parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async function update(recipe: (list: Moodboard[]) => Moodboard[]): Promise<Moodboard[]> {
    const next = z.array(MoodboardSchema).parse(recipe(await list()));
    await mkdir(dataDir, { recursive: true });
    const tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 1));
    await rename(tmp, file);
    return next;
  }

  return { list, update };
}
