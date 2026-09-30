// @vitest-environment node
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CutPlan,
  SegmentMap,
  SourceFingerprint,
  TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { checkFingerprint, SAMPLE_BYTES } from "./fingerprint.js";
import {
  AnalysisStore,
  STAGE_RECIPES,
  evaluateStages,
  isSegmentMap,
  isTranscript,
  type SourceManifest,
} from "./store.js";
import { artifactVersion } from "./version.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openvids-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fingerprint(path: string, hash = "sha256:aa"): SourceFingerprint {
  return { path, bytes: 10, mtimeMs: 1, hash, duration: 8 };
}

function transcript(source: string, text: string): TranscriptArtifact {
  return {
    source,
    language: "en",
    words: [{ i: 0, text, start: 0, end: 1, speaker: null }],
    sentences: [{ id: "s1", start: 0, end: 1, firstWord: 0, lastWord: 0, text, speaker: null }],
    speechSeconds: 1,
  };
}

function segments(
  source: string,
  transcriptVersion: string,
  origin: SegmentMap["origin"],
): SegmentMap {
  return {
    source,
    origin,
    transcriptVersion,
    segments: [
      {
        id: "g1",
        start: 0,
        end: 1,
        firstSentence: "s1",
        lastSentence: "s1",
        title: "All",
        summary: "All of it",
        role: "main",
        priority: "must",
        speaker: null,
      },
    ],
  };
}

function plan(id: string, source: string): CutPlan {
  return {
    id,
    source,
    label: "cut",
    createdAt: 1,
    basedOn: null,
    stats: {
      sourceDuration: 8,
      cutDuration: 8,
      ranges: 1,
      removedPauseSeconds: 0,
      removedFillers: 0,
      removedTakes: 0,
      droppedSegments: [],
      movedSegments: [],
      hookSeconds: 0,
    },
    applied: null,
    request: { source },
    transcriptVersion: "sha256:t",
    segmentsVersion: "sha256:s",
    ranges: [],
    removed: [],
    warnings: [],
  };
}

/** A source with a silence map, speakers, a transcript and draft segments, recorded the way stages record them. */
async function analysed(store: AnalysisStore, path: string) {
  await store.createSource(fingerprint(path));
  const silence = {
    source: path,
    thresholdDb: -38,
    minSilence: 0.35,
    silences: [],
    silenceSeconds: 0,
  };
  const speakers = { source: path, method: "single", speakers: [], turns: [], note: null };
  const silenceRecord = await store.commit(path, "silence", silence);
  const speakerRecord = await store.commit(path, "speakers", speakers);
  const asrRecord = await store.commit(path, "asr", { language: "en", producer: "x", words: [] });
  const transcriptRecord = await store.commit(path, "transcript", transcript(path, "hello"), {
    inputs: { asr: asrRecord.version, speakers: speakerRecord.version },
  });
  await store.commit(path, "segments", segments(path, transcriptRecord.version, "draft"), {
    inputs: {
      transcript: transcriptRecord.version,
      silence: silenceRecord.version,
      speakers: speakerRecord.version,
    },
    params: { origin: "draft" },
  });
  const manifest = await store.readManifest(path);
  if (!manifest) throw new Error("no manifest");
  return { manifest, silenceRecord, transcriptRecord };
}

const statusOf = (manifest: SourceManifest, changed = false) =>
  Object.fromEntries(evaluateStages(manifest, changed).map((state) => [state.stage, state.status]));

describe("evaluateStages", () => {
  it("judges stored stages fresh only while every input still has the recorded version", async () => {
    const store = new AnalysisStore(tempDir());
    const { manifest } = await analysed(store, "a.mp4");
    expect(statusOf(manifest)).toMatchObject({
      silence: "fresh",
      speakers: "fresh",
      transcript: "fresh",
      segments: "fresh",
      takes: "missing",
      vision: "missing",
    });

    // A new speaker map makes the transcript built from the old one stale, and the segments built on that transcript.
    await store.commit("a.mp4", "speakers", {
      source: "a.mp4",
      method: "diarization",
      speakers: [],
      turns: [],
      note: null,
    });
    const after = await store.readManifest("a.mp4");
    expect(after && statusOf(after)).toMatchObject({
      speakers: "fresh",
      transcript: "stale",
      segments: "stale",
      silence: "fresh",
    });
  });

  it("marks everything stored stale when the source bytes changed, and nothing else", async () => {
    const store = new AnalysisStore(tempDir());
    const { manifest } = await analysed(store, "a.mp4");
    expect(statusOf(manifest, true)).toMatchObject({
      silence: "stale",
      transcript: "stale",
      takes: "missing",
    });
  });

  it("keeps agent-written segments fresh through a changed pause map, and stale when the transcript changes", async () => {
    const store = new AnalysisStore(tempDir());
    const { transcriptRecord } = await analysed(store, "a.mp4");
    await store.commit(
      "a.mp4",
      "segments",
      segments("a.mp4", transcriptRecord.version, "semantic"),
      {
        inputs: { transcript: transcriptRecord.version },
        params: { origin: "semantic" },
      },
    );
    await store.commit("a.mp4", "silence", {
      source: "a.mp4",
      thresholdDb: -30,
      minSilence: 0.5,
      silences: [{ start: 1, end: 2 }],
      silenceSeconds: 1,
    });
    let manifest = await store.readManifest("a.mp4");
    expect(manifest && statusOf(manifest).segments).toBe("fresh");

    await store.commit("a.mp4", "transcript", transcript("a.mp4", "different"), {
      inputs: {
        asr: manifest?.asr?.version ?? null,
        speakers: manifest?.stages.speakers?.version ?? null,
      },
    });
    manifest = await store.readManifest("a.mp4");
    expect(manifest && statusOf(manifest).segments).toBe("stale");
  });

  it("stamps computed stages with their recipe and marks one made by another method stale", async () => {
    const store = new AnalysisStore(tempDir());
    const { manifest } = await analysed(store, "a.mp4");
    expect(manifest.stages.silence?.recipe).toBe(STAGE_RECIPES.silence);
    expect(manifest.stages.transcript?.recipe).toBe(STAGE_RECIPES.transcript);
    expect(manifest.asr?.recipe).toBeUndefined();

    await store.updateManifest("a.mp4", (open) => {
      const record = open.stages.silence;
      if (record) record.recipe = "fixed-threshold/1";
    });
    const older = await store.readManifest("a.mp4");
    const states = older ? evaluateStages(older, false) : [];
    expect(states.find((state) => state.stage === "silence")).toMatchObject({
      status: "stale",
      detail: "analysis method updated",
    });
    // Stored before recipes existed: no recipe at all is an older method too.
    await store.updateManifest("a.mp4", (open) => {
      const record = open.stages.silence;
      if (record) delete record.recipe;
    });
    const legacy = await store.readManifest("a.mp4");
    expect(legacy && statusOf(legacy).silence).toBe("stale");
  });

  it("never judges agent-written segments by a recipe", async () => {
    const store = new AnalysisStore(tempDir());
    const { transcriptRecord } = await analysed(store, "a.mp4");
    await store.commit(
      "a.mp4",
      "segments",
      segments("a.mp4", transcriptRecord.version, "semantic"),
      { inputs: { transcript: transcriptRecord.version }, params: { origin: "semantic" } },
    );
    const manifest = await store.readManifest("a.mp4");
    expect(manifest?.stages.segments?.recipe).toBeUndefined();
    expect(manifest && statusOf(manifest).segments).toBe("fresh");
  });

  it("reports why a stage has no artifact: unavailable or failed", async () => {
    const store = new AnalysisStore(tempDir());
    await store.createSource(fingerprint("a.mp4"));
    await store.setProblem("a.mp4", "transcript", {
      status: "unavailable",
      detail: "no recognizer",
    });
    await store.setProblem("a.mp4", "shots", { status: "failed", detail: "boom" });
    const manifest = await store.readManifest("a.mp4");
    const states = manifest ? evaluateStages(manifest, false) : [];
    expect(states.find((state) => state.stage === "transcript")).toMatchObject({
      status: "unavailable",
      detail: "no recognizer",
    });
    expect(states.find((state) => state.stage === "shots")?.status).toBe("failed");
  });
});

describe("artifacts", () => {
  it("does not serve an artifact whose bytes no longer match the recorded version", async () => {
    const dir = tempDir();
    const store = new AnalysisStore(dir);
    await analysed(store, "a.mp4");
    const manifest = await store.readManifest("a.mp4");
    if (!manifest) throw new Error("no manifest");
    expect(await store.readArtifact(manifest, "transcript", isTranscript)).not.toBeNull();

    const file = join(store.sourceDir("a.mp4"), "transcript.json");
    writeFileSync(file, readFileSync(file, "utf-8").replace("hello", "tampered"));
    expect(await store.readArtifact(manifest, "transcript", isTranscript)).toBeNull();
  });

  it("stores human-readable JSON under .hyperframes/analysis and nothing else in the project", async () => {
    const dir = tempDir();
    const store = new AnalysisStore(dir);
    await analysed(store, "clips/a.mp4");
    expect(
      store.sourceDir("clips/a.mp4").startsWith(join(dir, ".hyperframes", "analysis", "sources")),
    ).toBe(true);
    expect(readFileSync(join(store.sourceDir("clips/a.mp4"), "manifest.json"), "utf-8")).toContain(
      '\n  "path"',
    );
  });
});

describe("adopting a twin (renamed file)", () => {
  it("rewrites every artifact for the new path and remaps versions so the copy is fresh", async () => {
    const store = new AnalysisStore(tempDir());
    const { transcriptRecord } = await analysed(store, "old.mp4");
    await store.commit(
      "old.mp4",
      "segments",
      segments("old.mp4", transcriptRecord.version, "semantic"),
      {
        inputs: { transcript: transcriptRecord.version },
        params: { origin: "semantic" },
      },
    );
    const twin = await store.readManifest("old.mp4");
    if (!twin) throw new Error("no twin");

    const found = await store.findTwin("new.mp4", { ...fingerprint("new.mp4"), mtimeMs: 99 });
    expect(found?.path).toBe("old.mp4");
    const adopted = await store.adopt(twin, fingerprint("new.mp4"));

    expect(statusOf(adopted)).toMatchObject({
      silence: "fresh",
      transcript: "fresh",
      segments: "fresh",
    });
    const moved = await store.readArtifact(adopted, "transcript", isTranscript);
    const newVersion = adopted.stages.transcript?.version;
    expect(moved?.source).toBe("new.mp4");
    expect(newVersion).toBe(artifactVersion(moved));
    expect(newVersion).not.toBe(transcriptRecord.version);
    const semantic = await store.readArtifact(adopted, "segments", isSegmentMap);
    expect(semantic).toMatchObject({
      source: "new.mp4",
      origin: "semantic",
      transcriptVersion: newVersion,
    });
  });

  it("does not offer a twin with different content", async () => {
    const store = new AnalysisStore(tempDir());
    await analysed(store, "old.mp4");
    expect(await store.findTwin("new.mp4", fingerprint("new.mp4", "sha256:bb"))).toBeNull();
  });
});

describe("cut plans", () => {
  it("numbers plans cut-1, cut-2, … without gaps or repeats even when planned at the same time", async () => {
    const store = new AnalysisStore(tempDir());
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => store.createCut(async (id) => plan(id, "a.mp4"))),
    );
    expect(ids.map((made) => made.id).sort()).toEqual([
      "cut-1",
      "cut-2",
      "cut-3",
      "cut-4",
      "cut-5",
      "cut-6",
    ]);
    expect((await store.listCuts()).map((summary) => summary.id)).toEqual([
      "cut-1",
      "cut-2",
      "cut-3",
      "cut-4",
      "cut-5",
      "cut-6",
    ]);
  });

  it("does not spend an id on a plan that failed, and refuses ids that are not plan ids", async () => {
    const store = new AnalysisStore(tempDir());
    await expect(store.createCut(async () => Promise.reject(new Error("no plan")))).rejects.toThrow(
      "no plan",
    );
    expect((await store.createCut(async (id) => plan(id, "a.mp4"))).id).toBe("cut-1");
    expect(await store.readCut("../manifest")).toBeNull();
    expect(await store.readCut("cut-0")).toBeNull();
    expect((await store.readCut("cut-1"))?.source).toBe("a.mp4");
  });

  it("replaces a plan and its summary when it is marked applied", async () => {
    const store = new AnalysisStore(tempDir());
    const made = await store.createCut(async (id) => plan(id, "a.mp4"));
    await store.replaceCut({
      ...made,
      applied: { composition: "index.html", version: "sha256:v", at: 5 },
    });
    expect((await store.listCuts())[0]?.applied?.composition).toBe("index.html");
    expect((await store.readCut("cut-1"))?.applied?.at).toBe(5);
  });
});

describe("fingerprints", () => {
  it("hashes only when the stat moved: a touch keeps the artifacts, a changed byte drops them", async () => {
    const dir = tempDir();
    const file = join(dir, "clip.bin");
    writeFileSync(file, Buffer.alloc(5000, 1));
    const first = await checkFingerprint(file, "clip.bin", null);
    expect(first.change).toBe("new");
    expect((await checkFingerprint(file, "clip.bin", first.fingerprint)).change).toBe("unchanged");

    const later = new Date(statSync(file).mtimeMs + 60_000);
    utimesSync(file, later, later);
    const touched = await checkFingerprint(file, "clip.bin", first.fingerprint);
    expect(touched.change).toBe("touched");
    expect(touched.fingerprint.hash).toBe(first.fingerprint.hash);

    appendFileSync(file, "x");
    expect((await checkFingerprint(file, "clip.bin", touched.fingerprint)).change).toBe("changed");
  });

  it("samples the head, middle and tail of a large file: an edit in the middle changes the hash", async () => {
    const dir = tempDir();
    const file = join(dir, "big.bin");
    const size = SAMPLE_BYTES * 4;
    const bytes = Buffer.alloc(size, 7);
    writeFileSync(file, bytes);
    const before = await checkFingerprint(file, "big.bin", null);
    bytes[Math.floor(size / 2)] = 9;
    writeFileSync(file, bytes);
    const later = new Date(statSync(file).mtimeMs + 1000);
    utimesSync(file, later, later);
    const after = await checkFingerprint(file, "big.bin", before.fingerprint);
    expect(after.change).toBe("changed");
    expect(after.fingerprint.hash).not.toBe(before.fingerprint.hash);
  });
});
