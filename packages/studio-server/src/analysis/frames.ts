import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AnalysisFailure } from "./errors.js";
import { runFfmpeg } from "./ffmpeg.js";

/** Frame grabs decode from the middle of a file, so a handful at once is plenty; more only queue behind the disk. */
const MAX_CONCURRENT_GRABS = 3;

let running = 0;
const waiting: Array<() => void> = [];

async function acquire(signal: AbortSignal): Promise<void> {
  if (running < MAX_CONCURRENT_GRABS) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  if (signal.aborted) {
    release();
    throw new AnalysisFailure("cancelled", "Frame extraction was cancelled");
  }
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

export interface FrameGrab {
  /** Absolute path of the JPEG in the cache. */
  file: string;
  /** Served from disk; nothing was decoded. */
  cached: boolean;
}

/** Cache file of a frame: milliseconds of source time and pixel width (`frames/12500-512.jpg`). */
export function frameFile(framesDir: string, timeMs: number, width: number): string {
  return join(framesDir, `${timeMs}-${width}.jpg`);
}

/**
 * The JPEG of one source frame, from the cache when it is there. New frames are written to a temp file and moved into
 * place, so a killed grab never leaves a truncated image behind. At most three ffmpeg processes run at a time,
 * across every project.
 */
export async function grabFrame(options: {
  inputPath: string;
  framesDir: string;
  timeMs: number;
  width: number;
  signal: AbortSignal;
  ffmpegPath?: string;
}): Promise<FrameGrab> {
  const { inputPath, framesDir, timeMs, width, signal } = options;
  const file = frameFile(framesDir, timeMs, width);
  const existing = await stat(file).catch(() => null);
  if (existing?.isFile() && existing.size > 0) return { file, cached: true };

  await mkdir(framesDir, { recursive: true });
  await acquire(signal);
  const temp = join(framesDir, `${timeMs}-${width}.${randomUUID()}.tmp.jpg`);
  try {
    await runFfmpeg(
      [
        "-loglevel",
        "error",
        "-ss",
        (timeMs / 1000).toFixed(3),
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-vf",
        `scale=${width}:-2`,
        "-q:v",
        "4",
        "-y",
        temp,
      ],
      { signal, ffmpegPath: options.ffmpegPath },
    );
    const made = await stat(temp).catch(() => null);
    if (!made || made.size === 0) {
      throw new AnalysisFailure(
        "failed",
        `There is no picture at ${(timeMs / 1000).toFixed(3)} s (past the last frame?)`,
      );
    }
    await rename(temp, file);
    return { file, cached: false };
  } finally {
    await rm(temp, { force: true });
    release();
  }
}

export async function readFrameBase64(file: string): Promise<string> {
  return (await readFile(file)).toString("base64");
}
