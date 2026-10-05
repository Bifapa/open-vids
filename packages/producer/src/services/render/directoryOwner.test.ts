import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RENDER_OWNER_MARKER, sweepStaleRenderScratch } from "./directoryOwner.js";

const MINUTE = 60_000;

describe("sweepStaleRenderScratch", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hf-sweep-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function scratch(name: string, owner?: { pid: number; host?: string; ageMs?: number }): string {
    const dir = join(tempDir, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "frame_000001.jpg"), "x");
    if (owner) {
      const marker = join(dir, RENDER_OWNER_MARKER);
      writeFileSync(
        marker,
        JSON.stringify({ pid: owner.pid, host: owner.host ?? hostname(), startedAt: 0 }),
      );
      const beat = new Date(Date.now() - (owner.ageMs ?? 0));
      utimesSync(marker, beat, beat);
    }
    return dir;
  }

  /** The pid of a process that has already exited. */
  function deadPid(): number {
    const result = spawnSync(process.execPath, ["-e", ""]);
    if (result.pid === undefined) throw new Error("could not spawn a throwaway process");
    return result.pid;
  }

  it("removes the scratch dir of a render whose owner process is gone", () => {
    const dir = scratch("hf-render-AbC123", { pid: deadPid() });

    expect(sweepStaleRenderScratch(tempDir)).toEqual(["hf-render-AbC123"]);
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps the scratch dir of a render that is still alive", () => {
    const dir = scratch("hf-render-Live01", { pid: process.pid });

    expect(sweepStaleRenderScratch(tempDir)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("removes a dir whose heartbeat stopped, even when its pid was recycled by a live process", () => {
    scratch("hf-render-Stale1", { pid: process.pid, ageMs: 10 * MINUTE });

    expect(sweepStaleRenderScratch(tempDir)).toEqual(["hf-render-Stale1"]);
  });

  it("never judges a render owned by another host by its pid", () => {
    const dir = scratch("hf-render-Other1", { pid: deadPid(), host: "some-other-host" });

    expect(sweepStaleRenderScratch(tempDir)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("leaves a fresh unmarked dir alone and removes an old one", () => {
    const fresh = scratch("hf-render-Fresh1");
    const old = scratch("hf-render-Old001");
    const twoHoursAgo = new Date(Date.now() - 120 * MINUTE);
    utimesSync(old, twoHoursAgo, twoHoursAgo);

    expect(sweepStaleRenderScratch(tempDir)).toEqual(["hf-render-Old001"]);
    expect(existsSync(fresh)).toBe(true);
  });

  it("ignores entries that do not have the shape of a render scratch dir", () => {
    scratch("hf-render-mode-abc123", { pid: deadPid() });
    scratch("work-folder", { pid: deadPid() });
    writeFileSync(join(tempDir, "hf-render-File01"), "not a directory");

    expect(sweepStaleRenderScratch(tempDir)).toEqual([]);
    expect(readdirSync(tempDir).sort()).toEqual([
      "hf-render-File01",
      "hf-render-mode-abc123",
      "work-folder",
    ]);
  });

  it("returns nothing for a missing temp dir", () => {
    expect(sweepStaleRenderScratch(join(tempDir, "does-not-exist"))).toEqual([]);
  });
});
