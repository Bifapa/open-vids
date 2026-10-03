import { describe, expect, it } from "vitest";
import type { ProjectAsset, ProjectInventory } from "@hyperframes/agent-protocol";
import { formatError, formatInventory } from "./format.js";
import { EditingError } from "./host.js";

const asset = (overrides: Partial<ProjectAsset> = {}): ProjectAsset => ({
  path: "assets/music.mp3",
  kind: "audio",
  bytes: 6_000_000,
  duration: 182,
  width: null,
  height: null,
  hasAudio: null,
  ...overrides,
});

const inventoryOf = (assets: ProjectAsset[]): ProjectInventory => ({
  compositions: [],
  assets,
  renders: [],
});

describe("formatInventory", () => {
  it("marks the fragment the user picked, keeping the full length visible", () => {
    const text = formatInventory(inventoryOf([asset({ range: { start: 42, end: 75.5 } })]));
    expect(text).toContain(
      "- assets/music.mp3 · audio · 182 s · USER-PICKED FRAGMENT 42–75.5 s (33.5 s): use only this part",
    );
  });

  it("shows no fragment for an asset the user picked nothing of", () => {
    const text = formatInventory(
      inventoryOf([
        asset(),
        asset({
          path: "assets/talk.mp4",
          kind: "video",
          duration: 60,
          width: 1920,
          height: 1080,
          hasAudio: true,
        }),
      ]),
    );
    expect(text).not.toContain("USER-PICKED FRAGMENT");
    expect(text).toContain("- assets/music.mp3 · audio · 182 s");
    expect(text).toContain("- assets/talk.mp4 · video · 1920×1080 · 60 s · has audio");
  });

  it("keeps a fractional pick readable", () => {
    expect(formatInventory(inventoryOf([asset({ range: { start: 0.25, end: 3 } })]))).toContain(
      "USER-PICKED FRAGMENT 0.25–3 s (2.75 s): use only this part",
    );
  });
});

describe("formatError", () => {
  it("keeps a service out_of_bounds message unchanged, including the picked range", () => {
    const message =
      "The user picked 42–75.5 s of assets/music.mp3 for use; the clip would play 15.5 s past the end of the fragment.";
    expect(formatError(new EditingError("out_of_bounds", message, 2))).toBe(
      `out_of_bounds (operations[2]): ${message}`,
    );
  });
});
