import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceRun, applyRunAction, newRun } from '../../src/core/production/engine.ts';
import { DEMO_INPUT, type ProductionRun } from '../../src/core/production/model.ts';
import { pendingReview, ReviewReportSchema, reviewedPhoto, masterApproved } from '../../src/core/production/review.ts';
import { canAcceptReviewedPhoto } from '../../src/core/production/reviewDecisions.ts';
import { effectiveRetouchAudit, retouchPrompt, type RetouchAudit } from '../../src/core/production/retouch.ts';
import { StoredRunSchema } from '../../src/core/production/persistence.ts';
import { createProductionRuntime } from '../../src/server/production/runtime.ts';
import { productionRoutes } from '../../src/server/production/routes.ts';
import type { Characters } from '../../src/server/production/characters.ts';
import { reviewReport } from './fixtures.ts';

function ready(): ProductionRun {
  let run = newRun('pr-review-decisions', { ...DEMO_INPUT, scenario: 'normal' }, 0, 1);
  for (let n = 0; n < 20; n++) run = advanceRun(run, 1000 + n * 100, 1);
  run.mode = 'photos';
  run.photos = { status: 'review', identityId: null, masterArtifactId: null, requests: [], items: [] };
  for (const a of run.artifacts) { a.mediaId = `media-${a.id}`; a.qc = 'review'; }
  const ids = run.shots.map(s => s.photoId!);
  const report = ReviewReportSchema.parse(reviewReport(ids));
  for (const r of report.results) r.checks.likeness = 'not_applicable';
  report.results[0]!.checks.face = 'fail'; report.results[0]!.checks.text = 'uncertain'; report.results[0]!.verdict = 'reject';
  report.results[0]!.faceDetail!.leftEye = 'fail';
  run.review = { ...pendingReview(crypto.randomUUID(), 0), status: 'complete', artifactIds: ids, report };
  return run;
}
const dismiss = (run: ProductionRun, check: 'face' | 'text', dismissed = true) => applyRunAction(run, { type: 'setReviewDismissal', rev: run.rev, artifactId: run.shots[0]!.photoId!, check, dismissed }, 2000, 1);
const accept = (run: ProductionRun) => applyRunAction(run, { type: 'acceptReviewedPhoto', rev: run.rev, artifactId: run.shots[0]!.photoId! }, 2001, 1);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('owner decisions on critic findings', () => {
  it('dismisses one criterion, preserves the raw report, and keeps remaining issues blocking', () => {
    const original = ready(); const run = dismiss(original, 'face'); const id = run.shots[0]!.photoId!;
    expect(run.review).toEqual(original.review); expect(original.reviewDismissals).toBeUndefined();
    expect(reviewedPhoto(run, id)).toMatchObject({ verdict: 'uncertain', checks: { face: 'pass', text: 'uncertain' } });
    expect(canAcceptReviewedPhoto(run, id)).toBe(false); expect(() => accept(run)).toThrow('оставшиеся');
    expect(StoredRunSchema.parse(run).reviewDismissals).toHaveLength(1);
  });
  it('accepts explicitly after dismissals, then restores the finding and withdraws only this photo', () => {
    let run = dismiss(dismiss(ready(), 'face'), 'text'); const id = run.shots[0]!.photoId!;
    expect(run.shots[0]!.acceptedPhotoId).toBeNull(); expect(canAcceptReviewedPhoto(run, id)).toBe(true);
    run = accept(run); expect(run.shots[0]).toMatchObject({ acceptedPhotoId: id, step: 'ready' });
    expect(run.artifacts[0]!.qc).toBe('review'); expect(run.photos!.status).toBe('review');
    const approvals = structuredClone(run.approvals);
    run = dismiss(run, 'face', false);
    expect(run.shots[0]).toMatchObject({ acceptedPhotoId: null, step: 'photoReview' });
    expect(run.approvals).toEqual(approvals); expect(reviewedPhoto(run, id)!.verdict).toBe('reject');
  });
  it('keeps acceptance when a repeat review no longer reports the restored issue', () => {
    let run = accept(dismiss(dismiss(ready(), 'face'), 'text'));
    run.review!.report!.results[0]!.checks.text = 'pass';
    run = dismiss(run, 'text', false);
    expect(run.shots[0]!.acceptedPhotoId).toBe(run.shots[0]!.photoId);
  });
  it('rejects stale revisions, another version, and checks without a finding', () => {
    const run = ready(); const action = { type: 'setReviewDismissal' as const, rev: run.rev, artifactId: run.shots[0]!.photoId!, check: 'face' as const, dismissed: true };
    expect(() => applyRunAction(run, { ...action, rev: run.rev - 1 }, 0, 1)).toThrow('изменилась');
    expect(() => applyRunAction(run, { ...action, artifactId: 'old-version' }, 0, 1)).toThrow('текущей версии');
    expect(() => applyRunAction(run, { ...action, check: 'hands' }, 0, 1)).toThrow('нет замечания');
    expect(() => accept(run)).toThrow('оставшиеся');
  });
  it('does not transfer decisions to a new image version', () => {
    const run = dismiss(dismiss(ready(), 'face'), 'text'); const oldId = run.shots[0]!.photoId!;
    const newId = `${oldId}-v2`; run.shots[0]!.photoId = newId;
    run.artifacts.push({ ...run.artifacts[0]!, id: newId, sourceId: oldId, version: 2 });
    run.review!.artifactIds[0] = newId; run.review!.report!.results[0]!.artifactId = newId;
    expect(reviewedPhoto(run, newId)!.verdict).toBe('reject'); expect(canAcceptReviewedPhoto(run, newId)).toBe(false);
  });
  it('blocks in-flight work and unknown submissions, and permits local decisions on pause', () => {
    const run = ready(); run.photos!.status = 'running'; expect(() => dismiss(run, 'face')).toThrow('текущих задач');
    run.photos!.status = 'review'; run.review!.status = 'running'; expect(() => dismiss(run, 'face')).toThrow('текущих задач');
    run.review!.status = 'complete'; run.paused = true; expect(dismiss(run, 'face').paused).toBe(true);
    run.photos!.items.push({ key: 'shot-1', tag: 'fixture', jobId: 'job', taskId: null, status: 'unknown', mediaId: null, error: 'Unknown', errorCode: null });
    expect(() => dismiss(run, 'face')).toThrow('текущих задач');
  });
  it('allows an explicit master exception without starting or passing an incomplete report', () => {
    let run = ready(); const id = run.shots[0]!.photoId!;
    run.photos!.masterArtifactId = id; run.photos!.status = 'stopped';
    run.masterReview = { ...run.review!, appearanceRequestId: null, artifactIds: [id], report: { summary: 'Fixture', results: [run.review!.report!.results[0]!] } };
    expect(masterApproved(run)).toBe(false);
    run = dismiss(dismiss(run, 'face'), 'text'); expect(masterApproved(run)).toBe(true); expect(run.photos!.status).toBe('stopped');
    run.masterReview!.status = 'failed'; expect(masterApproved(run)).toBe(false);
  });
  it('removes only dismissed regions from the editor instructions', () => {
    const run = dismiss(ready(), 'face'); const result = run.review!.report!.results[0]!;
    const audit = { result, preserved: 'pass', fixes: ['face', 'text'].map(check => ({ check, box: { x1: 0, y1: 0, x2: 100, y2: 100 }, instructionEn: `Repair only the ${check} details`, reason: 'Test' })) } as RetouchAudit;
    const effective = effectiveRetouchAudit(run, audit);
    expect(effective.fixes.map(f => f.check)).toEqual(['text']);
    expect(retouchPrompt(effective)).not.toContain('Repair only the face');
    expect(audit.fixes).toHaveLength(2);
  });
  it('persists decisions through API/reload, includes them in manifest and never calls a provider', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'review-decisions-')); dirs.push(dir);
    const run = ready(); mkdirSync(path.join(dir, 'production-mock')); writeFileSync(path.join(dir, 'production-mock', `${run.id}.json`), JSON.stringify(run));
    const runLlm = vi.fn(); const rt = createProductionRuntime({ dataDir: dir, runLlm });
    const app = productionRoutes(rt, {} as Characters);
    const post = async (action: object) => app.request(`/${run.id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...action, rev: (await rt.get(run.id)).rev }) });
    const artifactId = run.shots[0]!.photoId!;
    for (const check of ['face', 'text']) expect((await post({ type: 'setReviewDismissal', artifactId, check, dismissed: true })).status).toBe(200);
    expect((await post({ type: 'acceptReviewedPhoto', artifactId })).status).toBe(200);
    const restored = await createProductionRuntime({ dataDir: dir, runLlm }).get(run.id);
    expect(restored.shots[0]!.acceptedPhotoId).toBe(artifactId); expect(restored.reviewDismissals).toHaveLength(2);
    const manifest = await (await app.request(`/${run.id}/manifest`)).json();
    expect(manifest.reviewDismissals).toHaveLength(2); expect(manifest.artifacts.map((a: { id: string }) => a.id)).toEqual([artifactId]);
    await rt.tick(); expect(runLlm).not.toHaveBeenCalled(); rt.stop();
  });
});
