import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ReferenceFolderSchema, type ReferenceCard, type ReferenceFolder, type ReferenceQualityAudit } from '../../core/references.ts';
import { atomicWrite, serialize } from '../storage/atomic.ts';
import { createReferenceAnalysis, ReferenceAnalysisSchema, ReferenceTagsSchema, type AnalysisResult, type ReferenceWork } from './analysis.ts';
import { extractReferenceFrames, referenceInput, ReferenceLibraryError, writeReferenceInput } from './media.ts';
import {
  REFERENCE_QUALITY_PROMPT_HASH, REFERENCE_QUALITY_VERSION, StoredReferenceQualitySchema, sha256,
  type QualityCohort, type QualityDecision, type QualityImage,
} from './quality.ts';
import {
  REFERENCE_DEDUP_METHOD, ReferenceDedupStateSchema, groupReferenceDuplicates, referenceFingerprints,
  type DedupInput, type DedupProgress, type ReferenceDedupState, type StoredDedupDecision,
} from './dedup.ts';

export { ReferenceLibraryError } from './media.ts';

const CARD_ID = /^rf-([a-f0-9]{64})-(0|[1-9]\d*)$/;
const SOURCE_ID = /^[a-f0-9]{64}$/;
const SCAN_VERSION = 2;
const SCAN_DIRECTORY = 'scan-v2';
const BindingSchema = z.object({ imageSha256: z.string(), reviewId: z.string() });
const CardVersionSchema = z.object({
  folder: ReferenceFolderSchema.nullable(),
  tags: ReferenceTagsSchema,
  analysis: ReferenceAnalysisSchema.nullable(),
  analysisBinding: BindingSchema.optional(),
});
const SourceSchema = z.object({
  name: z.string().min(1).max(160),
  scanVersion: z.literal(SCAN_VERSION).optional(),
  qualityCohort: z.object({
    id: z.string(), status: z.enum(['pending', 'complete']), imageDigest: z.string(),
    criteriaVersion: z.number().int(), promptHash: z.string(),
  }).optional(),
  frames: z.array(z.object({
    file: z.string().regex(/^(?:frame-(?:cover|\d+)|scan-v2\/frame-\d+)\.jpg$/),
    timeMs: z.number().int().nonnegative().nullable(),
    versions: z.array(CardVersionSchema).min(1),
    manualFolder: z.boolean().optional(),
    manualTags: z.boolean().optional(),
    quality: StoredReferenceQualitySchema.optional(),
  })).min(1),
}).refine(source => source.scanVersion === SCAN_VERSION || source.frames.every(frame => !frame.file.includes('/')));
type Source = z.infer<typeof SourceSchema>;
type CardVersion = z.infer<typeof CardVersionSchema>;
type Scope = 'eligible' | 'all';
interface SourceRecord { id: string; source: Source; hashes: (string | null)[]; dedup?: ReferenceDedupState | null; dedupPassValid?: boolean }

const EMPTY: CardVersion = { folder: null, tags: [], analysis: null };
const storedDedup = (record: SourceRecord, index: number) => {
  const quality = record.source.frames[index]?.quality;
  const decision = record.dedup?.frames[`rf-${record.id}-${index}`];
  const currentBytes = record.hashes[index] === decision?.imageSha256 || (record.hashes[index] === null && decision?.status === 'duplicate' &&
    decision.purged === true && decision.retainedBecauseReferenced !== true);
  return quality?.status === 'keep' && decision?.imageSha256 === quality.imageSha256 && decision.reviewId === quality.reviewId && currentBytes ? decision : undefined;
};
const imageDigest = (record: SourceRecord) => sha256(JSON.stringify(record.source.frames.map((frame, index) => ({
  file: frame.file, timeMs: frame.timeMs, imageSha256: frame.quality?.status === 'reject' || storedDedup(record, index)?.status === 'duplicate'
    ? frame.quality!.imageSha256 : record.hashes[index],
}))));
const recordDigest = (record: SourceRecord) => sha256(JSON.stringify({
  images: imageDigest(record), decisions: record.source.frames.map(frame => frame.quality?.reviewId ?? null),
}));
const currentPolicy = (value: { criteriaVersion: number; promptHash: string }) =>
  value.criteriaVersion === REFERENCE_QUALITY_VERSION && value.promptHash === REFERENCE_QUALITY_PROMPT_HASH;

function cardFor(record: SourceRecord, index: number, version?: number): ReferenceCard | undefined {
  const { id, source, hashes } = record;
  const frame = source.frames[index];
  if (!frame) return;
  const revision = version ?? frame.versions.length;
  const values = frame.versions[revision - 1];
  if (!values) return;
  const stored = frame.quality;
  const cohort = source.qualityCohort;
  const duplicate = storedDedup(record, index);
  const controlledDeletion = duplicate?.status === 'duplicate' && hashes[index] === null;
  const valid = stored && currentPolicy(stored) && (hashes[index] === stored.imageSha256 || controlledDeletion);
  const complete = cohort?.status === 'complete' && currentPolicy(cohort) && cohort.imageDigest === imageDigest(record);
  const quality: NonNullable<ReferenceCard['quality']> = stored?.status === 'reject'
    ? { status: 'reject', reason: stored.reason, duplicateOf: stored.duplicateOf, retainedBecauseReferenced: stored.retainedBecauseReferenced }
    : valid && (stored.status === 'uncertain' || complete)
      ? { status: stored.status, reason: stored.reason }
      : { status: 'pending', reason: hashes[index] === null ? 'Изображение недоступно. Кадр закрыт для использования.' : 'Кадр ожидает обязательной проверки качества.' };
  const dedup: ReferenceCard['dedup'] = quality.status === 'keep' || duplicate?.status === 'duplicate'
    ? duplicate?.status === 'duplicate' ? { status: 'duplicate', reason: duplicate.reason, duplicateOf: duplicate.duplicateOf,
      method: duplicate.method, retainedBecauseReferenced: duplicate.retainedBecauseReferenced }
      : duplicate?.status === 'keep' && record.dedupPassValid
        ? { status: 'keep', reason: duplicate.reason, method: duplicate.method }
        : { status: 'pending', reason: 'Кадр ожидает сравнения с похожими кадрами библиотеки.' }
    : undefined;
  const eligible = quality.status === 'keep' && dedup?.status === 'keep' && record.dedupPassValid && values.analysis !== null &&
    values.analysisBinding?.imageSha256 === stored?.imageSha256 && values.analysisBinding?.reviewId === stored?.reviewId;
  return {
    id: `rf-${id}-${index}`, sourceName: source.name, timeMs: frame.timeMs, version: revision,
    folder: values.folder, tags: values.tags, analysis: values.analysis, quality, eligible: !!eligible, dedup,
  };
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
  const dedupFile = path.join(root, 'dedup-state.json');
  let ready: Promise<void> | undefined;
  let loadingRecords: Promise<SourceRecord[]> | undefined;
  let imports = 0;

  function initialize() {
    return ready ??= (async () => {
      await mkdir(storeDir, { recursive: true, mode: 0o700 });
      const entries = await readdir(storeDir, { withFileTypes: true });
      await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith('.incoming-'))
        .map(entry => rm(path.join(storeDir, entry.name), { recursive: true, force: true })));
      for (const entry of entries.filter(entry => entry.isDirectory() && SOURCE_ID.test(entry.name))) {
        const source = await readSource(entry.name);
        if (source?.frames.some(frame => frame.quality?.status === 'reject')) await cleanupRejected(entry.name);
      }
      const temporary = await readdir(root, { withFileTypes: true });
      await Promise.all(temporary.filter(entry => entry.isDirectory() && entry.name.startsWith('.dedup-'))
        .map(entry => rm(path.join(root, entry.name), { recursive: true, force: true })));
      await cleanupDuplicates();
    })();
  }

  async function readSource(id: string): Promise<Source | undefined> {
    try { return SourceSchema.parse(JSON.parse(await readFile(manifestPath(id), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  async function readDedupState(): Promise<ReferenceDedupState | null> {
    try { return ReferenceDedupStateSchema.parse(JSON.parse(await readFile(dedupFile, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  async function recordFor(id: string, dedup?: ReferenceDedupState | null): Promise<SourceRecord | undefined> {
    const source = await readSource(id);
    if (!source) return;
    const hashes = await Promise.all(source.frames.map(async frame => {
      try { return sha256(await readFile(path.join(sourceDir(id), frame.file))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }));
    return { id, source, hashes, dedup: dedup === undefined ? await readDedupState() : dedup };
  }

  async function loadRecords() {
    await initialize();
    const state = await readDedupState();
    const ids = (await readdir(storeDir)).filter(name => SOURCE_ID.test(name)).sort();
    return (await Promise.all(ids.map(id => recordFor(id, state)))).filter((record): record is SourceRecord => record !== undefined);
  }

  const dedupDigest = (all: SourceRecord[]) => sha256(JSON.stringify(all.flatMap(record => record.source.frames.flatMap((frame, index) =>
    cardFor(record, index)?.quality?.status === 'keep' ? [{ id: `rf-${record.id}-${index}`, imageSha256: frame.quality!.imageSha256, reviewId: frame.quality!.reviewId }] : []))));

  async function records(fresh = false): Promise<SourceRecord[]> {
    const all = fresh ? await loadRecords() : await (loadingRecords ??= loadRecords().finally(() => { loadingRecords = undefined; }));
    const state = await readDedupState();
    const current = all.map(record => ({ ...record, dedup: state }));
    const valid = state?.inputDigest === dedupDigest(current);
    return current.map(record => ({ ...record, dedupPassValid: valid }));
  }

  const cardsFor = (record: SourceRecord) => record.source.frames.map((_, index) => cardFor(record, index)!);
  async function list(scope: Scope = 'eligible'): Promise<ReferenceCard[]> {
    return (await records()).flatMap(cardsFor).filter(card => scope === 'all' || card.eligible)
      .sort((a, b) => a.sourceName.localeCompare(b.sourceName, 'ru') || a.id.localeCompare(b.id, 'en', { numeric: true }));
  }

  async function get(id: string, version?: number, scope: Scope = 'eligible', fresh = false): Promise<ReferenceCard | undefined> {
    await initialize();
    const matches = CARD_ID.exec(id);
    if (!matches) return;
    const record = (await records(fresh)).find(record => record.id === matches[1]);
    const card = record && cardFor(record, Number(matches[2]), version);
    return card && (scope === 'all' || card.eligible) ? card : undefined;
  }

  async function imagePath(id: string, scope: Scope = 'eligible'): Promise<string | undefined> {
    const matches = CARD_ID.exec(id);
    if (!matches || !await get(id, undefined, scope)) return;
    const record = (await records()).find(record => record.id === matches[1]);
    const index = Number(matches[2]);
    return record?.hashes[index] ? path.join(sourceDir(matches[1]!), record.source.frames[index]!.file) : undefined;
  }

  async function readEligibleImage(id: string, version?: number) {
    await initialize();
    const matches = CARD_ID.exec(id);
    if (!matches) return;
    const record = (await records()).find(record => record.id === matches[1]);
    const index = Number(matches[2]);
    const card = record && cardFor(record, index, version);
    if (!record || !card?.eligible) return;
    const bytes = await readFile(path.join(sourceDir(record.id), record.source.frames[index]!.file));
    if (sha256(bytes) !== record.hashes[index]) return;
    const state = await readDedupState();
    if (!state || state.id !== record.dedup?.id || !state.inputDigest || state.inputDigest !== record.dedup.inputDigest) return;
    return { card, bytes };
  }

  async function update(id: string, change: (frame: Source['frames'][number], current: CardVersion) => CardVersion) {
    await initialize();
    const matches = CARD_ID.exec(id);
    if (!matches) return;
    const sourceId = matches[1]!;
    const index = Number(matches[2]);
    return serialize(manifestPath(sourceId), async () => {
      const source = await readSource(sourceId);
      const frame = source?.frames[index];
      if (!source || !frame) return;
      const current = frame.versions.at(-1)!;
      const next = change(frame, current);
      if (JSON.stringify(next) !== JSON.stringify(current)) frame.versions.push(next);
      await atomicWrite(manifestPath(sourceId), `${JSON.stringify(source)}\n`);
      return get(id, undefined, 'all', true);
    });
  }

  async function referencedIds(): Promise<Set<string> | null> {
    const ids = new Set<string>();
    const visit = async (dir: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && entry.name.endsWith('.json')) {
          const text = await readFile(file, 'utf8');
          JSON.parse(text);
          for (const match of text.matchAll(/rf-[a-f0-9]{64}-(?:0|[1-9]\d*)/g)) ids.add(match[0]);
        }
      }
    };
    try {
      await Promise.all([path.join(path.dirname(root), 'canvas'), path.join(path.dirname(root), 'canvas-ai'), path.join(root, 'chat')].map(visit));
      return ids;
    } catch { return null; }
  }

  async function cleanupRejected(sourceId: string) {
    const refs = await referencedIds();
    await serialize(manifestPath(sourceId), async () => {
      const source = await readSource(sourceId);
      if (!source) return;
      for (const [index, frame] of source.frames.entries()) {
        if (frame.quality?.status !== 'reject') continue;
        const retained = refs === null || refs.has(`rf-${sourceId}-${index}`);
        frame.quality.retainedBecauseReferenced = retained;
        if (!retained) await rm(path.join(sourceDir(sourceId), frame.file), { force: true });
      }
      await atomicWrite(manifestPath(sourceId), `${JSON.stringify(source)}\n`);
    });
  }

  async function invalidateDedup() {
    await serialize(dedupFile, async () => {
      const state = await readDedupState();
      if (state?.inputDigest) await atomicWrite(dedupFile, `${JSON.stringify({ ...state, inputDigest: '' })}\n`);
    });
  }

  async function cleanupDuplicates() {
    const refs = await referencedIds();
    await serialize(dedupFile, async () => {
      const state = await readDedupState();
      if (!state) return;
      let changed = false;
      const removals: { file: string; imageSha256: string }[] = [];
      const sources = new Map<string, Source | undefined>();
      const sourceFor = async (id: string) => {
        if (!sources.has(id)) sources.set(id, await readSource(id));
        return sources.get(id);
      };
      for (const [id, decision] of Object.entries(state.frames)) {
        if (decision.status !== 'duplicate' || !decision.duplicateOf) continue;
        const matches = CARD_ID.exec(id), target = CARD_ID.exec(decision.duplicateOf);
        if (!matches || !target || state.frames[decision.duplicateOf]?.status !== 'keep') continue;
        const frame = (await sourceFor(matches[1]!))?.frames[Number(matches[2])];
        const winner = (await sourceFor(target[1]!))?.frames[Number(target[2])];
        const winnerDecision = state.frames[decision.duplicateOf]!;
        if (!frame?.quality || frame.quality.reviewId !== decision.reviewId || frame.quality.imageSha256 !== decision.imageSha256 ||
            !winner?.quality || winner.quality.reviewId !== winnerDecision.reviewId || winner.quality.imageSha256 !== winnerDecision.imageSha256) continue;
        try {
          if (sha256(await readFile(path.join(sourceDir(target[1]!), winner.file))) !== winnerDecision.imageSha256) continue;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        try {
          if (sha256(await readFile(path.join(sourceDir(matches[1]!), frame.file))) !== decision.imageSha256) continue;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const retained = refs === null || refs.has(id);
        if (decision.retainedBecauseReferenced !== retained) { decision.retainedBecauseReferenced = retained; changed = true; }
        if (!retained) {
          if (!decision.purged) { decision.purged = true; changed = true; }
          removals.push({ file: path.join(sourceDir(matches[1]!), frame.file), imageSha256: decision.imageSha256 });
        }
      }
      if (changed) await atomicWrite(dedupFile, `${JSON.stringify(state)}\n`);
      for (const removal of removals) {
        try { if (sha256(await readFile(removal.file)) !== removal.imageSha256) continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rm(removal.file, { force: true });
      }
    });
  }

  async function curateDuplicates(signal: AbortSignal, onProgress: (progress: DedupProgress) => Promise<void> = async () => undefined) {
    await initialize();
    const result = await serialize(dedupFile, async () => {
      const all = await records(true);
      const prior = await readDedupState();
      const inputDigest = dedupDigest(all);
      const inputs: DedupInput[] = all.flatMap(record => record.source.frames.flatMap((frame, index) => {
        if (cardFor(record, index)?.quality?.status !== 'keep') return [];
        return [{ id: `rf-${record.id}-${index}`, imageSha256: frame.quality!.imageSha256,
          reviewId: frame.quality!.reviewId, imagePath: record.hashes[index] ? path.join(sourceDir(record.id), frame.file) : undefined,
          previous: storedDedup(record, index) }];
      }));
      signal.throwIfAborted();
      if (prior?.inputDigest === inputDigest && inputs.every(input => input.previous)) {
        await onProgress({ completed: inputs.length, total: inputs.length });
        signal.throwIfAborted();
        return { total: inputs.length, duplicateIds: inputs.filter(input => input.previous?.status === 'duplicate').map(input => input.id) };
      }
      if (prior?.inputDigest) await atomicWrite(dedupFile, `${JSON.stringify({ ...prior, inputDigest: '' })}\n`);
      const fingerprints = await referenceFingerprints(root, inputs, signal, onProgress);
      const groups = await groupReferenceDuplicates(fingerprints, signal);
      const frames: Record<string, StoredDedupDecision> = { ...prior?.frames };
      const at = new Date().toISOString();
      const duplicateIds: string[] = [];
      for (const group of groups) {
        const winner = group[0]!;
        for (const input of group) {
          const duplicate = input.id !== winner.id;
          if (duplicate) duplicateIds.push(input.id);
          frames[input.id] = { status: duplicate ? 'duplicate' : 'keep', imageSha256: input.imageSha256,
            reviewId: input.reviewId, fingerprint: input.fingerprint, duplicateOf: duplicate ? winner.id : undefined,
            method: REFERENCE_DEDUP_METHOD, at,
            purged: duplicate ? input.previous?.purged : undefined,
            retainedBecauseReferenced: duplicate ? input.previous?.retainedBecauseReferenced : undefined,
            reason: duplicate ? 'Очень похожий кадр: сохранён технически более удачный представитель по резкости и разрешению.'
              : 'Сохранён технический представитель самостоятельной композиции.' };
        }
      }
      signal.throwIfAborted();
      if (dedupDigest(await records(true)) !== inputDigest) throw new ReferenceLibraryError(409, 'Кадры изменились во время сравнения дублей. Повтори сравнение перед разбором.');
      signal.throwIfAborted();
      await atomicWrite(dedupFile, `${JSON.stringify({ id: randomUUID(), inputDigest, method: REFERENCE_DEDUP_METHOD, at, frames })}\n`);
      return { total: inputs.length, duplicateIds };
    });
    await cleanupDuplicates();
    return result;
  }

  async function qualityAudit(): Promise<ReferenceQualityAudit> {
    const all = await records();
    const cards = all.flatMap(cardsFor);
    const reasons = new Map<string, number>();
    const decisions = all.flatMap(record => record.source.frames.map((frame, index) => {
      const card = cardFor(record, index)!;
      const quality = card.quality!;
      reasons.set(quality.reason, (reasons.get(quality.reason) ?? 0) + 1);
      return {
        id: card.id, sourceName: card.sourceName, timeMs: card.timeMs, ...quality,
        criteriaVersion: frame.quality?.criteriaVersion, imageSha256: frame.quality?.imageSha256,
        promptHash: frame.quality?.promptHash, model: frame.quality?.model, at: frame.quality?.at,
        dedup: card.dedup,
      };
    }));
    const count = (status: NonNullable<ReferenceCard['quality']>['status']) => cards.filter(card => card.quality?.status === status).length;
    return {
      total: cards.length, pending: count('pending'), kept: count('keep'), rejected: count('reject'), uncertain: count('uncertain'),
      analyzed: cards.filter(card => card.analysis !== null).length, eligible: cards.filter(card => card.eligible).length,
      retainedReferenced: cards.filter(card => card.quality?.retainedBecauseReferenced || card.dedup?.retainedBecauseReferenced).length,
      pendingWork: cards.filter(card => card.dedup?.status !== 'duplicate' && (card.quality?.status === 'pending' || (card.quality?.status === 'keep' && !card.eligible))).length,
      scopeDigest: workScopeDigest(all),
      duplicates: cards.filter(card => card.dedup?.status === 'duplicate').length,
      dedupPending: cards.filter(card => card.dedup?.status === 'pending').length,
      reasons: [...reasons].map(([reason, count]) => ({ reason, count })), decisions,
    };
  }

  const imageFor = (record: SourceRecord, index: number): QualityImage => {
    const imageSha256 = record.hashes[index];
    if (!imageSha256) throw new ReferenceLibraryError(409, 'Кандидат недоступен. Обнови список и восстанови исходный кадр перед проверкой.');
    return { id: `rf-${record.id}-${index}`, imagePath: path.join(sourceDir(record.id), record.source.frames[index]!.file), imageSha256 };
  };

  const workScopeDigest = (all: SourceRecord[]) => sha256(JSON.stringify({
    dedupId: all[0]?.dedup?.id, dedupInput: all[0]?.dedup?.inputDigest,
    sources: all.map(record => ({ id: record.id, digest: recordDigest(record), versions: record.source.frames.map(frame => frame.versions.length) })),
  }));

  async function prepareWork(retryUncertain: boolean): Promise<ReferenceWork> {
    const all = await records();
    const cohorts: QualityCohort[] = [];
    const ids: string[] = [];
    for (const record of all) {
      const candidates: QualityImage[] = [];
      const anchors: QualityImage[] = [];
      for (const [index] of record.source.frames.entries()) {
        const card = cardFor(record, index)!;
        if (card.dedup?.status === 'duplicate') continue;
        const status = card.quality!.status;
        if (status === 'pending' || (retryUncertain && status === 'uncertain')) {
          candidates.push(imageFor(record, index)); ids.push(card.id);
        } else if (status === 'keep') {
          anchors.push(imageFor(record, index));
          if (!card.eligible) ids.push(card.id);
        }
      }
      if (candidates.length) cohorts.push({ sourceId: record.id, digest: recordDigest(record), candidates, anchors });
    }
    const scopeDigest = workScopeDigest(all);
    return { ids, cohorts, scopeDigest };
  }

  async function beginQuality(cohort: QualityCohort, signal: AbortSignal): Promise<string> {
    await invalidateDedup();
    return serialize(manifestPath(cohort.sourceId), async () => {
      const record = await recordFor(cohort.sourceId);
      signal.throwIfAborted();
      if (!record || recordDigest(record) !== cohort.digest) throw new ReferenceLibraryError(409, 'Источник изменился после подтверждения. Повтори проверку списка.');
      const id = randomUUID();
      record.source.qualityCohort = { id, status: 'pending', imageDigest: imageDigest(record), criteriaVersion: REFERENCE_QUALITY_VERSION, promptHash: REFERENCE_QUALITY_PROMPT_HASH };
      await atomicWrite(manifestPath(cohort.sourceId), `${JSON.stringify(record.source)}\n`);
      return id;
    });
  }

  async function saveQuality(cohort: QualityCohort, reviewId: string, decisions: QualityDecision[], model: string, signal: AbortSignal) {
    await invalidateDedup();
    await serialize(manifestPath(cohort.sourceId), async () => {
      const record = await recordFor(cohort.sourceId);
      signal.throwIfAborted();
      if (!record || recordDigest(record) !== cohort.digest || record.source.qualityCohort?.id !== reviewId) {
        throw new ReferenceLibraryError(409, 'Кадры изменились во время проверки. Ответ не применён.');
      }
      const inputs = new Map(cohort.candidates.map(frame => [frame.id, frame]));
      for (const decision of decisions) {
        const input = inputs.get(decision.id)!;
        const index = Number(CARD_ID.exec(decision.id)![2]);
        record.source.frames[index]!.quality = {
          status: decision.status, reasonCode: decision.reasonCode, reason: decision.reason,
          duplicateOf: decision.duplicateOf ?? undefined, reviewId, imageSha256: input.imageSha256,
          criteriaVersion: REFERENCE_QUALITY_VERSION, promptHash: REFERENCE_QUALITY_PROMPT_HASH, model, at: new Date().toISOString(),
        };
      }
      record.source.qualityCohort = { ...record.source.qualityCohort!, status: 'complete', imageDigest: imageDigest(record) };
      signal.throwIfAborted();
      await atomicWrite(manifestPath(cohort.sourceId), `${JSON.stringify(record.source)}\n`);
    });
    await cleanupRejected(cohort.sourceId);
  }

  async function analysisInputs(ids: string[]) {
    const result: (QualityImage & { reviewId: string })[] = [];
    const all = await records();
    for (const id of ids) {
      const matches = CARD_ID.exec(id)!;
      const record = all.find(record => record.id === matches[1]);
      const index = Number(matches[2]);
      const card = record && cardFor(record, index);
      if (card?.dedup?.status === 'duplicate') continue;
      if (!record || !card || card.quality?.status === 'pending') {
        throw new ReferenceLibraryError(409, 'Кадры изменились после проверки качества. Обнови список и повтори незавершённый этап.');
      }
      if (record && card?.quality?.status === 'keep' && !card.eligible) {
        if (!record.dedupPassValid || card.dedup?.status !== 'keep') throw new ReferenceLibraryError(409, 'Сначала заверши сравнение похожих кадров.');
        result.push({ ...imageFor(record, index), reviewId: record.source.frames[index]!.quality!.reviewId });
      }
    }
    return result;
  }

  async function saveAnalysis(result: AnalysisResult, input: QualityImage & { reviewId: string }, signal: AbortSignal) {
    const matches = CARD_ID.exec(result.id)!;
    await serialize(manifestPath(matches[1]!), async () => {
      const record = await recordFor(matches[1]!);
      const context = await records();
      if (record) {
        record.dedup = context[0]?.dedup;
        record.dedupPassValid = record.dedup?.inputDigest === dedupDigest(context.map(item => item.id === record.id ? record : item));
      }
      const index = Number(matches[2]);
      const card = record && cardFor(record, index);
      const frame = record?.source.frames[index];
      signal.throwIfAborted();
      if (!record || !frame || card?.quality?.status !== 'keep' || card.dedup?.status !== 'keep' || !record.dedupPassValid || record.hashes[index] !== input.imageSha256 || frame.quality?.reviewId !== input.reviewId) {
        throw new ReferenceLibraryError(409, 'Кадр изменился после проверки качества. Разбор не сохранён.');
      }
      const current = frame.versions.at(-1)!;
      frame.versions.push({
        folder: frame.manualFolder ? current.folder : result.folder,
        tags: frame.manualTags ? current.tags : distinctTags(result.tags),
        analysis: result.analysis, analysisBinding: { imageSha256: input.imageSha256, reviewId: input.reviewId },
      });
      await atomicWrite(manifestPath(record.id), `${JSON.stringify(record.source)}\n`);
    });
  }

  async function extendVideo(id: string, existing: Source, extracted: Awaited<ReturnType<typeof extractReferenceFrames>>, incoming: string) {
    const seen = new Set(existing.frames.map(frame => frame.timeMs));
    const additions = extracted.flatMap(frame => {
      if (frame.timeMs === null || seen.has(frame.timeMs)) return [];
      seen.add(frame.timeMs);
      return [{ ...frame, filename: `frame-${frame.timeMs}.jpg` }];
    });
    const destination = path.join(sourceDir(id), SCAN_DIRECTORY);
    await rm(destination, { recursive: true, force: true });
    if (additions.length > 0) {
      const prepared = path.join(incoming, SCAN_DIRECTORY);
      await mkdir(prepared, { mode: 0o700 });
      await Promise.all(additions.map(frame => rename(path.join(incoming, frame.file), path.join(prepared, frame.filename))));
      await rename(prepared, destination);
    }
    const source: Source = {
      ...existing, qualityCohort: undefined, scanVersion: SCAN_VERSION,
      frames: [...existing.frames, ...additions.map(({ filename, timeMs }) => ({
        file: `${SCAN_DIRECTORY}/${filename}`, timeMs, versions: [EMPTY],
      }))],
    };
    await atomicWrite(manifestPath(id), `${JSON.stringify(source)}\n`);
    return source;
  }

  const analysis = createReferenceAnalysis(root, { prepareWork, beginQuality, saveQuality, curateDuplicates, analysisInputs, saveAnalysis });

  return {
    ...analysis, list, get, imagePath, readEligibleImage, qualityAudit, curateDuplicates,
    edit(id: string, change: { folder?: ReferenceFolder | null; tags?: string[] }) {
      return update(id, (frame, current) => {
        if (change.folder !== undefined) frame.manualFolder = true;
        if (change.tags !== undefined) frame.manualTags = true;
        return { ...current, folder: change.folder === undefined ? current.folder : change.folder, tags: change.tags === undefined ? current.tags : distinctTags(change.tags) };
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
        const prior = await readSource(id);
        if (prior && prior.scanVersion !== SCAN_VERSION && prior.frames.some(frame => frame.timeMs !== null)) await invalidateDedup();
        return await serialize(manifestPath(id), async () => {
          const existing = await readSource(id);
          if (existing && (existing.scanVersion === SCAN_VERSION || existing.frames.every(frame => frame.timeMs === null))) {
            return cardsFor((await records(true)).find(record => record.id === id)!);
          }
          const frames = await extractReferenceFrames(original, input.format, incoming);
          if (existing) await extendVideo(id, existing, frames, incoming);
          else {
            const commit = path.join(incoming, 'ready');
            await mkdir(commit, { mode: 0o700 });
            await Promise.all(frames.map(frame => rename(path.join(incoming, frame.file), path.join(commit, frame.file))));
            const source: Source = { name: input.name, scanVersion: SCAN_VERSION, frames: frames.map(frame => ({ ...frame, versions: [EMPTY] })) };
            await atomicWrite(path.join(commit, 'cards.json'), `${JSON.stringify(source)}\n`);
            await rename(commit, sourceDir(id));
          }
          return cardsFor((await records(true)).find(record => record.id === id)!);
        });
      } finally {
        imports--;
        if (staging) await rm(staging, { recursive: true, force: true });
      }
    },
  };
}

export type ReferenceLibrary = ReturnType<typeof createReferenceLibrary>;
