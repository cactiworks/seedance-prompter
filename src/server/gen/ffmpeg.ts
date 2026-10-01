import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Запуск ffmpeg с аргументами; бросает с русским сообщением. В тестах подменяется через AppOptions.ffmpeg. */
export type FfmpegRunner = (args: string[]) => Promise<void>;

// ffmpeg — внешний бинарь (Homebrew), не npm-зависимость: правило «без нативных зависимостей» не нарушается.
const CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

export const runFfmpeg: FfmpegRunner = (args) =>
  new Promise((resolve, reject) => {
    const bin = CANDIDATES.find((p) => existsSync(p)) ?? 'ffmpeg';
    execFile(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error === null) resolve();
      else if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new Error('ffmpeg не найден — поставь: brew install ffmpeg.'));
      else reject(new Error(`ffmpeg: ${String(stderr).trim().split('\n').at(-1) ?? error.message}`));
    });
  });

/** Обрезка картинки: доли 0…1 от ширины и высоты исходника — ffmpeg сам знает размер (iw / ih). */
export const cropArgs = (input: string, output: string, box: { x: number; y: number; w: number; h: number }): string[] => [
  '-i',
  input,
  '-vf',
  `crop=trunc(iw*${box.w}):trunc(ih*${box.h}):trunc(iw*${box.x}):trunc(ih*${box.y})`,
  '-frames:v',
  '1',
  '-update',
  '1',
  output,
];

/**
 * Обрезка видео по времени: перекодирование (не -c copy), чтобы рез был точно по кадру, а не по ближайшему ключевому.
 * `end` 0 — до конца. Звука может не быть — aac тогда просто не нужен, ffmpeg это переживает.
 */
export const trimArgs = (input: string, output: string, start: number, end: number): string[] => [
  '-i',
  input,
  '-ss',
  start.toFixed(2),
  ...(end > 0 ? ['-to', end.toFixed(2)] : []),
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-movflags',
  '+faststart',
  output,
];

/**
 * Под размер площадки: cover — заполнить и обрезать края, contain — вписать целиком с чёрными полями. Видео — H.264
 * (стороны чётные — их делает сервер), картинка — PNG.
 */
export const resizeArgs = (input: string, output: string, width: number, height: number, fit: 'cover' | 'contain', video: boolean): string[] => {
  const vf =
    fit === 'cover'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  return video
    ? ['-i', input, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output]
    : ['-i', input, '-vf', vf, '-frames:v', '1', '-update', '1', output];
};

/** Аргументы для одного кадра: первый — с начала, последний — за 0.1 с до конца (-sseof). */
export const frameArgs = (input: string, output: string, which: 'first' | 'last'): string[] => [...(which === 'last' ? ['-sseof', '-0.1'] : []), '-i', input, '-frames:v', '1', '-update', '1', output];
