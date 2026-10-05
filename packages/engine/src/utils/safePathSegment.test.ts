import { describe, expect, it } from "vitest";
import { safeIdPathName, safePathSegment } from "./safePathSegment.js";

describe("safePathSegment", () => {
  it("collapses everything outside [A-Za-z0-9_-] and appends the position", () => {
    expect(safePathSegment("../../x", 3)).toBe("______x-3");
    expect(safePathSegment("clip:1/a", 0)).toBe("clip_1_a-0");
  });

  it("keeps ids that sanitize alike on distinct names via the position", () => {
    expect(safePathSegment("bed/a", 0)).not.toBe(safePathSegment("bed?a", 1));
  });

  it("falls back to a readable placeholder for an empty id", () => {
    expect(safePathSegment("", 2, "group")).toBe("group-2");
    expect(safePathSegment("", 2)).toBe("item-2");
  });
});

describe("safeIdPathName", () => {
  it("returns an already-safe id unchanged so ordinary renders keep their layout", () => {
    expect(safeIdPathName("video_1-a")).toBe("video_1-a");
  });

  it.each(["../../escape", "a/b", "a:b", "..", ".", "", "C:\\x"])(
    "turns %j into a single path segment",
    (id) => {
      const name = safeIdPathName(id);
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(name).not.toBe(id);
    },
  );

  it("keeps distinct unsafe ids on distinct names", () => {
    expect(safeIdPathName("a/b")).not.toBe(safeIdPathName("a:b"));
    expect(safeIdPathName("a/b")).toBe(safeIdPathName("a/b"));
  });
});
