import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const writers = new Map<string, Promise<unknown>>();

/** Serialize the entire read/validate/write transaction, not just the final rename. */
export async function serialize<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = writers.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writers.set(key, current);
  try { return await current; }
  finally { if (writers.get(key) === current) writers.delete(key); }
}

export async function atomicWrite(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
