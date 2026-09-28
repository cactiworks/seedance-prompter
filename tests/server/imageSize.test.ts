import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { imageSize } from '../../src/server/gen/imageSize.ts';

/** Минимальный PNG нужного размера: подпись + IHDR — больше заголовка читателю не нужно. */
function png(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, deflateSync(Buffer.alloc(0))]));
}

/** JPEG: SOI, APP0 и SOF0 с высотой и шириной. */
function jpeg(width: number, height: number): Uint8Array {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]));
}

describe('размер картинки по заголовку', () => {
  it('PNG и JPEG; неизвестный формат — null', () => {
    expect(imageSize(png(1086, 1448))).toEqual({ width: 1086, height: 1448 });
    expect(imageSize(jpeg(2048, 1152))).toEqual({ width: 2048, height: 1152 });
    expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
