// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import type { VoiceTake } from "@hyperframes/agent-protocol";
import type { TimelineElement } from "../../player";
import { patchVoiceClipSource, takeClipAttributes } from "./voiceClipPatch";
import { resolveCarveAvailability, resolveVoiceLineTrack } from "./voicePlacement";
import { applyPlanToElements, planVoiceTakes } from "./voiceTakePlan";

function take(overrides: Partial<VoiceTake> = {}): VoiceTake {
  return {
    id: "t2",
    file: "assets/voice/line-b2c3d4e5.wav",
    start: 0,
    end: 4.5,
    speakerText: "Hello",
    style: "",
    presetId: "p",
    model: "m",
    voiceId: "Kore",
    requestHash: "h",
    scene: null,
    usdCost: 0.001,
    createdAt: 1,
    createdBy: { agent: "user", turnId: null },
    ...overrides,
  };
}

function clip(id: string, start: number, duration: number, extra: Partial<TimelineElement> = {}) {
  return {
    id,
    key: id,
    domId: id,
    tag: "audio",
    start,
    duration,
    track: 2,
    authoredTrack: 2,
    sourceFile: "index.html",
    ...extra,
  } satisfies TimelineElement;
}

const SOURCE = `<div data-composition-id="main" data-duration="9">
<audio id="a" data-hf-id="hf-a" class="clip" src="assets/voice/line-old.wav" data-start="0" data-duration="3" data-track-index="2" data-media-start="1.5" data-ov-voice-line="l1"></audio>
<audio id="b" data-hf-id="hf-b" class="clip" src="assets/voice/other.wav" data-start="3" data-duration="2" data-track-index="2"></audio>
</div>`;

describe("take → clip attributes", () => {
  it("writes the file relative to the composition, the in-point and the length", () => {
    const attributes = takeClipAttributes(
      take({ start: 2, end: 6.25, file: "assets/voice/scene one.wav" }),
      clip("a", 0, 3),
      "scenes/intro.html",
    );
    expect(attributes).toEqual({
      src: "../assets/voice/scene%20one.wav",
      mediaStart: { attribute: "data-media-start", value: "2" },
      duration: 4.25,
    });
  });

  it("resets an old in-point when the new take starts at 0, and writes none for a clip that had none", () => {
    const hadOne = takeClipAttributes(
      take(),
      clip("a", 0, 3, { playbackStart: 1.5 }),
      "index.html",
    );
    expect(hadOne.mediaStart).toEqual({ attribute: "data-media-start", value: "0" });
    expect(takeClipAttributes(take(), clip("a", 0, 3), "index.html").mediaStart).toBeNull();
  });

  it("patches src, in-point and length on the clip's own tag, and grows the composition", () => {
    const attributes = takeClipAttributes(
      take({ start: 0.5, end: 8 }),
      clip("a", 0, 3, { playbackStart: 1.5 }),
      "index.html",
    );
    const patched = patchVoiceClipSource(SOURCE, { id: "a" }, attributes);
    expect(patched).toContain('src="assets/voice/line-b2c3d4e5.wav"');
    expect(patched).toContain('data-media-start="0.5"');
    expect(patched).toMatch(/id="a"[^>]*data-duration="7.5"/);
    // The composition follows the furthest clip end, like every other clip edit.
    expect(patched).toContain('data-composition-id="main" data-duration="7.5"');
    expect(patchVoiceClipSource(patched, { id: "a" }, attributes)).toBe(patched);
  });
});

describe("planVoiceTakes", () => {
  const a = clip("a", 0, 3, { voiceLine: "l1" });
  const b = clip("b", 3, 2);
  const apps = [{ lineId: "l1", take: take() }];
  const options = { rippleEnabled: true, compositionPathOf: () => "index.html" };

  it("shifts the later clips of the track by the difference while ripple is on", () => {
    const plan = planVoiceTakes([a, b], apps, options);
    expect(plan.clips.map((c) => [c.element.id, c.attributes.duration])).toEqual([["a", 4.5]]);
    expect(plan.shifts.map((s) => [s.element.id, s.start])).toEqual([["b", 4.5]]);
    const next = applyPlanToElements([a, b], plan, true);
    expect(next.map((e) => [e.id, e.start, e.duration])).toEqual([
      ["a", 0, 4.5],
      ["b", 4.5, 2],
    ]);
  });

  it("changes only the clip while ripple is off", () => {
    const plan = planVoiceTakes([a, b], apps, { ...options, rippleEnabled: false });
    expect(plan.shifts).toEqual([]);
    expect(plan.blockedBy).toEqual([]);
  });

  it("refuses the whole change when a later clip is locked and ripple is on", () => {
    const locked = clip("b", 3, 2, { timelineLocked: true });
    const plan = planVoiceTakes([a, locked], apps, options);
    expect(plan.clips).toEqual([]);
    expect(plan.shifts).toEqual([]);
    expect(plan.blockedBy.map((clip) => clip.id)).toEqual(["b"]);
    expect(plan.blockedLines).toEqual(["l1"]);
    // Ripple off: the same locked clip is not in the way.
    const free = planVoiceTakes([a, locked], apps, { ...options, rippleEnabled: false });
    expect(free.clips).toHaveLength(1);
    expect(free.blockedBy).toEqual([]);
  });

  it("skips a line with no clip and a line whose clips are all locked", () => {
    const lockedVoice = clip("c", 0, 3, { voiceLine: "l2", timelineLocked: true });
    const plan = planVoiceTakes(
      [a, lockedVoice],
      [
        { lineId: "none", take: take() },
        { lineId: "l2", take: take() },
      ],
      options,
    );
    expect(plan.skipped).toEqual([
      { lineId: "none", reason: "no-clips" },
      { lineId: "l2", reason: "locked" },
    ]);
    expect(plan.clips).toEqual([]);
  });
});

describe("placement and carve availability", () => {
  it("prefers a free voiceover track, then another free audio track, then a new one", () => {
    const voice = clip("v", 0, 3, { voiceLine: "l1", track: 5, authoredTrack: 5 });
    const music = clip("m", 0, 30, { track: 4, authoredTrack: 4, domId: "music" });
    const picture = clip("p", 0, 30, { tag: "video", track: 0, authoredTrack: 0 });
    const all = [picture, music, voice];
    expect(resolveVoiceLineTrack(all, { start: 4, duration: 2 })).toBe(5);
    // Busy voiceover track and busy music track: a new track below everything.
    expect(resolveVoiceLineTrack(all, { start: 1, duration: 2 })).toBe(6);
    expect(resolveVoiceLineTrack([], { start: 0, duration: 1 })).toBe(0);
    expect(resolveVoiceLineTrack([picture], { start: 0, duration: 1 })).toBe(1);
  });

  it("names why the carve cannot run", () => {
    const voice = clip("v", 0, 3, { voiceLine: "l1" });
    const music = clip("bgm", 0, 30, { domId: "bgm-loop", track: 3, authoredTrack: 3 });
    expect(resolveCarveAvailability([music]).kind).toBe("no-voice");
    expect(resolveCarveAvailability([voice]).kind).toBe("no-music");
    const ready = resolveCarveAvailability([voice, music]);
    expect(ready.kind === "ready" && ready.beds.map((bed) => bed.id)).toEqual(["bgm"]);
  });

  it("takes a long audio clip named after its file for a bed, but not a short effect", () => {
    const voice = clip("v", 0, 3, { voiceLine: "l1" });
    // A Story build names the music clip after its file (seen live: "parallel-universe-cc0"), and the preview URL
    // carries a project name that says "voice".
    const named = clip("bed", 0, 26, {
      domId: "parallel-universe-cc0",
      src: "http://127.0.0.1:5190/api/projects/my-voice-story/preview/assets/parallel-universe-cc0.mp3",
      track: 4,
      authoredTrack: 4,
    });
    const blip = clip("blip", 2, 1.2, { domId: "ding-02", track: 5, authoredTrack: 5 });
    const ready = resolveCarveAvailability([voice, named, blip]);
    expect(ready.kind === "ready" && ready.beds.map((bed) => bed.id)).toEqual(["bed"]);
  });
});
