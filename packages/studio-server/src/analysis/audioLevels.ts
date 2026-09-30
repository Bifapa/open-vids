import { spawn } from "node:child_process";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { AnalysisFailure } from "./errors.js";
import { FrameMeter, LEVEL_FRAME_SECONDS, LEVEL_SAMPLE_RATE } from "./levels.js";

const ERROR_TAIL_CHARS = 600;
/** Only the tail of stderr is ever shown, so a chatty run does not grow memory. */
const MAX_STDERR_CHARS = 64 * 1024;

export interface AudioLevelOptions {
  signal: AbortSignal;
  ffmpegPath?: string;
  /** Media time (seconds) decoded so far. */
  onTime?: (seconds: number) => void;
}

export interface AudioLevels {
  frameSeconds: number;
  /** RMS dBFS of each consecutive frame of the first audio stream. */
  frameDb: number[];
}

/**
 * Decodes a file's audio once to mono 8 kHz s16le PCM on ffmpeg's stdout and reduces it to a loudness per 50 ms frame as
 * the bytes arrive; the PCM itself is never held. Aborting the signal kills ffmpeg before this rejects with `cancelled`;
 * a missing binary is `unavailable`, any other failure `failed` with the tail of ffmpeg's own message.
 */
export function measureAudioLevels(
  inputPath: string,
  options: AudioLevelOptions,
): Promise<AudioLevels> {
  const binary = options.ffmpegPath ?? findFfBinary("ffmpeg");
  if (!binary) {
    return Promise.reject(new AnalysisFailure("unavailable", "ffmpeg is not installed"));
  }
  const { signal } = options;
  if (signal.aborted) {
    return Promise.reject(new AnalysisFailure("cancelled", "Analysis was cancelled"));
  }
  return new Promise<AudioLevels>((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "-nostdin",
        "-nostats",
        "-hide_banner",
        "-i",
        inputPath,
        "-vn",
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        String(LEVEL_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const meter = new FrameMeter(LEVEL_SAMPLE_RATE, LEVEL_FRAME_SECONDS);
    let stderr = "";
    const onAbort = () => {
      child.kill("SIGKILL");
      reject(new AnalysisFailure("cancelled", "Analysis was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      meter.push(chunk);
      options.onTime?.(meter.sampleCount / LEVEL_SAMPLE_RATE);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      signal.removeEventListener("abort", onAbort);
      const code = error.code === "ENOENT" ? "unavailable" : "failed";
      reject(new AnalysisFailure(code, `ffmpeg could not start: ${error.message}`));
    });
    child.on("close", (code, killedBy) => {
      signal.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve({ frameSeconds: LEVEL_FRAME_SECONDS, frameDb: meter.finish() });
        return;
      }
      const tail = stderr.trim().slice(-ERROR_TAIL_CHARS);
      const how = killedBy ? `was killed by ${killedBy}` : `exited with code ${code}`;
      reject(new AnalysisFailure("failed", `ffmpeg ${how}: ${tail}`));
    });
  });
}
