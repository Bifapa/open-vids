import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  WhisperUnavailableError,
  isWhisperUnavailable,
  sweepStaleModelPartials,
} from "./manager.js";

describe("isWhisperUnavailable", () => {
  it("recognizes WhisperUnavailableError instances", () => {
    const err = new WhisperUnavailableError(
      "whisper-cpp not found. Install: brew install whisper-cpp",
    );
    expect(isWhisperUnavailable(err)).toBe(true);
    expect(err.code).toBe("WHISPER_UNAVAILABLE");
    expect(err.name).toBe("WhisperUnavailableError");
  });

  it("recognizes a plain Error carrying the WHISPER_UNAVAILABLE code (cross-bundle safety)", () => {
    const err = Object.assign(new Error("nope"), { code: "WHISPER_UNAVAILABLE" });
    expect(isWhisperUnavailable(err)).toBe(true);
  });

  it("does NOT classify a genuine transcription failure as unavailable", () => {
    // whisper present but the run crashed — must stay a real command failure.
    expect(isWhisperUnavailable(new Error("Command failed: whisper-cli exited with code 1"))).toBe(
      false,
    );
    expect(isWhisperUnavailable(new Error("whisper-cpp build failed. Ensure cmake..."))).toBe(
      false,
    );
    expect(isWhisperUnavailable("whisper-cpp not found")).toBe(false);
    expect(isWhisperUnavailable(undefined)).toBe(false);
  });
});

describe("sweepStaleModelPartials", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const deadPid = () =>
    Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout);

  it("removes the partial of a dead downloader, keeps a live one's, and never touches models", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-model-partials-"));
    dirs.push(dir);
    const stale = `ggml-small.bin.${deadPid()}.${uuid}.tmp`;
    const live = `ggml-small.bin.${process.pid}.${uuid}.tmp`;
    for (const name of [stale, live, "ggml-small.bin", "ggml-base.en.bin.notes.tmp"]) {
      writeFileSync(join(dir, name), "x");
    }

    sweepStaleModelPartials(dir);

    expect(readdirSync(dir).sort()).toEqual(
      [live, "ggml-small.bin", "ggml-base.en.bin.notes.tmp"].sort(),
    );
  });

  it("removes a partial whose pid is alive but too old to be trusted (pid reuse)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-model-partials-"));
    dirs.push(dir);
    const old = `ggml-small.bin.${process.pid}.${uuid}.tmp`;
    writeFileSync(join(dir, old), "x");
    const longAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(join(dir, old), longAgo, longAgo);

    sweepStaleModelPartials(dir);

    expect(readdirSync(dir)).toEqual([]);
  });

  it("does nothing when the models directory does not exist", () => {
    expect(() => sweepStaleModelPartials(join(tmpdir(), "hf-no-such-models-dir"))).not.toThrow();
  });
});
