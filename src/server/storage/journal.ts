import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Learning, VerdictEntry } from '../../core/gen/calibration.ts';
import { LearningSchema, VerdictSchema } from '../../core/model/media.ts';

/** Список в одном JSON-файле data/: чтение с пустым списком по умолчанию, запись атомарно через .tmp. */
function jsonList<T>(file: string, schema: z.ZodType<T>) {
  async function list(): Promise<T[]> {
    try {
      return z.array(schema).parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async function update(recipe: (items: T[]) => T[]): Promise<T[]> {
    const next = z.array(schema).parse(recipe(await list()));
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 1));
    await rename(tmp, file);
    return next;
  }
  return { list, update };
}

/** Журнал калибровки: оценки владельца (data/verdicts.json) и его правила для моделей (data/learnings.json). */
export function createJournal(dataDir: string) {
  return {
    verdicts: jsonList<VerdictEntry>(path.join(dataDir, 'verdicts.json'), VerdictSchema),
    learnings: jsonList<Learning>(path.join(dataDir, 'learnings.json'), LearningSchema),
  };
}
