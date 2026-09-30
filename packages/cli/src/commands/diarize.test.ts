import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliRuntimeError, consumeCommandResult } from "../utils/commandResult.js";
import { DiarizationUnavailableError } from "../whisper/diarize.js";

const diarize = vi.hoisted(() => ({
  unsupported: null as string | null,
  install: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../whisper/diarize.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../whisper/diarize.js")>()),
  diarizationUnsupportedReason: () => diarize.unsupported,
  installDiarization: diarize.install,
  diarizeWav: diarize.run,
}));
vi.mock("../whisper/sherpa.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../whisper/sherpa.js")>()),
  // The input is already "prepared": the command must clean up only files it made.
  prepareSherpaWav: (input: string) => input,
}));

import diarizeCmd from "./diarize.js";

let dir: string;
let input: string;

async function run(args: Record<string, unknown>) {
  let exitCode = 0;
  try {
    await diarizeCmd.run!({ args: { input, json: true, ...args } } as never);
  } catch (err) {
    if (!(err instanceof CliRuntimeError)) throw err;
    exitCode = err.result.exitCode;
  }
  exitCode ||= consumeCommandResult().exitCode;
  const out: Record<string, unknown> = JSON.parse(
    String(vi.mocked(console.log).mock.calls.at(-1)?.[0]),
  );
  return { exitCode, out };
}

describe("diarize --json", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-diarize-cmd-"));
    input = join(dir, "talk.wav");
    writeFileSync(input, "not-real-audio");
    consumeCommandResult();
    diarize.unsupported = null;
    diarize.install.mockReset().mockResolvedValue(false);
    diarize.run.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consumeCommandResult();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("prints the turns, the number of distinct speakers and the producer", async () => {
    const turns = [
      { speaker: 0, start: 0.8, end: 8 },
      { speaker: 1, start: 9, end: 14 },
      { speaker: 0, start: 15, end: 20 },
    ];
    diarize.run.mockResolvedValue(turns);
    const { exitCode, out } = await run({});
    expect(exitCode).toBe(0);
    expect(out).toEqual({
      ok: true,
      turns,
      speakerCount: 2,
      producer: expect.stringContaining("pyannote-segmentation-3.0"),
    });
    expect(diarize.run.mock.calls[0]![1]).toMatchObject({ speakers: undefined });
  });

  it("hands --speakers to the diarizer as a number", async () => {
    diarize.run.mockResolvedValue([]);
    await run({ speakers: "3" });
    expect(diarize.run.mock.calls[0]![1]).toMatchObject({ speakers: 3 });
  });

  it.each(["0", "two", "1.5", "33"])("rejects --speakers %s before doing any work", async (bad) => {
    const { exitCode, out } = await run({ speakers: bad });
    expect(exitCode).toBe(1);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("--speakers") });
    expect(diarize.install).not.toHaveBeenCalled();
  });

  it("reports an unsupported platform as skipped, with a non-zero exit and no install attempt", async () => {
    diarize.unsupported = "Speaker diarization runs on darwin-arm64; this system is freebsd-x64.";
    const { exitCode, out } = await run({});
    expect(exitCode).toBe(1);
    expect(out).toEqual({
      ok: false,
      skipped: true,
      reason: "diarization_unavailable",
      error: diarize.unsupported,
    });
    expect(diarize.install).not.toHaveBeenCalled();
  });

  it("reports an offline first run as skipped too", async () => {
    diarize.install.mockRejectedValue(
      new DiarizationUnavailableError("the download failed: ENOTFOUND"),
    );
    const { exitCode, out } = await run({});
    expect(exitCode).toBe(1);
    expect(out).toMatchObject({ ok: false, skipped: true, reason: "diarization_unavailable" });
    expect(diarize.run).not.toHaveBeenCalled();
  });

  it("reports a diarizer crash as a failure, not as skipped", async () => {
    diarize.run.mockRejectedValue(new Error("Speaker diarizer crashed (SIGABRT)"));
    const { exitCode, out } = await run({});
    expect(exitCode).toBe(1);
    expect(out).toEqual({ ok: false, error: "Speaker diarizer crashed (SIGABRT)" });
  });

  it("fails clearly on a missing input", async () => {
    const { exitCode, out } = await run({ input: join(dir, "missing.wav") });
    expect(exitCode).toBe(1);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("File not found") });
  });
});
