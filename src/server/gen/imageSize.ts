/**
 * Размер картинки по заголовку файла — PNG, JPEG, WebP, без нативных зависимостей. Нужен цене апскейла: Topaz
 * берёт деньги по размеру результата, а гейт цены обязан считать то же, что спишет провайдер.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (from: number, length: number): string => String.fromCharCode(...bytes.subarray(from, from + length));

  // PNG: подпись 8 байт, затем IHDR — ширина и высота big-endian.
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') return { width: view.getUint32(16), height: view.getUint32(20) };

  // JPEG: идём по маркерам до SOFn (кроме DHT C4, JPG C8, DAC CC) — там высота и ширина.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + view.getUint16(i + 2);
    }
    return null;
  }

  // WebP: RIFF…WEBP, затем VP8 (lossy), VP8L (lossless) или VP8X (extended).
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = view.getUint32(21, true);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: 1 + (view.getUint16(24, true) | ((bytes[26] ?? 0) << 16)), height: 1 + (view.getUint16(27, true) | ((bytes[29] ?? 0) << 16)) };
  }
  return null;
}
