import { describe, expect, it } from 'vitest';
import { LogicReviewReportSchema, ReviewReportSchema, logicReviewed, logicReviewPassed, validateLogicReview, validateReview } from '../../src/core/production/review.ts';
import { RetouchAuditSchema, GeneratedRetouchAuditSchema, auditPassed, repairable, validateRetouchAudit } from '../../src/core/production/retouch.ts';
import { reviewReport } from './fixtures.ts';

const report = () => LogicReviewReportSchema.parse(reviewReport(['photo']));
const inspect = (value: ReturnType<typeof report>) => validateLogicReview(value, ['photo'], 2, true, ['photo']).results[0]!;

describe('clothing coverage and scene logic (labelled reports, not a vision benchmark)', () => {
  it.each(['fail', 'uncertain'] as const)('cannot pass a seated cafe portrait whose lower clothing is %s', value => {
    const input = report(); const result = input.results[0]!;
    result.wardrobeDetail.lowerBody = value;
    result.observations.find(o => o.check === 'wardrobe')!.evidence = value === 'fail'
      ? 'Внизу кадра видны оголённые бёдра; низ одежды отсутствует в обычной сцене кафе.'
      : 'На видимых бёдрах нельзя различить край шорт и отсутствие одежды.';
    const checked = inspect(input);
    expect(checked.verdict).toBe(value === 'fail' ? 'reject' : 'uncertain');
    expect(checked.checks.wardrobe).toBe(value);
    expect(checked.reason).toContain('бёдр');
    expect(logicReviewPassed(checked)).toBe(false);
  });
  it('does not invent missing trousers or shoes below a real crop or table occlusion', () => {
    const input = report(); const result = input.results[0]!;
    result.wardrobeDetail = { upperBody: 'pass', lowerBody: 'not_visible', footwear: 'not_visible' };
    result.observations.find(o => o.check === 'wardrobe')!.evidence = 'Верх одет; таз и ноги полностью закрыты столом, обувь вне кадра.';
    expect(logicReviewPassed(inspect(input))).toBe(true);
    result.wardrobeDetail.upperBody = 'not_visible';
    const closeup = inspect(input);
    expect(closeup.checks.wardrobe).toBe('not_visible'); expect(logicReviewPassed(closeup)).toBe(true);
  });
  it('accepts visibly complete contextual shorts without demanding long trousers', () => {
    const input = report();
    input.results[0]!.observations.find(o => o.check === 'wardrobe')!.evidence = 'Видны верх и цельные шорты с поясом и двумя штанинами; открытые колени соответствуют летней сцене.';
    expect(logicReviewPassed(inspect(input))).toBe(true);
  });
  it('rejects impossible support despite a positive face and overall verdict', () => {
    const input = report(); const result = input.results[0]!;
    result.checks.sceneLogic = 'fail';
    result.observations.find(o => o.check === 'sceneLogic')!.evidence = 'Стопы и сиденье видны, но тело проходит сквозь спинку стула.';
    const checked = inspect(input);
    expect(checked.verdict).toBe('reject'); expect(checked.reason).toContain('спинку');
    expect(logicReviewPassed(checked)).toBe(false);
  });
  it('requires separate evidence and refuses to label clothing failure an artistic variation', () => {
    const input = report(); input.results[0]!.observations.find(o => o.check === 'wardrobe')!.check = 'face';
    expect(() => inspect(input)).toThrow('одежду, логику');
    const variation = ReviewReportSchema.parse(reviewReport(['photo']));
    variation.results[0]!.checks.wardrobe = 'variation';
    expect(() => validateReview(variation, ['photo'], 2)).toThrow('отклонение');
  });
  it('rejects a labelled UGC/cinema mismatch without offering a local repaint', () => {
    const input = report(); const result = input.results[0]!;
    result.checks.visualInterest = 'fail';
    result.observations.find(o => o.check === 'visualInterest')!.evidence = 'Выбран cinema; видны селфи-перспектива и ровный бытовой свет без постановочного рисунка.';
    const checked = inspect(input);
    expect(checked.verdict).toBe('reject'); expect(checked.reason).toContain('cinema');
    expect(logicReviewPassed(checked)).toBe(false);
    const audit = validateRetouchAudit({ result, preserved: 'pass', fixes: [] }, 'photo', 2, true);
    expect(auditPassed(audit)).toBe(false); expect(repairable(audit)).toBe(false);
    result.observations = result.observations.filter(o => o.check !== 'visualInterest');
    expect(() => validateRetouchAudit({ result, preserved: 'pass', fixes: [] }, 'photo', 2, true)).toThrow('манеру съёмки');
  });
  it('reads a legacy keep but does not call its missing clothing/logic checks a recommendation', () => {
    const old = ReviewReportSchema.parse(reviewReport(['photo'])); const result = old.results[0]!;
    delete result.wardrobeDetail; delete result.checks.wardrobe; delete result.checks.sceneLogic;
    result.observations = result.observations.filter(o => o.check !== 'wardrobe' && o.check !== 'sceneLogic');
    expect(ReviewReportSchema.safeParse(old).success).toBe(true);
    expect(result.verdict).toBe('keep'); expect(logicReviewed(result)).toBe(false); expect(logicReviewPassed(result)).toBe(false);
    expect(LogicReviewReportSchema.safeParse(old).success).toBe(false);
    const savedAudit = RetouchAuditSchema.parse({ result, preserved: 'pass', fixes: [] });
    expect(GeneratedRetouchAuditSchema.safeParse(savedAudit).success).toBe(false);
    expect(auditPassed(savedAudit)).toBe(false);
  });
  it('repairs local missing clothing only with a bounded matching fix, then requires a clean audit', () => {
    const result = report().results[0]!; result.wardrobeDetail.lowerBody = 'fail';
    const audit = validateRetouchAudit({ result, preserved: 'pass', fixes: [{ check: 'wardrobe', box: { x1: 0, y1: 750, x2: 600, y2: 999 }, instructionEn: 'Add graphite trousers covering the visible hips and thighs while retaining the seated pose.', reason: 'Восстановить отсутствующий низ одежды.' }] }, 'photo', 2, true);
    expect(audit.result.verdict).toBe('reject'); expect(auditPassed(audit)).toBe(false); expect(repairable(audit)).toBe(true);
    expect(repairable({ ...audit, fixes: [] })).toBe(false);
    expect(() => validateRetouchAudit({ ...audit, fixes: [{ ...audit.fixes[0]!, box: { x1: 0, y1: 0, x2: 999, y2: 999 } }] }, 'photo', 2, true)).toThrow('Область');
    expect(auditPassed(validateRetouchAudit({ result: report().results[0]!, preserved: 'pass', fixes: [] }, 'photo', 2, true))).toBe(true);
  });
});
