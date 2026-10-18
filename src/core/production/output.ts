import { z } from 'zod';

export const PHOTO_RESOLUTIONS = ['720p', '1080p'] as const;
export const PHOTO_ASPECTS = ['9:16', '16:9', '1:1', '3:4', '4:3', '2:3', '3:2'] as const;
export const PhotoResolutionSchema = z.enum(PHOTO_RESOLUTIONS);
export const PhotoAspectSchema = z.enum(PHOTO_ASPECTS);
export interface PhotoOutput {
  resolution: z.infer<typeof PhotoResolutionSchema>;
  aspectRatio: z.infer<typeof PhotoAspectSchema>;
}
/** Missing settings on saved series retain the original generation contract. */
export function photoOutput(input: Partial<PhotoOutput>): PhotoOutput {
  return { resolution: input.resolution ?? '1080p', aspectRatio: input.aspectRatio ?? '9:16' };
}
