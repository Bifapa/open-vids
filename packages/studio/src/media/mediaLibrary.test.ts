import { describe, expect, it } from "vitest";
import type {
  ProjectAsset,
  ProjectSourceEntry,
  SourceAnalysisStatus,
  StageState,
} from "@hyperframes/agent-protocol";
import {
  buildMediaItems,
  inCollection,
  matchItem,
  needsAnalysis,
  passesAnalysis,
  sectionItems,
  type MediaItem,
} from "./mediaLibrary";
import { t } from "../i18n";
import { attachMediaToStory, chaptersInOrder } from "./mediaStoryDrop";
import { sampleGraph } from "../story/storyTestHarness";

const stage = (stage: StageState["stage"], status: StageState["status"]): StageState => ({
  stage,
  status,
  updatedAt: null,
  version: null,
  detail: null,
});

function analysis(
  source: string,
  statuses: Partial<Record<StageState["stage"], StageState["status"]>>,
) {
  const stages = (
    ["transcript", "speakers", "silence", "shots", "takes", "segments", "vision"] as const
  ).map((name) => stage(name, statuses[name] ?? "missing"));
  const status: SourceAnalysisStatus = {
    source,
    kind: "video",
    duration: 10,
    fingerprint: null,
    stages,
  };
  return status;
}

function probe(path: string, overrides: Partial<ProjectAsset> = {}): ProjectAsset {
  return {
    path,
    kind: "video",
    bytes: 100,
    duration: 10,
    width: 1920,
    height: 1080,
    hasAudio: true,
    ...overrides,
  };
}

function record(asset: string, overrides: Partial<ProjectSourceEntry> = {}): ProjectSourceEntry {
  return {
    id: `prov-${asset}`,
    asset,
    mediaKind: "picture",
    title: "Steenbeck rollers",
    originalUrl: "https://example.org/a.jpg",
    pageUrl: null,
    source: { id: "commons", name: "Wikimedia Commons", trusted: true },
    author: "Jane Doe",
    authorUrl: null,
    license: "CC BY 4.0",
    licenseId: "cc_by",
    licenseUrl: null,
    licenseConfidence: "high",
    licenseStatus: "attribution",
    licenseBasis: "api",
    attribution: "",
    retrievedAt: 0,
    retrievedBy: { agent: "research", turnId: null, model: null },
    policyMode: "trusted",
    sha256: "",
    originalSha256: "",
    bytes: 50,
    contentType: "image/jpeg",
    converted: null,
    storyNode: null,
    need: null,
    present: true,
    usedIn: [],
    issues: [],
    ...overrides,
  };
}

function library(): MediaItem[] {
  return buildMediaItems({
    assets: [
      "assets/talk.mp4",
      "assets/logo.png",
      "assets/research/steenbeck.jpg",
      "assets/music.mp3",
      "assets/Inter.woff2",
      "renders/final.mp4",
      ".hyperframes/qa/frames/1-640.jpg",
      "index.html",
    ],
    inventory: new Map([["assets/talk.mp4", probe("assets/talk.mp4", { duration: 60 })]]),
    analysis: new Map([
      [
        "assets/talk.mp4",
        analysis("assets/talk.mp4", { transcript: "fresh", shots: "fresh", vision: "fresh" }),
      ],
      ["assets/music.mp3", analysis("assets/music.mp3", {})],
    ]),
    ranges: new Map([
      ["assets/music.mp3", { start: 2, end: 6 }],
      ["assets/talk.mp4", { start: 0, end: 60 }],
      ["assets/logo.png", { start: 1, end: 2 }],
    ]),
    provenance: [
      record("assets/research/steenbeck.jpg"),
      record("assets/research/gone.jpg", {
        present: false,
        retrievedBy: { agent: "user", turnId: null, model: null },
      }),
    ],
    usedPaths: new Set(["assets/talk.mp4"]),
  });
}

const paths = (items: readonly MediaItem[]) => items.map((item) => item.path);

describe("the media library", () => {
  it("holds the project's source media only: no renders, no Studio files, no compositions", () => {
    expect(paths(library())).toEqual([
      "assets/talk.mp4",
      "assets/logo.png",
      "assets/research/steenbeck.jpg",
      "assets/music.mp3",
      "assets/Inter.woff2",
      "assets/research/gone.jpg",
    ]);
  });

  it("keeps a researched file that left the project as an offline item with its provenance", () => {
    const gone = library().find((item) => item.path === "assets/research/gone.jpg");
    expect(gone).toMatchObject({ offline: true, kind: "image", origin: "download" });
    expect(gone?.provenance?.source.name).toBe("Wikimedia Commons");
  });

  it("keeps saved animations and other files out of the media library, present or gone", () => {
    const items = buildMediaItems({
      assets: ["assets/web/example.org/files/hero.json", "assets/web/example.org/files/hero.riv"],
      inventory: new Map(),
      analysis: new Map(),
      ranges: new Map(),
      provenance: [
        record("assets/web/example.org/files/hero.json", { mediaKind: "animation" }),
        record("assets/web/example.org/files/hero.riv", { mediaKind: "animation" }),
        record("assets/web/example.org/files/app.js", { mediaKind: "file", present: false }),
        record("assets/web/example.org/files/old.json", { mediaKind: "animation", present: false }),
      ],
      usedPaths: new Set(),
    });
    expect(items).toEqual([]);
  });

  it("carries a picked fragment on video and audio items, never a whole-file or an image's", () => {
    const items = library();
    const rangeOf = (path: string) => items.find((item) => item.path === path)?.range;
    // music.mp3 has no probe; its length comes from the analysis (10 s), so 2–6 s is a real pick.
    expect(rangeOf("assets/music.mp3")).toEqual({ start: 2, end: 6 });
    // 0–60 s of a 60 s file is the whole file: no pick.
    expect(rangeOf("assets/talk.mp4")).toBeNull();
    expect(rangeOf("assets/logo.png")).toBeNull();
  });

  it("sorts items into origin, usage and offline collections", () => {
    const items = library();
    const of = (collection: Parameters<typeof inCollection>[1]) =>
      paths(items.filter((item) => inCollection(item, collection)));
    expect(of("research")).toEqual(["assets/research/steenbeck.jpg"]);
    expect(of("download")).toEqual(["assets/research/gone.jpg"]);
    expect(of("offline")).toEqual(["assets/research/gone.jpg"]);
    expect(of("unused")).not.toContain("assets/talk.mp4");
    expect(of("font")).toEqual(["assets/Inter.woff2"]);
  });

  it("counts a source as waiting for analysis only while a computed stage is missing or stale", () => {
    const items = library();
    const talk = items.find((item) => item.path === "assets/talk.mp4");
    const music = items.find((item) => item.path === "assets/music.mp3");
    const logo = items.find((item) => item.path === "assets/logo.png");
    // talk: speakers/silence/takes/segments still missing.
    expect(talk && needsAnalysis(talk)).toBe(true);
    expect(music && needsAnalysis(music)).toBe(true);
    // Not a source the analysis service knows: nothing to wait for.
    expect(logo && needsAnalysis(logo)).toBe(false);
    const analyzed = items.map((item) =>
      item.path === "assets/talk.mp4" && item.analysis
        ? {
            ...item,
            analysis: {
              ...item.analysis,
              stages: item.analysis.stages.map((state) =>
                state.stage === "vision" ? state : { ...state, status: "unavailable" as const },
              ),
            },
          }
        : item,
    );
    const done = analyzed.find((item) => item.path === "assets/talk.mp4");
    expect(done && needsAnalysis(done)).toBe(false);
  });

  it("filters by ready analysis stages", () => {
    const items = library();
    expect(paths(items.filter((item) => passesAnalysis(item, "transcribed")))).toEqual([
      "assets/talk.mp4",
    ]);
    expect(paths(items.filter((item) => passesAnalysis(item, "vision")))).toEqual([
      "assets/talk.mp4",
    ]);
    expect(paths(items.filter((item) => passesAnalysis(item, "any")))).toHaveLength(items.length);
  });
});

describe("searching media", () => {
  const talk = () => library().find((item) => item.path === "assets/talk.mp4");
  const index = {
    sentences: [
      {
        id: "s1",
        start: 12,
        end: 14,
        firstWord: 0,
        lastWord: 2,
        text: "The timeline grows faster",
        speaker: "S1",
      },
    ],
    vision: [
      {
        id: "v1",
        start: 30,
        end: 32,
        frames: [31],
        quality: "good" as const,
        tags: ["speaker_on_camera"],
        finding: "Host at the desk",
        createdAt: 0,
      },
    ],
  };

  it("matches the file name first, then spoken words with their time, then vision tags", () => {
    const item = talk();
    if (!item) throw new Error("no talk");
    expect(matchItem(item, "TALK", index)).toEqual({ where: "name" });
    expect(matchItem(item, "timeline", index)).toEqual({
      where: "transcript",
      text: "The timeline grows faster",
      time: 12,
    });
    expect(matchItem(item, "speaker on", index)).toMatchObject({ where: "vision", time: 30 });
    expect(matchItem(item, "nothing like this", index)).toBeNull();
    // Without a loaded transcript only the name can match.
    expect(matchItem(item, "timeline", undefined)).toBeNull();
  });

  it("finds researched files by source and author", () => {
    const steenbeck = library().find((item) => item.path === "assets/research/steenbeck.jpg");
    if (!steenbeck) throw new Error("no steenbeck");
    expect(matchItem(steenbeck, "jane", undefined)).toEqual({ where: "source", text: "Jane Doe" });
  });
});

describe("sections", () => {
  it("groups by kind in a fixed order and drops empty kinds", () => {
    const sections = sectionItems(library(), "kind");
    expect(sections.map((section) => t(section.labelKey))).toEqual([
      "Video",
      "Images",
      "Audio",
      "Fonts",
    ]);
    expect(paths(sections[1]?.items ?? [])).toEqual([
      "assets/research/gone.jpg",
      "assets/logo.png",
      "assets/research/steenbeck.jpg",
    ]);
  });

  it("puts everything in one section for the other sorts, unknown lengths last", () => {
    const sections = sectionItems(library(), "duration");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.items[0]?.path).toBe("assets/talk.mp4");
  });
});

describe("dropping media on the Story Graph", () => {
  const item = { kind: "video" as const, path: "assets/talk.mp4", name: "talk.mp4" };

  it("lists chapters in play order", () => {
    expect(chaptersInOrder(sampleGraph()).map((chapter) => chapter.id)).toEqual(["a", "b", "c"]);
  });

  it("adds a material node for the asset and attaches it to the chapter", () => {
    const result = attachMediaToStory(sampleGraph(), item, "c");
    if (!result.ok) throw new Error(result.reason);
    const node = result.graph.nodes.find(
      (candidate) => "asset" in candidate && candidate.asset === item.path,
    );
    expect(node).toMatchObject({ kind: "video", title: "talk", createdBy: "user" });
    expect(result.graph.attachments.some((a) => a.node === node?.id && a.chapter === "c")).toBe(
      true,
    );
  });

  it("places an unconnected node without an attachment", () => {
    const before = sampleGraph();
    const result = attachMediaToStory(
      before,
      { ...item, kind: "audio", path: "assets/music.mp3" },
      null,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.graph.nodes.at(-1)).toMatchObject({ kind: "music", asset: "assets/music.mp3" });
    expect(result.graph.attachments).toHaveLength(before.attachments.length);
  });

  it("refuses fonts and chapters that no longer exist", () => {
    expect(attachMediaToStory(sampleGraph(), { ...item, kind: "font" }, "a").ok).toBe(false);
    expect(attachMediaToStory(sampleGraph(), item, "zzz").ok).toBe(false);
  });
});
