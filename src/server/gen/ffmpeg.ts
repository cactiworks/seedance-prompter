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

/** Аргументы для одного кадра: первый — с начала, последний — за 0.1 с до конца (-sseof). */
export const frameArgs = (input: string, output: string, which: 'first' | 'last'): string[] => [...(which === 'last' ? ['-sseof', '-0.1'] : []), '-i', input, '-frames:v', '1', '-update', '1', output];
