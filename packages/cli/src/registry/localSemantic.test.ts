import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cachedLocalVectorRevision,
  fetchLocalVectors,
  isMediaVectorRow,
  mediaSemanticRanking,
  vectorPairAgrees,
} from "./localSemantic.js";
import { LOCAL_MODEL_DIMENSIONS } from "./localModel.js";

describe("fetchLocalVectors", () => {
  let dir: string;
  let registryDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-vec-"));
    registryDir = mkdtempSync(join(tmpdir(), "hf-vec-reg-"));
    mkdirSync(join(registryDir, "catalog-artifact"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(registryDir, { recursive: true, force: true });
  });

  /** Stage a metadata/matrix pair into the scratch registry's catalog-artifact/. */
  const stagePair = (names: string[], dimensions: number, floats: number, revision?: string) => {
    writeFileSync(
      join(registryDir, "catalog-artifact", "local-vectors.json"),
      JSON.stringify({ names, dimensions, revision }),
    );
    writeFileSync(
      join(registryDir, "catalog-artifact", "local-vectors.bin"),
      Buffer.from(new Float32Array(floats).buffer),
    );
  };

  const mediaRow = {
    id: "click",
    kind: "sfx",
    title: "click",
    description: "short click",
    tags: ["ui"],
    file: "click.mp3",
    duration: 0.2,
  };

  const stageMediaPair = (metadata: unknown, floats = LOCAL_MODEL_DIMENSIONS) => {
    writeFileSync(
      join(registryDir, "catalog-artifact", "media-vectors.json"),
      JSON.stringify(metadata),
    );
    writeFileSync(
      join(registryDir, "catalog-artifact", "media-vectors.bin"),
      Buffer.from(new Float32Array(floats).buffer),
    );
  };

  it("copies both files from the local registry into the cache directory", async () => {
    stagePair(["whip-pan"], LOCAL_MODEL_DIMENSIONS, LOCAL_MODEL_DIMENSIONS);
    expect(await fetchLocalVectors({ registryDir, directory: dir })).toBe(true);
    expect(existsSync(join(dir, "local-vectors.bin"))).toBe(true);
    expect(existsSync(join(dir, "local-vectors.json"))).toBe(true);
  });

  it("caches nothing when the matrix is short of the names it claims", async () => {
    // Half a copy is the case worth refusing: written, it loads as an
    // error on every later search until someone clears the cache by hand.
    stagePair(["whip-pan", "rack-focus"], LOCAL_MODEL_DIMENSIONS, LOCAL_MODEL_DIMENSIONS);
    expect(await fetchLocalVectors({ registryDir, directory: dir })).toBe(false);
    expect(existsSync(join(dir, "local-vectors.bin"))).toBe(false);
    expect(existsSync(join(dir, "local-vectors.json"))).toBe(false);
  });

  it("caches nothing when the vectors came from a different model", async () => {
    stagePair(["whip-pan"], 1536, 1536);
    expect(await fetchLocalVectors({ registryDir, directory: dir })).toBe(false);
    expect(existsSync(join(dir, "local-vectors.json"))).toBe(false);
  });

  it("reports failure instead of throwing when the artifact is absent", async () => {
    // A tier the user switched on that silently never runs is the failure
    // being guarded: the caller needs a false to be able to say so.
    expect(await fetchLocalVectors({ registryDir, directory: dir })).toBe(false);
  });

  it("reports failure when the registry directory is missing", async () => {
    expect(
      await fetchLocalVectors({ registryDir: join(registryDir, "no-such-dir"), directory: dir }),
    ).toBe(false);
  });

  it("refuses an unexpected revision without replacing the previous pair", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "local-vectors.json"),
      JSON.stringify({ names: ["old"], dimensions: LOCAL_MODEL_DIMENSIONS, revision: "old" }),
    );
    writeFileSync(
      join(dir, "local-vectors.bin"),
      Buffer.from(new Float32Array(LOCAL_MODEL_DIMENSIONS).buffer),
    );
    stagePair(["new"], LOCAL_MODEL_DIMENSIONS, LOCAL_MODEL_DIMENSIONS, "old");

    expect(await fetchLocalVectors({ registryDir, directory: dir, expectedRevision: "new" })).toBe(
      false,
    );
    expect(JSON.parse(readFileSync(join(dir, "local-vectors.json"), "utf-8"))).toEqual({
      names: ["old"],
      dimensions: LOCAL_MODEL_DIMENSIONS,
      revision: "old",
    });
  });

  it("reads the revision only from a complete cached pair", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "local-vectors.json"),
      JSON.stringify({ names: ["whip-pan"], dimensions: LOCAL_MODEL_DIMENSIONS, revision: "r1" }),
    );
    expect(cachedLocalVectorRevision(dir)).toBeUndefined();

    writeFileSync(
      join(dir, "local-vectors.bin"),
      Buffer.from(new Float32Array(LOCAL_MODEL_DIMENSIONS).buffer),
    );
    expect(cachedLocalVectorRevision(dir)).toBe("r1");
  });

  it("reports no semantic result without a media-vector cache", async () => {
    expect(await mediaSemanticRanking("click", dir)).toBeNull();
  });

  it("accepts a complete media-vector pair with validated rows", async () => {
    stageMediaPair({
      names: ["click"],
      dimensions: LOCAL_MODEL_DIMENSIONS,
      rows: [mediaRow],
    });

    expect(
      await fetchLocalVectors({ registryDir, directory: dir, artifactBasename: "media-vectors" }),
    ).toBe(true);
    expect(existsSync(join(dir, "media-vectors.json"))).toBe(true);
    expect(existsSync(join(dir, "media-vectors.bin"))).toBe(true);
  });

  it.each([
    ["missing rows", {}],
    ["wrong row count", { rows: [] }],
    ["wrong row shape", { rows: [{ ...mediaRow, tags: ["ui", 3] }] }],
    ["wrong row id", { rows: [{ ...mediaRow, id: "other" }] }],
    ["invalid duration", { rows: [{ ...mediaRow, duration: -1 }] }],
    ["invalid dimensions", { rows: [{ ...mediaRow, dimensions: { width: 0, height: 10 } }] }],
  ])("rejects media-vector metadata with %s", async (_reason, extra) => {
    stageMediaPair({
      names: ["click"],
      dimensions: LOCAL_MODEL_DIMENSIONS,
      ...extra,
    });

    expect(
      await fetchLocalVectors({ registryDir, directory: dir, artifactBasename: "media-vectors" }),
    ).toBe(false);
    expect(existsSync(join(dir, "media-vectors.json"))).toBe(false);
  });

  it("rejects corrupt media-vector metadata in the registry", async () => {
    writeFileSync(join(registryDir, "catalog-artifact", "media-vectors.json"), "not json");
    writeFileSync(
      join(registryDir, "catalog-artifact", "media-vectors.bin"),
      Buffer.from(new Float32Array(LOCAL_MODEL_DIMENSIONS).buffer),
    );

    expect(
      await fetchLocalVectors({ registryDir, directory: dir, artifactBasename: "media-vectors" }),
    ).toBe(false);
  });
});

describe("media-vector validation", () => {
  const row = {
    id: "click",
    kind: "sfx",
    title: "click",
    description: "short click",
    tags: ["ui"],
    file: "click.mp3",
    duration: 0.2,
  };

  it.each([
    ["null", null],
    ["missing id", { ...row, id: undefined }],
    ["non-string tags", { ...row, tags: ["ui", 3] }],
    ["negative duration", { ...row, duration: -1 }],
    ["zero width", { ...row, dimensions: { width: 0, height: 10 } }],
  ])("rejects %s rows", (_name, candidate) => {
    expect(isMediaVectorRow(candidate)).toBe(false);
  });

  it("accepts a complete media row", () => {
    expect(isMediaVectorRow(row)).toBe(true);
    expect(isMediaVectorRow({ ...row, dimensions: { width: 1920, height: 1080 } })).toBe(true);
  });

  const invalidPairs: Array<[string, Array<[string, Buffer]>]> = [
    ["missing metadata", [["media-vectors.bin", Buffer.alloc(4)]]],
    ["missing matrix", [["media-vectors.json", Buffer.from("{}")]]],
    [
      "invalid json",
      [
        ["media-vectors.json", Buffer.from("not json")],
        ["media-vectors.bin", Buffer.alloc(4)],
      ],
    ],
    [
      "invalid media row",
      [
        [
          "media-vectors.json",
          Buffer.from(
            JSON.stringify({ names: ["click"], dimensions: 1, rows: [{ ...row, id: "other" }] }),
          ),
        ],
        ["media-vectors.bin", Buffer.alloc(4)],
      ],
    ],
  ];

  it.each(invalidPairs)("rejects pairs with %s", (_name, fetched) => {
    expect(vectorPairAgrees(fetched, "media-vectors")).toBe(false);
  });

  it("accepts a matching media-vector pair", () => {
    const metadata = {
      names: ["click"],
      dimensions: LOCAL_MODEL_DIMENSIONS,
      rows: [row],
    };
    expect(
      vectorPairAgrees(
        [
          ["media-vectors.json", Buffer.from(JSON.stringify(metadata))],
          ["media-vectors.bin", Buffer.alloc(4 * LOCAL_MODEL_DIMENSIONS)],
        ],
        "media-vectors",
      ),
    ).toBe(true);
  });
});
