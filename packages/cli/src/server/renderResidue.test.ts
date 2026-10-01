import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepRenderResidue } from "./renderResidue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sweepRenderResidue", () => {
  it("removes the scratch and staging dirs of a killed render and keeps finished renders", () => {
    const renders = mkdtempSync(join(tmpdir(), "hf-renders-"));
    dirs.push(renders);
    const scratch = "work-51a89e93-16f3-4816-a55c-abe4d1483bcf-uiMdMV";
    const staging = ".a_2026-10-01_02-56-43.hf-transaction-xJaDwD";
    mkdirSync(join(renders, scratch, "capture-attempt-0"), { recursive: true });
    writeFileSync(join(renders, scratch, "capture-attempt-0", "frame_000001.jpg"), "x");
    mkdirSync(join(renders, staging));
    writeFileSync(join(renders, "a_2026-10-01_02-55-58.mp4"), "video");
    writeFileSync(join(renders, "a_2026-10-01_02-55-58.meta.json"), "{}");
    mkdirSync(join(renders, "work-notes"));
    writeFileSync(join(renders, "work-file-abcdef"), "a file, not a scratch dir");

    expect(sweepRenderResidue(renders).sort()).toEqual([staging, scratch].sort());
    expect(existsSync(join(renders, scratch))).toBe(false);
    expect(existsSync(join(renders, staging))).toBe(false);
    expect(existsSync(join(renders, "a_2026-10-01_02-55-58.mp4"))).toBe(true);
    expect(existsSync(join(renders, "a_2026-10-01_02-55-58.meta.json"))).toBe(true);
    expect(existsSync(join(renders, "work-notes")), "a folder of the user's own stays").toBe(true);
    expect(existsSync(join(renders, "work-file-abcdef"))).toBe(true);
  });

  it("does nothing when the project has no renders folder", () => {
    expect(sweepRenderResidue(join(tmpdir(), "hf-no-such-renders-dir"))).toEqual([]);
  });
});
