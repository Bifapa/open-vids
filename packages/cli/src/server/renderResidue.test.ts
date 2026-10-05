import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepRenderResidue } from "./renderResidue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MARKER = ".hf-owner.json";
const HOUR = 60 * 60_000;

function rendersDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-renders-"));
  dirs.push(dir);
  return dir;
}

/** A scratch dir whose owner marker names `pid` on this host and was last touched `ageMs` ago. */
function owned(renders: string, name: string, pid: number, ageMs: number): string {
  const dir = join(renders, name);
  mkdirSync(join(dir, "capture-attempt-0"), { recursive: true });
  writeFileSync(join(dir, "capture-attempt-0", "frame_000001.jpg"), "x");
  const marker = join(dir, MARKER);
  writeFileSync(marker, JSON.stringify({ pid, host: hostname(), startedAt: Date.now() }));
  const beat = new Date(Date.now() - ageMs);
  utimesSync(marker, beat, beat);
  return dir;
}

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  return pid;
}

const SCRATCH = "work-51a89e93-16f3-4816-a55c-abe4d1483bcf-uiMdMV";
const STAGING = ".a_2026-10-01_02-56-43.hf-transaction-xJaDwD";

describe("sweepRenderResidue", () => {
  it("removes the scratch and staging dirs of a killed render and keeps finished renders", () => {
    const renders = rendersDir();
    owned(renders, SCRATCH, deadPid(), 1000);
    owned(renders, STAGING, deadPid(), 1000);
    writeFileSync(join(renders, "a_2026-10-01_02-55-58.mp4"), "video");
    writeFileSync(join(renders, "a_2026-10-01_02-55-58.meta.json"), "{}");
    mkdirSync(join(renders, "work-notes"));
    writeFileSync(join(renders, "work-file-abcdef"), "a file, not a scratch dir");

    expect(sweepRenderResidue(renders).sort()).toEqual([STAGING, SCRATCH].sort());
    expect(existsSync(join(renders, SCRATCH))).toBe(false);
    expect(existsSync(join(renders, STAGING))).toBe(false);
    expect(existsSync(join(renders, "a_2026-10-01_02-55-58.mp4"))).toBe(true);
    expect(existsSync(join(renders, "a_2026-10-01_02-55-58.meta.json"))).toBe(true);
    expect(existsSync(join(renders, "work-notes")), "a folder of the user's own stays").toBe(true);
    expect(existsSync(join(renders, "work-file-abcdef"))).toBe(true);
  });

  it("keeps user folders that merely look like a scratch dir", () => {
    const renders = rendersDir();
    const folders = [
      "work-old-drafts",
      "work-final-videos",
      "work-2024-backup",
      "work-client-review",
    ];
    for (const name of folders) {
      mkdirSync(join(renders, name));
      // Even long-untouched, with the right suffix length: only a job uuid makes a name the render's.
      const old = new Date(Date.now() - 24 * HOUR);
      utimesSync(join(renders, name), old, old);
    }

    expect(sweepRenderResidue(renders)).toEqual([]);
    for (const name of folders) expect(existsSync(join(renders, name)), name).toBe(true);
  });

  it("leaves the directories of a render that is still running", () => {
    const renders = rendersDir();
    // Another live process of this host (here: this one) that beat a moment ago.
    owned(renders, SCRATCH, process.pid, 5_000);
    owned(renders, STAGING, process.pid, 5_000);

    expect(sweepRenderResidue(renders)).toEqual([]);
    expect(existsSync(join(renders, SCRATCH, "capture-attempt-0", "frame_000001.jpg"))).toBe(true);
    expect(existsSync(join(renders, STAGING))).toBe(true);
  });

  it("does not trust a pid the OS may have recycled: a stale heartbeat means the render is gone", () => {
    const renders = rendersDir();
    owned(renders, SCRATCH, process.pid, HOUR);

    expect(sweepRenderResidue(renders)).toEqual([SCRATCH]);
  });

  it("leaves a render of another host to its heartbeat alone", () => {
    const renders = rendersDir();
    const fresh = owned(renders, SCRATCH, deadPid(), 5_000);
    writeFileSync(
      join(fresh, MARKER),
      JSON.stringify({ pid: deadPid(), host: "some-other-machine", startedAt: 1 }),
    );

    expect(sweepRenderResidue(renders)).toEqual([]);
  });

  it("leaves a directory without a marker while it is recent, and clears it once it is old", () => {
    const renders = rendersDir();
    mkdirSync(join(renders, SCRATCH, "capture-attempt-0"), { recursive: true });

    expect(sweepRenderResidue(renders)).toEqual([]);
    expect(sweepRenderResidue(renders, Date.now() + 2 * HOUR)).toEqual([SCRATCH]);
  });

  it("does nothing when the project has no renders folder", () => {
    expect(sweepRenderResidue(join(tmpdir(), "hf-no-such-renders-dir"))).toEqual([]);
  });
});
