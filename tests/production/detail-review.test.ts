import { describe, expect, it } from 'vitest';
import { DetailedReviewReportSchema, ReviewReportSchema, validateDetailedReview, validateReview } from '../../src/core/production/review.ts';
import { reviewReport } from './fixtures.ts';

const fixture = () => DetailedReviewReportSchema.parse(reviewReport(['photo']));
const inspect = (report: ReturnType<typeof fixture>, faceExpected = ['photo']) => validateDetailedReview(report, ['photo'], 2, true, faceExpected).results[0]!;

describe('detail review decision boundaries (injected reports, no vision accuracy claim)', () => {
  it.each(['fail', 'uncertain'] as const)('cannot recommend an eye marked %s despite an overall positive verdict', status => {
    const report = fixture(); const result = report.results[0]!;
    result.faceDetail.leftEye = status;
    result.observations[0]!.evidence = 'Левый глаз смазан, контур века неразборчив.';
    const checked = inspect(report);
    expect(checked.verdict).toBe(status === 'fail' ? 'reject' : 'uncertain');
    expect(checked.checks.face).toBe(status); expect(checked.reason).toContain('Левый глаз');
  });
  it('requires evidence for every defect category rather than five repeated face comments', () => {
    const report = fixture(); report.results[0]!.observations[4]!.check = 'face';
    expect(() => inspect(report)).toThrow('области проверки');
  });
  it('does not pass an unreadable expected face, but accepts planned POV hands', () => {
    const report = fixture(); const result = report.results[0]!;
    result.faceDetail = { leftEye: 'not_visible', rightEye: 'not_visible', mouth: 'not_visible' };
    Object.assign(result.checks, { face: 'not_visible', likeness: 'not_visible', character: 'not_visible' });
    expect(inspect(report).verdict).toBe('uncertain'); expect(inspect(report).reason).toContain('не удалось проверить');
    expect(inspect(report, []).verdict).toBe('keep');
  });
  it('allows an occluded eye in profile without treating a smeared visible eye as occlusion', () => {
    const report = fixture(); report.results[0]!.faceDetail.rightEye = 'not_visible';
    expect(inspect(report).verdict).toBe('keep');
    report.results[0]!.faceDetail.leftEye = 'uncertain'; expect(inspect(report).verdict).toBe('uncertain');
  });
  it('keeps a useful warm portrait when invented light becomes a clothing stripe', () => {
    const report = fixture(); const result = report.results[0]!;
    result.checks.shotMatch = 'variation'; result.checks.visualInterest = 'variation';
    result.reason = 'Выразительный портрет в тёплой палитре; рисунок света отличается от замысла.';
    expect(inspect(report).verdict).toBe('keep');
  });
  it.each(['character', 'hands', 'identityLeakage', 'text'] as const)('does not let artistic variation excuse a %s defect', key => {
    const report = fixture(); report.results[0]!.checks.shotMatch = 'variation'; report.results[0]!.checks[key] = 'fail';
    expect(inspect(report).verdict).toBe('reject');
  });
  it('reads old reports without inventing detail evidence or silently re-evaluating them', () => {
    const report = ReviewReportSchema.parse(reviewReport(['photo'])); delete report.results[0]!.faceDetail;
    report.results[0]!.observations = [{ region: 'Кадр', evidence: 'Старое общее наблюдение.' }];
    expect(validateReview(report, ['photo'], 2).results[0]!.verdict).toBe('keep');
    expect(DetailedReviewReportSchema.safeParse(report).success).toBe(false);
  });
});
