// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_RANGES_PATH } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { effectiveRange, mediaBounds, readAssetRanges, writeAssetRanges } from "./assetRanges.js";

const roots: string[] = [];

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openvids-asset-ranges-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("asset range storage", () => {
  it("round-trips a map sorted by path and reads a missing, broken or partial file as no ranges", () => {
    const dir = projectDir();
    expect(readAssetRanges(dir).size).toBe(0);

    writeAssetRanges(
      dir,
      new Map([
        ["assets/music.mp3", { start: 10, end: 20 }],
        ["assets/a.mp4", { start: 1, end: 2 }],
      ]),
    );
    const stored = JSON.parse(readFileSync(join(dir, ASSET_RANGES_PATH), "utf-8"));
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.ranges)).toEqual(["assets/a.mp4", "assets/music.mp3"]);
    expect([...readAssetRanges(dir)]).toEqual([
      ["assets/a.mp4", { start: 1, end: 2 }],
      ["assets/music.mp3", { start: 10, end: 20 }],
    ]);

    writeFileSync(join(dir, ASSET_RANGES_PATH), "{");
    expect(readAssetRanges(dir).size).toBe(0);

    writeFileSync(
      join(dir, ASSET_RANGES_PATH),
      JSON.stringify({ version: 1, ranges: { "assets/a.mp4": { start: 1, end: 2 }, broken: 5 } }),
    );
    expect([...readAssetRanges(dir)]).toEqual([["assets/a.mp4", { start: 1, end: 2 }]]);
  });
});

describe("effectiveRange and mediaBounds", () => {
  it("clamps a range to a file that got shorter, and drops one with nothing left", () => {
    expect(effectiveRange({ start: 10, end: 20 }, 15)).toEqual({ start: 10, end: 15 });
    expect(effectiveRange({ start: 10, end: 20 }, 10.05)).toBeNull();
    // Not probed: the stored range stands as it is.
    expect(effectiveRange({ start: 10, end: 20 }, null)).toEqual({ start: 10, end: 20 });
    expect(effectiveRange(undefined, 15)).toBeNull();
  });

  it("bounds a placement by the pick when there is one, the whole file otherwise", () => {
    expect(mediaBounds({ start: 42, end: 75 }, 120)).toEqual({ start: 42, end: 75, picked: true });
    expect(mediaBounds(undefined, 120)).toEqual({ start: 0, end: 120, picked: false });
    expect(mediaBounds(undefined, null)).toEqual({ start: 0, end: null, picked: false });
    // A pick the file outgrew is clamped like the effective range is.
    expect(mediaBounds({ start: 42, end: 75 }, 50)).toEqual({ start: 42, end: 50, picked: true });
    expect(mediaBounds({ start: 42, end: 75 }, 20)).toEqual({ start: 0, end: 20, picked: false });
  });
});
