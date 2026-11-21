import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ReferenceFolderSchema, type ReferenceCard, type ReferenceFolder } from '../../core/references.ts';
import { atomicWrite, serialize } from '../storage/atomic.ts';
import { createReferenceAnalysis, ReferenceAnalysisSchema, ReferenceTagsSchema, type AnalysisResult } from './analysis.ts';
import { extractReferenceFrames, referenceInput, ReferenceLibraryError, writeReferenceInput } from './media.ts';

export { ReferenceLibraryError } from './media.ts';

const CARD_ID = /^rf-([a-f0-9]{64})-([0-7])$/;
const SOURCE_ID = /^[a-f0-9]{64}$/;
const CardVersionSchema = z.object({
  folder: ReferenceFolderSchema.nullable(),
  tags: ReferenceTagsSchema,
  analysis: ReferenceAnalysisSchema.nullable(),
});
const SourceSchema = z.object({
  name: z.string().min(1).max(160),
  frames: z.array(z.object({
    file: z.string().regex(/^frame-(?:cover|\d+)\.jpg$/),
    timeMs: z.number().int().nonnegative().nullable(),
    versions: z.array(CardVersionSchema).min(1),
    manualFolder: z.boolean().optional(),
    manualTags: z.boolean().optional(),
  })).min(1).max(8),
});
type Source = z.infer<typeof SourceSchema>;
type CardVersion = z.infer<typeof CardVersionSchema>;

const EMPTY: CardVersion = { folder: null, tags: [], analysis: null };

function selectedCard(sourceId: string, source: Source, index: number, version?: number): ReferenceCard | undefined {
  const frame = source.frames[index];
  if (!frame) return undefined;
  const revision = version ?? frame.versions.length;
  const values = frame.versions[revision - 1];
  if (!values) return undefined;
  return { id: `rf-${sourceId}-${index}`, sourceName: source.name, timeMs: frame.timeMs, version: revision, ...values };
}

function cardsFor(sourceId: string, source: Source): ReferenceCard[] {
  return source.frames.map((_, index) => selectedCard(sourceId, source, index)!);
}

function distinctTags(tags: string[]) {
  const unique = new Map<string, string>();
  for (const tag of ReferenceTagsSchema.parse(tags)) {
    const key = tag.toLocaleLowerCase('ru');
    if (!unique.has(key)) unique.set(key, tag);
  }
  return [...unique.values()];
}

export function createReferenceLibrary(root: string) {
  const storeDir = path.resolve(root, 'sources');
  const sourceDir = (id: string) => path.join(storeDir, id);
  const manifestPath = (id: string) => path.join(sourceDir(id), 'cards.json');
  let ready: Promise<void> | undefined;
  let imports = 0;

  function initialize() {
    return ready ??= (async () => {
      await mkdir(storeDir, { recursive: true, mode: 0o700 });
      const entries = await readdir(storeDir, { withFileTypes: true });
      // The application holds an exclusive data-directory lock while serving this store.
      await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith('.incoming-'))
        .map(entry => rm(path.join(storeDir, entry.name), { recursive: true, force: true })));
    })();
  }

  async function readSource(id: string): Promise<Source | undefined> {
    try {
      return SourceSchema.parse(JSON.parse(await readFile(manifestPath(id), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async function list(): Promise<ReferenceCard[]> {
    await initialize();
    const ids = (await readdir(storeDir)).filter(name => SOURCE_ID.test(name));
    const sources = await Promise.all(ids.map(async id => ({ id, source: await readSource(id) })));
    return sources.flatMap(({ id, source }) => source ? cardsFor(id, source) : [])
      .sort((a, b) => a.sourceName.localeCompare(b.sourceName, 'ru') || a.id.localeCompare(b.id));
  }

  async function get(id: string, version?: number): Promise<ReferenceCard | undefined> {
    const matches = CARD_ID.exec(id);
    if (!matches) return undefined;
    const source = await readSource(matches[1]!);
    return source && selectedCard(matches[1]!, source, Number(matches[2]), version);
  }

  async function imagePath(id: string): Promise<string | undefined> {
    const matches = CARD_ID.exec(id);
    if (!matches) return undefined;
    const frame = (await readSource(matches[1]!))?.frames[Number(matches[2])];
    return frame && path.join(sourceDir(matches[1]!), frame.file);
  }

  async function update(
    id: string,
    change: (frame: Source['frames'][number], current: CardVersion) => CardVersion,
  ): Promise<ReferenceCard | undefined> {
    const matches = CARD_ID.exec(id);
    if (!matches) return undefined;
    const sourceId = matches[1]!;
    const index = Number(matches[2]);
    const file = manifestPath(sourceId);
    return serialize(file, async () => {
      const source = await readSource(sourceId);
      const frame = source?.frames[index];
      if (!source || !frame) return undefined;
      const current = frame.versions.at(-1)!;
      const next = change(frame, current);
      if (JSON.stringify(next) !== JSON.stringify(current)) frame.versions.push(next);
      await atomicWrite(file, `${JSON.stringify(source)}\n`);
      return selectedCard(sourceId, source, index);
    });
  }

  async function saveAnalysis(result: AnalysisResult) {
    await update(result.id, (frame, current) => ({
      folder: frame.manualFolder ? current.folder : result.folder,
      tags: frame.manualTags ? current.tags : distinctTags(result.tags),
      analysis: result.analysis,
    }));
  }

  const analysis = createReferenceAnalysis(root, { list, imagePath, saveAnalysis });

  return {
    ...analysis,
    list,
    get,
    imagePath,
    edit(id: string, change: { folder?: ReferenceFolder | null; tags?: string[] }) {
      return update(id, (frame, current) => {
        if (change.folder !== undefined) frame.manualFolder = true;
        if (change.tags !== undefined) frame.manualTags = true;
        return {
          ...current,
          folder: change.folder === undefined ? current.folder : change.folder,
          tags: change.tags === undefined ? current.tags : distinctTags(change.tags),
        };
      });
    },
    async importFile(name: string, body: ReadableStream<Uint8Array> | null, mime?: string): Promise<ReferenceCard[]> {
      const input = referenceInput(name, mime);
      if (imports >= 2) throw new ReferenceLibraryError(503, 'Сейчас импортируются два файла. Повтори загрузку после их обработки.');
      imports++;
      let staging: string | undefined;
      try {
        await initialize();
        const incoming = await mkdtemp(path.join(storeDir, '.incoming-'));
        staging = incoming;
        const original = path.join(incoming, 'input');
        const id = await writeReferenceInput(original, body);
        return await serialize(manifestPath(id), async () => {
          const existing = await readSource(id);
          if (existing) return cardsFor(id, existing);
          const frames = await extractReferenceFrames(original, input.format, incoming);
          const commit = path.join(incoming, 'ready');
          await mkdir(commit, { mode: 0o700 });
          await Promise.all(frames.map(frame => rename(path.join(incoming, frame.file), path.join(commit, frame.file))));
          const source: Source = { name: input.name, frames: frames.map(frame => ({ ...frame, versions: [EMPTY] })) };
          await atomicWrite(path.join(commit, 'cards.json'), `${JSON.stringify(source)}\n`);
          await rename(commit, sourceDir(id));
          return cardsFor(id, source);
        });
      } finally {
        imports--;
        if (staging) await rm(staging, { recursive: true, force: true });
      }
    },
  };
}

export type ReferenceLibrary = ReturnType<typeof createReferenceLibrary>;
