import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineSnapshot } from "@hyperframes/agent-protocol";
import { EditingError } from "../editing/host.js";
import { summarizeChange, visionSkipReason } from "./changeScope.js";
import { qaPhaseRefusal } from "./phase.js";
import { classifyRenderFailure } from "./renderFailure.js";
import { qaToolsFor } from "./tools.js";

const clip = (id: string, kind: TimelineClip["kind"], overrides: Partial<TimelineClip> = {}) => ({
  id,
  domId: null,
  kind,
  label: id,
  start: 0,
  duration: 4,
  end: 4,
  track: 0,
  zIndex: null,
  src: `assets/${id}`,
  mediaStart: 0,
  sourceDuration: 20,
  volume: 1,
  muted: false,
  compositionSrc: null,
  locked: false,
  provenance: null,
  ...overrides,
});

const snapshot = (clips: TimelineClip[], width = 1920): TimelineSnapshot => ({
  composition: { path: "index.html", width, height: 1080, duration: 12 },
  version: "v1",
  tracks: [],
  clips,
});

describe("summarizeChange and the cheap path", () => {
  const talk = clip("talk", "video");
  const music = clip("music", "audio");

  it("sizes what changed clip by clip", () => {
    const before = snapshot([talk, music]);
    expect(summarizeChange(before, before)).toEqual({
      changed: 0,
      audioOnly: false,
      retimed: 0,
      pictureChanged: false,
    });
    expect(
      summarizeChange(before, snapshot([clip("talk", "video", { start: 1, end: 5 }), music])),
    ).toEqual({ changed: 1, audioOnly: false, retimed: 1, pictureChanged: false });
    expect(
      summarizeChange(before, snapshot([talk, clip("music", "audio", { volume: 0.4 })])),
    ).toEqual({ changed: 1, audioOnly: true, retimed: 0, pictureChanged: false });
    expect(summarizeChange(before, snapshot([talk, music, clip("sfx", "audio")]))).toEqual({
      changed: 1,
      audioOnly: true,
      retimed: 0,
      pictureChanged: true,
    });
    expect(summarizeChange(before, snapshot([music]))).toEqual({
      changed: 1,
      audioOnly: false,
      retimed: 0,
      pictureChanged: true,
    });
    // A clip that now plays another file is new content, not a retiming.
    expect(
      summarizeChange(before, snapshot([clip("talk", "video", { src: "assets/other" }), music])),
    ).toMatchObject({ changed: 1, retimed: 0, pictureChanged: true });
  });

  it("counts only start and duration as a retiming; whatever else the picture shows forces the full review", () => {
    const before = snapshot([talk, music, clip("b", "video")]);
    const retimedTalk = clip("talk", "video", { start: 1, end: 5 });
    for (const changes of [
      { track: 3 },
      { zIndex: 4 },
      { mediaStart: 2 },
      { opacity: 0.1 },
      { colorGrade: "noir" },
      { playbackRate: 2 },
    ] satisfies Partial<TimelineClip>[]) {
      const label = JSON.stringify(changes);
      // Alone, and next to a retimed neighbour that used to hide it.
      const alone = summarizeChange(before, snapshot([talk, music, clip("b", "video", changes)]));
      expect(alone, label).toMatchObject({ retimed: 0, pictureChanged: true });
      expect(visionSkipReason(alone), label).toBeNull();
      const paired = summarizeChange(
        before,
        snapshot([retimedTalk, music, clip("b", "video", changes)]),
      );
      expect(paired, label).toMatchObject({ retimed: 1, pictureChanged: true });
      expect(visionSkipReason(paired), label).toBeNull();
    }
    // Volume, muting and locking show nothing: neither a retiming nor a picture change.
    const quiet = summarizeChange(
      before,
      snapshot([
        retimedTalk,
        music,
        clip("b", "video", { volume: 0.2, muted: true, locked: true }),
      ]),
    );
    expect(quiet).toMatchObject({ changed: 2, retimed: 1, pictureChanged: false });
    expect(visionSkipReason(quiet)).toBe("small_change");
  });

  it("cannot compare different canvases or compositions", () => {
    expect(summarizeChange(snapshot([talk]), snapshot([talk], 1080))).toBeNull();
  });

  it("skips the visual review only for audio-only and small retiming changes", () => {
    const before = snapshot([talk, music, clip("b", "video"), clip("c", "video")]);
    const retimed = (ids: string[]) =>
      snapshot(
        before.clips.map((entry) =>
          ids.includes(entry.id) ? { ...entry, start: entry.start + 1, end: entry.end + 1 } : entry,
        ),
      );
    expect(visionSkipReason(null)).toBeNull();
    expect(visionSkipReason(summarizeChange(before, before))).toBeNull();
    expect(visionSkipReason(summarizeChange(before, retimed(["music"])))).toBe("audio_only");
    expect(visionSkipReason(summarizeChange(before, retimed(["talk"])))).toBe("small_change");
    expect(visionSkipReason(summarizeChange(before, retimed(["talk", "b"])))).toBe("small_change");
    expect(visionSkipReason(summarizeChange(before, retimed(["talk", "b", "c"])))).toBeNull();
  });
});

describe("classifyRenderFailure", () => {
  it("blames the machine for missing tools, full disks, dead browsers and a lost Studio", () => {
    for (const message of [
      "ffmpeg was not found on PATH",
      "ENOSPC: no space left on device, write",
      "Chrome could not be launched",
      "The render progress stream ended unexpectedly.",
      "spawn ffprobe ENOENT",
      "Studio could not report render progress (502).",
    ]) {
      expect(classifyRenderFailure(new EditingError("render_failed", message))).toEqual({
        kind: "environment",
        reason: message,
      });
    }
    expect(
      classifyRenderFailure(new EditingError("unavailable", "Studio did not answer")),
    ).toMatchObject({
      kind: "environment",
    });
  });

  it("reads everything else as the project's, so a broken composition still gets corrected", () => {
    for (const message of [
      "clip hf-3 has no source",
      "The composition has an invalid data-duration",
      "Timeline element c4 refers to a missing asset",
    ]) {
      expect(classifyRenderFailure(new Error(message))).toEqual({
        kind: "project",
        reason: message,
      });
    }
    expect(classifyRenderFailure("")).toEqual({ kind: "project", reason: "The render failed" });
  });
});

describe("the review tools and phases", () => {
  it("gives inspect_render and report_render_findings to Vision, and to the Director only without Vision", () => {
    const tools = ["inspect_render", "report_render_findings"];
    expect(qaToolsFor("vision", ["editor", "vision"])).toEqual(tools);
    expect(qaToolsFor("director", ["editor", "vision"])).toEqual([]);
    expect(qaToolsFor("director", ["editor"])).toEqual(tools);
    expect(qaToolsFor("director", [])).toEqual(tools);
    expect(qaToolsFor("editor", [])).toEqual([]);
    expect(qaToolsFor("jev", [])).toEqual([]);
  });

  it("lets a review look and report, and refuses everything that changes the project", () => {
    for (const tool of ["edit_timeline", "render_video", "delegate", "import_asset", "build_story"])
      expect(qaPhaseRefusal("review", tool)).toContain("refused during a Render QA review");
    for (const tool of [
      "inspect_render",
      "report_render_findings",
      "inspect_timeline",
      "read_story",
    ])
      expect(qaPhaseRefusal("review", tool)).toBeNull();
    expect(qaPhaseRefusal("review", "record_website")).toContain("record_website");
  });

  it("refuses the long analysis jobs in a review, and reads stay open", () => {
    for (const tool of [
      "analyze_media",
      "inspect_frames",
      "plan_cut",
      "save_segments",
      "save_vision_notes",
    ]) {
      expect(qaPhaseRefusal("review", tool), tool).toContain("refused during a Render QA review");
      expect(qaPhaseRefusal("correction", tool), tool).toBeNull();
      expect(qaPhaseRefusal(null, tool), tool).toBeNull();
    }
    for (const tool of ["read_analysis", "read_transcript"])
      expect(qaPhaseRefusal("review", tool), tool).toBeNull();
  });
});
