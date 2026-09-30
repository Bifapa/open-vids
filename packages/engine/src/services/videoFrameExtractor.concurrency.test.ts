import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as FfprobeModule from "../utils/ffprobe.js";
import type * as RunFfmpegModule from "../utils/runFfmpeg.js";
import { MAX_CONCURRENT_MEDIA_JOBS as MAX_CONCURRENT_EXTRACTIONS } from "../utils/slots.js";
import { extractVideoFramesRange } from "./videoFrameExtractor.js";

// Every extraction's ffmpeg is a controllable fake: it stays "running" until the test releases it, so the test can
// observe how many decode at once.
const ffmpeg = vi.hoisted(() => ({
  running: 0,
  peak: 0,
  release: [] as Array<() => void>,
}));

vi.mock("../utils/runFfmpeg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RunFfmpegModule>();
  const run = async () => {
    ffmpeg.running += 1;
    ffmpeg.peak = Math.max(ffmpeg.peak, ffmpeg.running);
    const { promise, resolve } = Promise.withResolvers<void>();
    ffmpeg.release.push(resolve);
    await promise;
    ffmpeg.running -= 1;
    return {
      success: false,
      exitCode: 1,
      stderr: "fake ffmpeg",
      durationMs: 1,
      terminationReason: "exited" as const,
    };
  };
  return { ...actual, runFfmpeg: vi.fn(run), runFfmpegPipeline: vi.fn(run) };
});

vi.mock("../utils/ffprobe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof FfprobeModule>();
  return {
    ...actual,
    extractMediaMetadata: vi.fn(async () => ({
      durationSeconds: 1500,
      videoStreamDurationSeconds: 1500,
      videoStreamStartSeconds: 0,
      width: 1920,
      height: 1080,
      fps: 25,
      videoCodec: "h264",
      hasAudio: true,
      isVFR: false,
      hasAlpha: false,
      colorSpace: null,
      pixelFormat: "yuv420p",
    })),
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  ffmpeg.running = 0;
  ffmpeg.peak = 0;
  ffmpeg.release.length = 0;
});

function outputDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-extract-limit-"));
  dirs.push(dir);
  return dir;
}

const running = (count: number) =>
  vi.waitFor(() => expect(ffmpeg.running).toBe(count), { interval: 1, timeout: 5_000 });

/** Finishes fake decodes one by one (as slots hand over) until every extraction settled. */
async function drain(all: Promise<unknown>): Promise<void> {
  let settled = false;
  void all.finally(() => {
    settled = true;
  });
  while (!settled) {
    await vi.waitFor(
      () => {
        if (!settled && ffmpeg.release.length === 0) throw new Error("no decode to finish yet");
      },
      { interval: 1, timeout: 5_000 },
    );
    ffmpeg.release.shift()?.();
  }
}

describe("extractVideoFramesRange concurrency", () => {
  it("decodes at most MAX_CONCURRENT_EXTRACTIONS ranges at once, however many clips a cut has", async () => {
    const dir = outputDir();
    const ranges = Array.from({ length: MAX_CONCURRENT_EXTRACTIONS * 4 + 3 }, (_, index) =>
      extractVideoFramesRange("/talk.mp4", `clip-${index}`, index * 6, 4, {
        fps: 25,
        outputDir: dir,
      }),
    );
    const all = Promise.allSettled(ranges);
    await running(MAX_CONCURRENT_EXTRACTIONS);

    await drain(all);
    expect(await all).toHaveLength(ranges.length);
    expect(ffmpeg.peak).toBe(MAX_CONCURRENT_EXTRACTIONS);
    expect(ffmpeg.running).toBe(0);
  });

  it("an extraction aborted while waiting leaves the queue without taking a slot", async () => {
    const dir = outputDir();
    const busy = Array.from({ length: MAX_CONCURRENT_EXTRACTIONS }, (_, index) =>
      extractVideoFramesRange("/talk.mp4", `busy-${index}`, index, 1, { fps: 25, outputDir: dir }),
    );
    await running(MAX_CONCURRENT_EXTRACTIONS);
    const controller = new AbortController();
    const waiting = extractVideoFramesRange(
      "/talk.mp4",
      "waiting",
      100,
      1,
      { fps: 25, outputDir: dir },
      controller.signal,
    );
    controller.abort();
    await expect(waiting).rejects.toThrow(/Cancelled/);

    await drain(Promise.allSettled(busy));
    expect(ffmpeg.peak).toBe(MAX_CONCURRENT_EXTRACTIONS);

    // Every slot came back: a new batch runs at full width again.
    const again = Array.from({ length: MAX_CONCURRENT_EXTRACTIONS }, (_, index) =>
      extractVideoFramesRange("/talk.mp4", `again-${index}`, index, 1, { fps: 25, outputDir: dir }),
    );
    await running(MAX_CONCURRENT_EXTRACTIONS);
    await drain(Promise.allSettled(again));
  });
});
