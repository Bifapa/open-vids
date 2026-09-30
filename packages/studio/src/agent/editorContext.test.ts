import { describe, expect, it } from "vitest";
import { parseEditorContext } from "@hyperframes/agent-protocol";
import type { TimelineElement } from "../player";
import { buildEditorContext, type EditorContextInput } from "./editorContext";

const clip = (index: number, overrides: Partial<TimelineElement> = {}): TimelineElement => ({
  id: `clip-${index}`,
  tag: "div",
  start: index,
  duration: 2,
  track: index % 3,
  ...overrides,
});

function input(overrides: Partial<EditorContextInput> = {}): EditorContextInput {
  return {
    now: 1234,
    projectId: "demo",
    activeCompPath: "index.html",
    compositionDimensions: { width: 1920, height: 1080 },
    elements: [],
    duration: 10,
    currentTime: 3.14159,
    isPlaying: false,
    selectedElementId: null,
    selectedElementIds: new Set(),
    assetPath: null,
    previewSelection: null,
    inPoint: null,
    outPoint: null,
    rangeSelection: null,
    renderSettings: null,
    storyGraph: null,
    ...overrides,
  };
}

describe("buildEditorContext", () => {
  it("reports what Studio knows and nothing it does not", () => {
    const context = buildEditorContext(input());
    expect(context).toMatchObject({
      schemaVersion: 1,
      capturedAt: 1234,
      project: { id: "demo" },
      activeComposition: { path: "index.html", width: 1920, height: 1080, duration: 10 },
      playhead: { time: 3.142, playing: false },
      selection: { clips: [], assetPath: null, previewElement: null, range: null },
      renderSettings: null,
      storyGraph: null,
    });
    expect(context.project).not.toHaveProperty("title");
  });

  it("is null for the composition when none is open", () => {
    expect(buildEditorContext(input({ activeCompPath: null })).activeComposition).toBeNull();
  });

  it("caps the timeline at 200 clips but keeps the true count", () => {
    const elements = Array.from({ length: 500 }, (_, index) => clip(index));
    const { timeline } = buildEditorContext(input({ elements }));
    expect(timeline.elements).toHaveLength(200);
    expect(timeline.elementCount).toBe(500);
    expect(timeline.elements[0]).toMatchObject({ id: "clip-0", start: 0, duration: 2, tag: "div" });
  });

  it("selects clips by the timeline's own key, primary and multi-selection together", () => {
    const elements = [
      clip(0, { key: "index.html#intro", domId: "intro", sourceFile: "index.html" }),
      clip(1),
      clip(2),
    ];
    const { selection } = buildEditorContext(
      input({
        elements,
        selectedElementId: "clip-1",
        selectedElementIds: new Set(["index.html#intro", "gone"]),
      }),
    );
    expect(selection.clips.map((item) => item.id)).toEqual(["index.html#intro", "clip-1"]);
    expect(selection.clips[0]).toMatchObject({ domId: "intro", sourceFile: "index.html" });
  });

  it("caps the selection at what the protocol accepts", () => {
    const elements = Array.from({ length: 100 }, (_, index) => clip(index));
    const { selection } = buildEditorContext(
      input({ elements, selectedElementIds: new Set(elements.map((item) => item.id)) }),
    );
    expect(selection.clips).toHaveLength(64);
  });

  it("maps the DOM selection to a preview element and skips empty fields", () => {
    const { selection } = buildEditorContext(
      input({
        previewSelection: {
          id: "headline",
          hfId: undefined,
          selector: "#headline",
          label: "Headline",
          tagName: "h1",
          sourceFile: "index.html",
        },
      }),
    );
    expect(selection.previewElement).toEqual({
      domId: "headline",
      selector: "#headline",
      label: "Headline",
      tagName: "h1",
      sourceFile: "index.html",
    });
  });

  it("prefers a shift-drag range over the in/out points, and fills a missing end from the duration", () => {
    expect(
      buildEditorContext(input({ rangeSelection: { t0: 1, t1: 2.5 }, inPoint: 5, outPoint: 6 }))
        .selection.range,
    ).toEqual({ start: 1, end: 2.5 });
    expect(buildEditorContext(input({ inPoint: 4 })).selection.range).toEqual({
      start: 4,
      end: 10,
    });
    expect(buildEditorContext(input({ inPoint: 8, outPoint: 2 })).selection.range).toBeNull();
  });

  it("never emits a non-finite number", () => {
    const context = buildEditorContext(
      input({
        currentTime: Number.NaN,
        duration: Number.POSITIVE_INFINITY,
        elements: [clip(0, { start: Number.NaN, duration: Number.POSITIVE_INFINITY })],
      }),
    );
    expect(context.playhead.time).toBe(0);
    expect(context.timeline.duration).toBe(0);
    expect(context.timeline.elements[0]).toMatchObject({ start: 0, duration: 0 });
  });

  it("produces a context the gateway's own validator accepts unchanged", () => {
    const elements = [clip(0, { label: "Intro", src: "a.mp4" }), clip(1)];
    const context = buildEditorContext(
      input({
        elements,
        selectedElementId: "clip-0",
        assetPath: "assets/a.mp4",
        renderSettings: { format: "mp4", fps: 30, quality: "standard" },
        inPoint: 1,
        outPoint: 3,
      }),
    );
    const parsed = parseEditorContext(JSON.parse(JSON.stringify(context)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(context);
  });
});
