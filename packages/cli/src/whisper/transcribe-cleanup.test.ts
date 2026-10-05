import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const whisperBinary = vi.hoisted(() => ({ path: "" }));

vi.mock("./manager.js", () => ({
  DEFAULT_MODEL: "small.en",
  hasFFmpeg: () => true,
  ensureWhisper: async () => ({ executablePath: whisperBinary.path, source: "env" }),
  ensureModel: async () => "/models/ggml-tiny.en.bin",
}));

import { transcribe } from "./transcribe.js";

const script = (path: string, body: string) => {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
};

describe.skipIf(process.platform === "win32")("transcribe temp WAV", () => {
  let dir: string;
  let savedFfmpeg: string | undefined;

  const leftovers = () =>
    readdirSync(tmpdir()).filter((f) => f.startsWith(`hyperframes-audio-${process.pid}-`));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-transcribe-cleanup-"));
    const ffmpeg = join(dir, "ffmpeg");
    script(ffmpeg, 'require("fs").writeFileSync(process.argv.at(-1), "wav");');
    savedFfmpeg = process.env.HYPERFRAMES_FFMPEG_PATH;
    process.env.HYPERFRAMES_FFMPEG_PATH = ffmpeg;
    whisperBinary.path = join(dir, "whisper-cli");
  });

  afterEach(() => {
    if (savedFfmpeg === undefined) delete process.env.HYPERFRAMES_FFMPEG_PATH;
    else process.env.HYPERFRAMES_FFMPEG_PATH = savedFfmpeg;
    rmSync(dir, { recursive: true, force: true });
  });

  const run = () =>
    transcribe(join(dir, "talk.mp3"), join(dir, "out"), { model: "tiny.en", language: "en" });

  it("removes the WAV when whisper fails", async () => {
    script(whisperBinary.path, "process.exit(1);");
    await expect(run()).rejects.toThrow(/Command failed/);
    expect(leftovers()).toEqual([]);
  });

  it("removes the WAV when whisper produces no output", async () => {
    script(whisperBinary.path, "process.exit(0);");
    await expect(run()).rejects.toThrow(/did not produce output/);
    expect(leftovers()).toEqual([]);
  });

  it("removes the WAV when the output is not valid JSON", async () => {
    script(
      whisperBinary.path,
      'require("fs").writeFileSync(process.argv[process.argv.indexOf("--output-file") + 1] + ".json", "{");',
    );
    await expect(run()).rejects.toThrow();
    expect(leftovers()).toEqual([]);
  });

  it("removes the WAV after a successful run", async () => {
    script(
      whisperBinary.path,
      'require("fs").writeFileSync(process.argv[process.argv.indexOf("--output-file") + 1] + ".json", JSON.stringify({ transcription: [] }));',
    );
    await expect(run()).resolves.toMatchObject({ wordCount: 0 });
    expect(leftovers()).toEqual([]);
  });
});
