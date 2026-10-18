import { describe, expect, it } from 'vitest';
import { CreateRunSchema, DEMO_INPUT } from '../../src/core/production/model.ts';
import { StoredRunSchema } from '../../src/core/production/persistence.ts';
import { newRun } from '../../src/core/production/engine.ts';
import { PHOTO_ASPECTS, PHOTO_RESOLUTIONS, photoOutput } from '../../src/core/production/output.ts';
import { PHOTO_MODEL, photoParams } from '../../src/core/production/photos.ts';
import { RETOUCH_MODEL, retouchParams } from '../../src/core/production/retouch.ts';
import { findModel, paramsFor } from '../../src/core/gen/models.ts';

describe('Production output formats', () => {
  it('uses the original 1080p portrait contract for saved series without settings', () => {
    const old = StoredRunSchema.parse(newRun('pr-old-format', DEMO_INPUT, 0, 1));
    expect(photoOutput(old)).toEqual({ resolution: '1080p', aspectRatio: '9:16' });
  });
  it('accepts only provider-supported formats and preserves both through persistence', () => {
    for (const resolution of PHOTO_RESOLUTIONS) for (const aspectRatio of PHOTO_ASPECTS) {
      const input = CreateRunSchema.parse({ ...DEMO_INPUT, resolution, aspectRatio });
      const saved = StoredRunSchema.parse(newRun('pr-format', input, 0, 1));
      expect(photoOutput(saved)).toEqual({ resolution, aspectRatio });
      expect(paramsFor(findModel(PHOTO_MODEL)!, photoParams(saved))).toMatchObject({ resolution, aspectRatio });
      expect(paramsFor(findModel(RETOUCH_MODEL)!, retouchParams(saved))).toMatchObject({ resolution: '2K', aspectRatio });
    }
    expect(CreateRunSchema.safeParse({ ...DEMO_INPUT, resolution: '4K' }).success).toBe(false);
    expect(CreateRunSchema.safeParse({ ...DEMO_INPUT, aspectRatio: '21:9' }).success).toBe(false);
  });
});
