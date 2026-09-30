import { describe, expect, it } from "vitest";
import type {
  AgentId,
  EditorContext,
  SpecialistId,
  TimelineClip,
  TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import type { HostTool } from "../backend.js";
import { buildHostTools } from "../agents/tools.js";
import { FakeEditingHost } from "../testing/editing.js";
import { TurnEditing } from "./executor.js";
import { RESULT_CHARS } from "./format.js";
import { EditingError } from "./host.js";
import { EDITING_TOOL_NAMES, isEditingToolName } from "./tools.js";

const EDITING = Object.values<string>(EDITING_TOOL_NAMES);

function editingToolsOf(agent: AgentId, enabled: SpecialistId[], editing = true): string[] {
  return buildHostTools(agent, { enabled, jev: true, editing, analysis: false }, async () => ({
    text: "",
  }))
    .map((tool) => tool.name)
    .filter(isEditingToolName);
}

describe("editing tool availability", () => {
  it("gives the Director edit_timeline only when it has no Editor to delegate to", () => {
    const withEditor = editingToolsOf("director", ["editor", "motion"]);
    expect(withEditor).toEqual([
      "inspect_project",
      "inspect_timeline",
      "browse_presets",
      "render_video",
    ]);
    for (const enabled of [[], ["motion"], ["audio", "vision"]] satisfies SpecialistId[][]) {
      expect(editingToolsOf("director", enabled)).toContain("edit_timeline");
    }
  });

  it("gives each specialist the tools its domain needs, and Jev none", () => {
    const enabled: SpecialistId[] = ["editor", "motion", "audio", "vision", "research"];
    expect(editingToolsOf("editor", enabled).sort()).toEqual([...EDITING].sort());
    expect(editingToolsOf("motion", enabled)).toEqual([
      "inspect_project",
      "inspect_timeline",
      "browse_presets",
      "edit_timeline",
    ]);
    expect(editingToolsOf("audio", enabled)).toEqual([
      "inspect_project",
      "inspect_timeline",
      "edit_timeline",
    ]);
    for (const readOnly of ["vision", "research"] as const) {
      expect(editingToolsOf(readOnly, enabled)).toEqual([
        "inspect_project",
        "inspect_timeline",
        "browse_presets",
      ]);
    }
    expect(editingToolsOf("jev", enabled)).toEqual([]);
  });

  it("offers no editing tools when the runtime has no editing host", () => {
    for (const agent of ["director", "editor", "motion", "audio"] as const) {
      expect(editingToolsOf(agent, ["editor"], false)).toEqual([]);
    }
  });

  it("keeps the orchestration tools of the Director unchanged", () => {
    const names = buildHostTools(
      "director",
      { enabled: ["editor"], jev: true, editing: true, analysis: false },
      async () => ({ text: "" }),
    ).map((tool) => tool.name);
    expect(names).toEqual([
      "update_plan",
      "delegate",
      "wait_for_agents",
      "message_agent",
      "cancel_agent",
      "inspect_project",
      "inspect_timeline",
      "browse_presets",
      "render_video",
      "jev",
    ]);
  });
});

function tool(name: string): HostTool {
  const found = buildHostTools(
    "editor",
    { enabled: [], jev: false, editing: true, analysis: false },
    async () => ({
      text: "",
    }),
  ).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

describe("editing tool activity rows", () => {
  it("labels calls for the chat without exposing raw arguments", () => {
    expect(tool("inspect_project").activity?.({})).toEqual({
      category: "inspect",
      label: "Inspecting the project",
    });
    expect(tool("inspect_timeline").activity?.({})?.label).toBe("Inspecting the timeline");
    expect(
      tool("edit_timeline").activity?.({
        operations: [
          { op: "add_clip" },
          { op: "add_clip" },
          { op: "add_clip" },
          { op: "split_clip" },
        ],
      }),
    ).toEqual({ category: "edit", label: "Editing the timeline · 4 changes (add clip ×3, split)" });
    expect(tool("edit_timeline").activity?.({ operations: [{ op: "trim_clip" }] })?.label).toBe(
      "Editing the timeline · 1 change (trim)",
    );
    expect(
      tool("edit_timeline").activity?.({
        operations: [{ op: "remove_clip" }, { op: "add_sequence" }, { op: "set_composition" }],
      })?.label,
    ).toBe("Editing the timeline · 3 changes (remove, add sequence, set length)");
    expect(tool("browse_presets").activity?.({ kind: "caption" })?.label).toBe(
      "Browsing caption presets",
    );
    expect(tool("render_video").activity?.({})?.label).toBe("Rendering video");
  });

  it("never throws on malformed arguments", () => {
    for (const args of [undefined, null, 7, "x", { operations: "no" }, { operations: [null, 3] }]) {
      expect(() => tool("edit_timeline").activity?.(args)).not.toThrow();
    }
    expect(tool("edit_timeline").activity?.(undefined)?.label).toBe("Editing the timeline");
    expect(tool("browse_presets").activity?.({ kind: 5 })?.label).toBe("Browsing presets");
  });
});

const clip = (id: string, overrides: Partial<TimelineClip> = {}): TimelineClip => ({
  id,
  domId: null,
  kind: "video",
  label: `${id}.mp4`,
  start: 0,
  duration: 2,
  end: 2,
  track: 0,
  zIndex: null,
  src: `assets/${id}.mp4`,
  mediaStart: 0,
  sourceDuration: null,
  volume: 1,
  muted: false,
  compositionSrc: null,
  locked: false,
  provenance: null,
  ...overrides,
});

const snapshot = (clips: TimelineClip[]): TimelineSnapshot => ({
  composition: { path: "index.html", width: 1920, height: 1080, duration: 12 },
  version: "v9",
  tracks: [{ index: 0, clipIds: clips.map((entry) => entry.id) }],
  clips,
});

function editing(host = new FakeEditingHost(), editorContext?: EditorContext, turnId?: string) {
  const turn = new AbortController();
  const executor = new TurnEditing({ host, turnSignal: turn.signal, editorContext, turnId });
  const call = (name: string, args: unknown) =>
    executor.execute(name, args, new AbortController().signal);
  return { host, executor, call, turn };
}

describe("editing tool results", () => {
  it("reports created clip ids and the resulting timeline to the model", async () => {
    const { host, call } = editing();
    host.timelineResult = snapshot([clip("c1"), clip("c2", { start: 2, end: 4, track: 1 })]);
    const result = await call("edit_timeline", {
      baseVersion: "v8",
      operations: [
        { op: "add_clip", asset: "assets/a.mp4", start: 0, track: 0 },
        { op: "split_clip", clip: "c1", at: 1 },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(host.applyRequests[0]).toMatchObject({ baseVersion: "v8" });
    expect(result.text).toContain("1. add_clip: clip-101");
    expect(result.text).toContain("2. split_clip: c1 → new clip clip-102b");
    expect(result.text).toContain("id | kind | label | start–end (s) | track | src | notes");
    expect(result.text).toContain("c2 | video | c2.mp4 | 2–4 | 1 | assets/c2.mp4");
  });

  it("stamps the running turn on every batch, replacing any turn id the model sent", async () => {
    const { host, call } = editing(new FakeEditingHost(), undefined, "turn-9");
    const operations = [{ op: "set_composition", duration: 5 }];
    await call("edit_timeline", { operations });
    await call("edit_timeline", { operations, turnId: "turn-of-someone-else" });
    expect(host.applyRequests.map((request) => request.turnId)).toEqual(["turn-9", "turn-9"]);
    expect(host.applyRequests[0]?.operations).toEqual(operations);
  });

  it("reports a service refusal with its code and the failing operation so the model can retry", async () => {
    const { host, call } = editing();
    host.nextApplyError = new EditingError("unknown_clip", 'no clip "ghost"', 1);
    const result = await call("edit_timeline", {
      operations: [
        { op: "set_composition", duration: 5 },
        { op: "remove_clip", clip: "ghost" },
      ],
    });
    expect(result).toEqual({
      isError: true,
      text: 'unknown_clip (operations[1]): no clip "ghost"',
    });
  });

  it("accepts an add_sequence batch and reports the clip count instead of a wall of ids", async () => {
    const { host, call } = editing();
    const ranges = Array.from({ length: 312 }, (_, index) => ({
      from: index * 4,
      to: index * 4 + 3,
    }));
    const result = await call("edit_timeline", {
      operations: [
        { op: "remove_clip", clips: ["old-1", "old-2"] },
        { op: "add_sequence", asset: "assets/talk.mp4", track: 0, ranges, edgeFade: 0.02 },
        { op: "set_composition", duration: 936 },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(host.applyRequests[0]?.operations[1]).toMatchObject({
      op: "add_sequence",
      edgeFade: 0.02,
    });
    expect(result.text).toContain("1. remove_clip: removed 2 clips");
    expect(result.text).toContain("2. add_sequence → 312 clips (first clip-102-1)");
    expect(result.text).not.toContain("clip-102-2");
    expect(result.text).toContain("3. set_composition:");
  });

  it("refuses a malformed add_sequence itself, naming the range, without calling the service", async () => {
    const { host, call } = editing();
    const backwards = await call("edit_timeline", {
      operations: [
        {
          op: "add_sequence",
          asset: "assets/talk.mp4",
          track: 0,
          ranges: [
            { from: 0, to: 2 },
            { from: 9, to: 4 },
          ],
        },
      ],
    });
    expect(backwards.isError).toBe(true);
    expect(backwards.text).toContain("invalid_request (operations[0])");
    expect(backwards.text).toContain("ranges[1]");
    const bothForms = await call("edit_timeline", {
      operations: [{ op: "remove_clip", clip: "a", clips: ["b"] }],
    });
    expect(bothForms.isError).toBe(true);
    expect(host.applyRequests).toHaveLength(0);
  });

  it("refuses malformed batches itself, naming the operation, without calling the service", async () => {
    const { host, call } = editing();
    const unknownOp = await call("edit_timeline", { operations: [{ op: "explode" }] });
    expect(unknownOp.isError).toBe(true);
    expect(unknownOp.text).toContain("invalid_request (operations[0])");
    const badField = await call("edit_timeline", {
      operations: [{ op: "add_clip", asset: "a.mp4", start: -1, track: 0 }],
    });
    expect(badField.text).toContain("start");
    expect((await call("edit_timeline", {})).isError).toBe(true);
    expect((await call("browse_presets", { kind: "lut" })).text).toContain("invalid_request");
    expect((await call("inspect_timeline", { composition: 4 })).isError).toBe(true);
    expect((await call("render_video", { quality: "ultra" })).isError).toBe(true);
    expect(host.applyRequests).toHaveLength(0);
    expect(host.renderRequests).toHaveLength(0);
  });

  it("caps a large timeline and says how much is not shown", async () => {
    const { host, call } = editing();
    host.timelineResult = snapshot(
      Array.from({ length: 400 }, (_, index) => clip(`clip-with-a-long-id-${index}`)),
    );
    const result = await call("inspect_timeline", {});
    expect(result.text.length).toBeLessThanOrEqual(RESULT_CHARS);
    expect(result.text).toMatch(/… \d+ more clips not shown/);
    expect(result.text).toContain("400 clips");
  });

  it("adds the user's playhead and selection, marked as captured when they sent the message", async () => {
    const context: EditorContext = {
      schemaVersion: 1,
      capturedAt: 1,
      project: { id: "p" },
      activeComposition: { path: "index.html" },
      timeline: { duration: 12, elementCount: 1, elements: [] },
      playhead: { time: 3.5, playing: false },
      selection: {
        clips: [{ id: "el-1", hfId: "c1", tag: "video", start: 0, duration: 2, track: 0 }],
        assetPath: null,
        previewElement: null,
        range: { start: 1, end: 2.5 },
      },
      renderSettings: null,
      storyGraph: null,
    };
    const { host, call } = editing(undefined, context);
    host.timelineResult = snapshot([clip("c1")]);
    const { text } = await call("inspect_timeline", {});
    expect(text).toContain("captured when the user sent the message");
    expect(text).toContain("playhead 3.5 s (paused)");
    expect(text).toContain("selected clips c1");
    expect(text).toContain("selected range 1–2.5 s");
    expect((await editing(host).call("inspect_timeline", {})).text).not.toContain("playhead");
  });

  it("lists presets with how to use them and renders with the output path", async () => {
    const { host, call } = editing();
    host.presetResults = [
      {
        name: "karaoke",
        kind: "caption",
        title: "Karaoke",
        description: "Word highlight",
        tags: ["bold"],
        duration: null,
      },
    ];
    const presets = await call("browse_presets", { kind: "caption", query: "word" });
    expect(presets.text).toContain("karaoke");
    expect(presets.text).toContain("apply_captions");
    expect(host.presetRequests).toEqual([{ kind: "caption", query: "word" }]);
    const render = await call("render_video", { quality: "draft" });
    expect(render.text).toContain("renders/final.mp4");
    expect(render.text).toContain("12 s");
    expect(host.renderRequests).toEqual([{ quality: "draft" }]);
  });

  it("closes for good after shutdown", async () => {
    const { host, executor, call } = editing();
    await executor.shutdown();
    const result = await call("edit_timeline", {
      operations: [{ op: "set_composition", duration: 5 }],
    });
    expect(result.isError).toBe(true);
    expect(host.applyRequests).toHaveLength(0);
  });
});
