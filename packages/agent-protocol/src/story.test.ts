import { describe, expect, it } from "vitest";
import {
  STORY_GRAPH_SCHEMA,
  parseStoryEditRequest,
  parseStoryGraph,
  type StoryGraph,
} from "./index.js";

const RESOLUTION = {
  missing: "missing-1",
  mediaKind: "video",
  need: "Ocean waves",
  at: 10,
  turnId: "turn-1",
};

function graph(nodes: unknown[]): unknown {
  const base: StoryGraph = {
    schema: STORY_GRAPH_SCHEMA,
    id: "story-1",
    title: "Story",
    brief: "",
    settings: { composition: null, captionPreset: null },
    nodes: [],
    edges: [],
    attachments: [],
    removedByUser: [],
    review: null,
    build: null,
    updatedAt: 1,
    updatedBy: "ai",
  };
  return { ...base, nodes };
}

const node = (kind: string, extra: Record<string, unknown>) => ({
  id: `${kind}-1`,
  kind,
  title: "T",
  position: { x: 0, y: 0 },
  locked: false,
  createdBy: "ai",
  userEdited: [],
  ...extra,
});

describe("resolve_missing", () => {
  it("parses the operation with its optional fields and refuses unknown fields and bad ranges", () => {
    const parsed = parseStoryEditRequest({
      operations: [
        { op: "resolve_missing", id: "missing-1", asset: "assets/research/a.mp4" },
        {
          op: "resolve_missing",
          id: "@m",
          asset: "assets/research/a.mp4",
          title: "Waves",
          usageIntent: "Opening shot",
          sourceIn: 2,
          sourceOut: 5,
        },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        operations: [
          { op: "resolve_missing", id: "missing-1", asset: "assets/research/a.mp4" },
          {
            op: "resolve_missing",
            id: "@m",
            asset: "assets/research/a.mp4",
            title: "Waves",
            usageIntent: "Opening shot",
            sourceIn: 2,
            sourceOut: 5,
          },
        ],
      },
    });
    const refused = (operation: Record<string, unknown>) =>
      parseStoryEditRequest({ operations: [{ op: "resolve_missing", ...operation }] });
    expect(refused({ id: "m", asset: "a.mp4", position: { x: 1, y: 1 } })).toMatchObject({
      ok: false,
      error: { code: "invalid_request", opIndex: 0 },
    });
    expect(refused({ id: "m" })).toMatchObject({ ok: false });
    expect(refused({ id: "m", asset: "a.mp4", sourceIn: 5, sourceOut: 5 })).toMatchObject({
      ok: false,
    });
  });
});

describe("resolvedFrom on stored graphs", () => {
  it("round-trips on video, picture and music nodes and stays absent on old graphs", () => {
    const stored = graph([
      node("video", {
        asset: "a.mp4",
        sourceIn: 0,
        sourceOut: null,
        usageIntent: "",
        previewFrame: null,
        resolvedFrom: RESOLUTION,
      }),
      node("picture", { asset: "a.png", usageIntent: "", resolvedFrom: RESOLUTION }),
      node("music", {
        asset: "a.mp3",
        bpm: null,
        volume: 1,
        usageIntent: "",
        resolvedFrom: { ...RESOLUTION, mediaKind: "music", turnId: null },
      }),
      { ...node("picture", { asset: "b.png", usageIntent: "" }), id: "picture-2" },
    ]);
    const parsed = parseStoryGraph(stored);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(
      parsed.value.nodes.map((entry) => ("resolvedFrom" in entry ? entry.resolvedFrom : "none")),
    ).toEqual([
      RESOLUTION,
      RESOLUTION,
      { ...RESOLUTION, mediaKind: "music", turnId: null },
      "none",
    ]);
    expect(parsed.value.nodes[3]).not.toHaveProperty("resolvedFrom");
  });

  it("refuses a malformed resolution and a resolution on a node kind that cannot have one", () => {
    const bad = parseStoryGraph(
      graph([
        node("picture", {
          asset: "a.png",
          usageIntent: "",
          resolvedFrom: { ...RESOLUTION, mediaKind: "hologram" },
        }),
      ]),
    );
    expect(bad).toMatchObject({ ok: false });
    const extra = parseStoryGraph(
      graph([
        node("picture", {
          asset: "a.png",
          usageIntent: "",
          resolvedFrom: { ...RESOLUTION, extra: true },
        }),
      ]),
    );
    expect(extra).toMatchObject({ ok: false });
    const onMissing = parseStoryGraph(
      graph([
        node("missing", {
          mediaKind: "video",
          need: "x",
          neededDuration: null,
          resolvedFrom: RESOLUTION,
        }),
      ]),
    );
    expect(onMissing).toMatchObject({ ok: false });
  });
});
