import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GenJob, MediaItem } from '../../src/core/model/media.ts';
import { awaitingFiles, mergeJobs, submissionIssue } from '../../src/core/gen/jobStatus.ts';
import { mediaVersions } from '../../src/core/gen/versions.ts';

const stamp = '2026-10-14T12:00:00.000Z';
const job = (patch: Partial<GenJob> = {}): GenJob => ({ id: 'j-feedback-123', createdAt: stamp, updatedAt: stamp, modelId: 'kie/seedream-5-pro', provider: 'kie', providerModel: 'test', kind: 'image', prompt: 'test', params: {}, refs: [], origin: null, sessionId: null, tag: null, estimateCredits: 14, estimateUsd: 0.07, status: 'queued', taskId: 'remote', providerState: null, creditsConsumed: null, resultUrls: [], mediaIds: [], error: null, polls: 0, pollingSince: null, nextCheckAt: 0, downloadAttempts: 0, finishedAt: null, ...patch });
const emptyLibrary = { items: [], favorites: [], folders: [] };
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('polling recovers after a network failure, retaining the last known job until fresh status arrives', async () => {
  const { useGen } = await import('../../src/web/gen/genStore.ts');
  useGen.setState({ jobs: [job()] });
  let offline = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (offline) throw new TypeError('offline');
    return Response.json(url === '/api/gen/jobs' ? [job({ status: 'saved', updatedAt: '2026-10-14T12:01:00.000Z' })] : emptyLibrary);
  }));
  const stop = useGen.getState().watchJobs();
  await useGen.getState().loadJobs();
  expect(useGen.getState().jobsError).toContain('последние');
  expect(useGen.getState().jobs[0]?.status).toBe('queued');
  offline = false;
  await vi.advanceTimersByTimeAsync(2000);
  expect(useGen.getState().jobs[0]?.status).toBe('saved');
  expect(useGen.getState().jobsError).toBeNull();
  expect(useGen.getState().jobsCheckedAt).not.toBeNull();
  stop();
});

it('idle observation finds a job started in another tab and refreshes files even after a failed library read', async () => {
  const { useGen } = await import('../../src/web/gen/genStore.ts');
  let jobs: GenJob[] = [];
  let failLibrary = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/gen/jobs') return Response.json(jobs);
    if (failLibrary) throw new Error('read failed');
    return Response.json(emptyLibrary);
  }));
  const stop = useGen.getState().watchJobs(); await useGen.getState().loadJobs();
  jobs = [job()]; await vi.advanceTimersByTimeAsync(10000);
  expect(useGen.getState().jobs).toHaveLength(1);
  jobs = [job({ status: 'saved', updatedAt: '2026-10-14T12:01:00.000Z' })]; failLibrary = true;
  await vi.advanceTimersByTimeAsync(2000);
  expect(useGen.getState().libraryError).not.toBeNull();
  failLibrary = false; await vi.advanceTimersByTimeAsync(2000);
  expect(useGen.getState().libraryError).toBeNull(); stop();
});

it('an old response cannot regress a newer status or drop jobs missing from the bounded history', () => {
  const saved = job({ status: 'saved', updatedAt: '2026-10-14T12:01:00.000Z' });
  expect(mergeJobs([saved, job({ id: 'j-old-123456' })], [job()])).toEqual([saved, job({ id: 'j-old-123456' })]);
});

it('unknown submission is not success and the request is never automatically repeated', async () => {
  const { useGen } = await import('../../src/web/gen/genStore.ts');
  let submissions = 0;
  const unknown = job({ status: 'unknown', error: { code: 'SUBMIT_UNKNOWN', messageRu: 'Исход неизвестен' } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { submissions += 1; return Response.json({ jobs: [unknown] }); }
    return Response.json(url === '/api/gen/jobs' ? [unknown] : emptyLibrary);
  }));
  const result = await useGen.getState().run({ modelId: unknown.modelId });
  expect(submissionIssue(result)).toBe('Исход неизвестен');
  expect(useGen.getState().submissionError).toBe('Исход неизвестен');
  expect(useGen.getState().submitting).toBe(0);
  await vi.advanceTimersByTimeAsync(20000);
  expect(submissions).toBe(1);
});

it('deleting a failed task cannot be undone by an in-flight list response', async () => {
  const { useGen } = await import('../../src/web/gen/genStore.ts');
  const failed = job({ status: 'failed' }); useGen.setState({ jobs: [failed] });
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return Response.json({ ok: true });
    if (url === '/api/gen/jobs') return new Promise<Response>((resolve) => { release = resolve; });
    return Response.json(emptyLibrary);
  }));
  const loading = useGen.getState().loadJobs();
  const removing = useGen.getState().deleteJob(failed.id);
  await vi.advanceTimersByTimeAsync(0);
  release(Response.json([failed])); await Promise.all([loading, removing]);
  expect(useGen.getState().jobs).toEqual([]);
});

it('a task removed in another tab leaves the attention count, while older saved history remains', async () => {
  const { useGen } = await import('../../src/web/gen/genStore.ts');
  const saved = job({ id: 'j-old-saved', status: 'saved' });
  useGen.setState({ jobs: [job({ status: 'failed' }), saved] });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/gen/jobs' ? [] : emptyLibrary)));
  await useGen.getState().loadJobs();
  expect(useGen.getState().jobs).toEqual([saved]);
});

it('a saved edit stays in task feedback until the library has its result metadata', () => {
  const source: MediaItem = { ...job(), id: 'source', jobId: 'j-source', file: 'source.png', mime: 'image/png', bytes: 10, sha256: 'test', index: 0, sourceUrl: '', savedAt: stamp };
  const edited = job({ status: 'saved', mediaIds: ['result'], refs: [{ label: 'edit', role: 'ref', source: { type: 'media', mediaId: source.id } }] });
  expect(awaitingFiles(edited, [source])).toBe(true);
  expect(mediaVersions(source, [source], [edited]).pending).toEqual([edited]);
  const result = { ...source, id: 'result', refs: edited.refs };
  expect(mediaVersions(source, [source, result], [edited]).pending).toEqual([]);
  expect(awaitingFiles({ ...edited, mediaIds: [null] }, [source])).toBe(false);
});

it('versions keep pending and failed edits of edits, but exclude unrelated source media', () => {
  const ref = (mediaId: string): GenJob['refs'] => [{ label: 'edit', role: 'ref', source: { type: 'media', mediaId } }];
  const media = (id: string, refs: GenJob['refs'] = []): MediaItem => ({ ...job(), id, refs, jobId: `j-${id}`, file: `${id}.png`, mime: 'image/png', bytes: 10, sha256: 'test', index: 0, sourceUrl: '', savedAt: stamp });
  const root = media('root'), first = media('first', ref('root')), second = media('second', ref('first'));
  const active = job({ refs: ref('second') });
  const failed = job({ id: 'j-failed-123', status: 'failed', refs: ref('first') });
  const unknown = job({ id: 'j-unknown-123', status: 'unknown', refs: ref('root') });
  const family = mediaVersions(second, [root, first, second, media('other')], [active, failed, unknown, job({ id: 'unrelated', refs: ref('other') })]);
  expect(family.done.map((m) => m.id)).toEqual(['root', 'first', 'second']);
  expect(family.pending.map((j) => j.id)).toEqual([active.id, failed.id, unknown.id]);
});
