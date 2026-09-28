import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { calibrationTag, expandSuite, parseCalibrationTag, repeatedSymptoms, suiteCost, validateCalibration, withLearnings, type CalibrationPack, type VerdictEntry } from '../../src/core/gen/calibration.ts';

const pack = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../packs/prompter/calibration.json'), 'utf8')) as CalibrationPack;
const suite = (id: string) => pack.suites.find((s) => s.id === id) ?? pack.suites[0]!;

describe('калибровка: наборы', () => {
  it('наборы целы: модели есть, параметры и промпты проходят проверку отправки', () => {
    expect(validateCalibration(pack)).toEqual([]);
  });

  it('кириллица: 3 случая × 4 модели; цена по провайдерам — 57 кр и $0.012', () => {
    expect(expandSuite(suite('cyrillic'))).toHaveLength(12);
    expect(suiteCost(suite('cyrillic'))).toEqual([
      { provider: 'kie', credits: 57, usd: 0.285, unitRu: 'кр' },
      { provider: 'higgsfield', credits: 0.012, usd: 0.012, unitRu: '$' },
    ]);
  });

  it('seed Soul 2: параметры случая поверх параметров модели — seed конкретный, формат и разрешение общие', () => {
    expect(expandSuite(suite('soul-seed')).map((j) => j.params.seed)).toEqual([4242, 4242, 777]);
    expect(expandSuite(suite('soul-seed'))[0]?.params).toMatchObject({ resolution: '720p', aspectRatio: '3:4' });
  });

  it('метка задачи разбирается обратно; чужие метки — null', () => {
    const tag = calibrationTag('mul1', 'cyrillic', 'short', 'soul');
    expect(parseCalibrationTag(tag)).toEqual({ runId: 'mul1', suiteId: 'cyrillic', caseId: 'short', modelKey: 'soul' });
    expect(parseCalibrationTag(null)).toBeNull();
    expect(parseCalibrationTag('x:y')).toBeNull();
  });
});

describe('калибровка: журнал → правила', () => {
  const v = (mediaId: string, symptoms: string[]): VerdictEntry => ({ mediaId, verdict: 'bad', symptoms, noteRu: '', at: '2026-09-28T00:00:00Z' });
  const model: Record<string, string> = { a: 'higgsfield/soul-2', b: 'higgsfield/soul-2', c: 'higgsfield/soul-2', d: 'kie/gpt-image-2-5', e: 'higgsfield/soul-2' };

  it('правило предлагается с третьего повтора одной ошибки у одной модели', () => {
    const repeats = repeatedSymptoms([v('a', ['text']), v('b', ['text', 'hands']), v('c', ['text']), v('d', ['text']), v('e', [])], (id) => model[id]);
    expect(repeats).toEqual([{ modelId: 'higgsfield/soul-2', symptom: 'text', count: 3, of: 4, mediaIds: ['a', 'b', 'c'] }]);
  });

  it('правила владельца дописываются в карточку модели с пометкой [owner]', () => {
    const card = withLearnings('# Soul 2 — card', [{ id: 'l1', modelId: 'higgsfield/soul-2', textRu: 'Русский текст ломает — надписи правкой GPT Image 2.5.', evidence: ['a', 'b', 'c'], at: '2026-09-28T10:00:00Z' }]);
    expect(card).toContain("## From the owner's own runs [owner]");
    expect(card).toContain('- Русский текст ломает — надписи правкой GPT Image 2.5. [owner, 2026-09-28, 3 runs]');
    expect(withLearnings('# card', [])).toBe('# card');
  });
});
