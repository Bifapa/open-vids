import { describe, expect, it } from "vitest";
import {
  expandProjectParts,
  isProjectManifest,
  parseImportFromProjectRequest,
  parseManifestParts,
} from "./crossProject.js";

describe("expandProjectParts", () => {
  it("expands `all` to every file part and the story, in a fixed order", () => {
    expect(expandProjectParts(["all"])).toEqual([
      "renders",
      "music",
      "audio",
      "images",
      "video",
      "story",
    ]);
    expect(expandProjectParts(["story", "music", "renders"])).toEqual([
      "renders",
      "music",
      "story",
    ]);
  });
});

describe("parseManifestParts", () => {
  it("accepts a comma list of known parts and refuses anything else", () => {
    expect(parseManifestParts("renders, music")).toEqual(["renders", "music"]);
    expect(parseManifestParts("renders,nope")).toBeNull();
    expect(parseManifestParts("")).toBeNull();
    expect(parseManifestParts(undefined)).toBeNull();
  });
});

describe("parseImportFromProjectRequest", () => {
  it("collapses duplicate paths and keeps the caller facts", () => {
    const parsed = parseImportFromProjectRequest({
      projectKey: "k",
      files: ["a.mp3", "a.mp3", "b.mp4"],
      requestId: "r",
      turnId: "t",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { projectKey: "k", files: ["a.mp3", "b.mp4"], requestId: "r", turnId: "t" },
    });
  });

  it.each([
    ["a non-object", null],
    ["no key", { files: ["a"] }],
    ["no files", { projectKey: "k", files: [] }],
    ["a non-string path", { projectKey: "k", files: [3] }],
    ["too many files", { projectKey: "k", files: Array.from({ length: 25 }, (_, i) => `f${i}`) }],
  ])("rejects %s", (_name, body) => {
    expect(parseImportFromProjectRequest(body).ok).toBe(false);
  });
});

describe("isProjectManifest", () => {
  it("needs typed files and a story that is text or null", () => {
    const base = { key: "k", name: "n", parts: ["music"], truncated: false, story: null };
    expect(
      isProjectManifest({ ...base, files: [{ path: "a.mp3", part: "music", bytes: 3 }] }),
    ).toBe(true);
    expect(
      isProjectManifest({ ...base, files: [{ path: "a.mp3", part: "story", bytes: 3 }] }),
    ).toBe(false);
  });
});
