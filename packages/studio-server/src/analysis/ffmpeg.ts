import { spawn } from "node:child_process";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { AnalysisFailure } from "./errors.js";

/** ffmpeg logs one line per event, not per frame, so a run's stderr stays small; past this something is wrong. */
const MAX_STDERR_CHARS = 32 * 1024 * 1024;
/** Tail kept for the error message of a failed run. */
const ERROR_TAIL_CHARS = 600;

export interface FfmpegOptions {
  signal: AbortSignal;
  /** Overrides the binary lookup (tests, configured installs). */
  ffmpegPath?: string;
  /** Called with the media time (seconds) the run has reached, from ffmpeg's `-progress` stream. */
  onTime?: (seconds: number) => void;
}

/**
 * Runs ffmpeg with the given arguments (the input and filters are the caller's) and resolves with its stderr, where the
 * detect filters log. Aborting the signal kills the process before this rejects with `cancelled`; a missing binary is
 * `unavailable`, any other failure `failed` with the tail of ffmpeg's own message.
 */
export function runFfmpeg(args: string[], options: FfmpegOptions): Promise<string> {
  const binary = options.ffmpegPath ?? findFfBinary("ffmpeg");
  if (!binary) {
    return Promise.reject(new AnalysisFailure("unavailable", "ffmpeg is not installed"));
  }
  const { signal } = options;
  if (signal.aborted) {
    return Promise.reject(new AnalysisFailure("cancelled", "Analysis was cancelled"));
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      binary,
      ["-nostdin", "-nostats", "-hide_banner", "-progress", "pipe:1", ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stderr = "";
    let overflow = false;
    let pending = "";
    const onAbort = () => {
      child.kill("SIGKILL");
      reject(new AnalysisFailure("cancelled", "Analysis was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > MAX_STDERR_CHARS) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match?.[1]) options.onTime?.(Number(match[1]) / 1_000_000);
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      signal.removeEventListener("abort", onAbort);
      const code = error.code === "ENOENT" ? "unavailable" : "failed";
      reject(new AnalysisFailure(code, `ffmpeg could not start: ${error.message}`));
    });
    child.on("close", (code, killedBy) => {
      signal.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve(stderr);
        return;
      }
      const tail = stderr.trim().slice(-ERROR_TAIL_CHARS);
      const how = killedBy ? `was killed by ${killedBy}` : `exited with code ${code}`;
      reject(
        new AnalysisFailure(
          "failed",
          overflow ? "ffmpeg produced too much output" : `ffmpeg ${how}: ${tail}`,
        ),
      );
    });
  });
}
