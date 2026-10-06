import { afterEach, describe, expect, it } from "vitest";
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  affectsProjectHistory,
  affectsProjectSignature,
  createProjectSignature,
  listProjectFiles,
} from "./projectSignature.js";

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const project of temporaryProjects.splice(0)) rmSync(project, { recursive: true });
});

const PROJECT = resolve("/projects/demo");
const affects = (relativePath: string) =>
  affectsProjectSignature(PROJECT, resolve(PROJECT, relativePath));

describe("affectsProjectSignature", () => {
  it("accepts a file the signature walk collects", () => {
    expect(affects("index.html")).toBe(true);
    expect(affects("assets/logo.png")).toBe(true);
  });

  it("rejects the caches the walk skips", () => {
    // .thumbnails is the one that matters: the thumbnail route writes a capture
    // there and reads the preview on the next one, so invalidating on it throws
    // the memo away on roughly every request of the workload it exists for.
    expect(affects(".thumbnails/frame-0.jpg")).toBe(false);
    expect(affects("node_modules/pkg/index.js")).toBe(false);
    expect(affects("renders/out.mp4")).toBe(false);
  });

  it("rejects a directory event on an excluded dir itself", () => {
    expect(affects(".thumbnails")).toBe(false);
  });

  it("accepts the two manifest files the signature reads back out of .hyperframes", () => {
    // The reload watcher's exclusion set is character-identical to the walk's but
    // drops all of .hyperframes/. Filtering with it would stop a motion-state save
    // from ever invalidating — the same stale-ETag bug in a new place.
    expect(affects(".hyperframes/studio-motion.json")).toBe(true);
    expect(affects(".hyperframes/studio-manual-edits.json")).toBe(true);
  });

  it("rejects everything else inside .hyperframes", () => {
    expect(affects(".hyperframes/cache/blob.bin")).toBe(false);
  });

  it("rejects a path outside the project", () => {
    expect(affectsProjectSignature(PROJECT, resolve("/projects/other/index.html"))).toBe(false);
    expect(affectsProjectSignature(PROJECT, PROJECT)).toBe(false);
  });
});

describe("history-only tracked paths", () => {
  const tracksHistory = (relativePath: string) =>
    affectsProjectHistory(PROJECT, resolve(PROJECT, relativePath));

  it("include the story graph and its folder, without touching the preview signature", () => {
    expect(tracksHistory(".hyperframes/story/graph.json")).toBe(true);
    expect(tracksHistory(".hyperframes/story")).toBe(true);
    expect(affects(".hyperframes/story/graph.json")).toBe(false);
    expect(tracksHistory("index.html")).toBe(true);
    expect(tracksHistory(".hyperframes")).toBe(false);
    expect(tracksHistory(".hyperframes/analysis/x.json")).toBe(false);
    // The research provenance ledger rolls back with a turn; the download cache beside it does not.
    expect(tracksHistory(".hyperframes/research/provenance.json")).toBe(true);
    expect(tracksHistory(".hyperframes/research")).toBe(true);
    expect(affects(".hyperframes/research/provenance.json")).toBe(false);
    expect(tracksHistory(".hyperframes/research/cache/index.json")).toBe(false);
    // The user's picked fragments roll back with a turn; the media folder holds nothing else tracked.
    expect(tracksHistory(".hyperframes/media/ranges.json")).toBe(true);
    expect(tracksHistory(".hyperframes/media")).toBe(true);
    expect(affects(".hyperframes/media/ranges.json")).toBe(false);
    expect(tracksHistory(".hyperframes/media/other.json")).toBe(false);
    expect(tracksHistory("assets/research/ocean-1a2b3c4d.mp4")).toBe(true);
    // Voiceover takes roll back with a turn; the scratch folder beside them does not, the audio is under assets/.
    expect(tracksHistory(".hyperframes/voice/takes.json")).toBe(true);
    expect(tracksHistory(".hyperframes/voice")).toBe(true);
    expect(affects(".hyperframes/voice/takes.json")).toBe(false);
    expect(tracksHistory(".hyperframes/voice/tmp/1-abcd1234.wav")).toBe(false);
    expect(tracksHistory("assets/voice/hello-1a2b3c4d.wav")).toBe(true);
  });

  it("list the graph for project history but leave it out of the signature", () => {
    const project = mkdtempSync(resolve(tmpdir(), "hf-signature-"));
    temporaryProjects.push(project);
    writeFileSync(resolve(project, "index.html"), "<html></html>");
    const before = createProjectSignature(project);
    mkdirSync(resolve(project, ".hyperframes/story"), { recursive: true });
    writeFileSync(resolve(project, ".hyperframes/story/graph.json"), "{}");
    expect(createProjectSignature(project)).toBe(before);
    expect(listProjectFiles(project).map((file) => file.path)).toContain(
      ".hyperframes/story/graph.json",
    );
  });
});

describe("createProjectSignature", () => {
  it("changes after same-size content is written with the original mtime restored", () => {
    const project = mkdtempSync(resolve(tmpdir(), "hf-signature-"));
    temporaryProjects.push(project);
    const file = resolve(project, "index.html");
    const descriptor = openSync(file, "w+");
    try {
      writeSync(descriptor, "first");
      const originalMtime = fstatSync(descriptor).mtime;
      const before = createProjectSignature(project);

      ftruncateSync(descriptor, 0);
      writeSync(descriptor, "other", 0, "utf8");
      futimesSync(descriptor, originalMtime, originalMtime);

      expect(createProjectSignature(project)).not.toBe(before);
    } finally {
      closeSync(descriptor);
    }
  });
});
