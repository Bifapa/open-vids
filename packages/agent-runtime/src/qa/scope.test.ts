import { describe, expect, it } from "vitest";
import type { QaAcceptedIssue, TimelineClip, TimelineSnapshot } from "@hyperframes/agent-protocol";
import { EditingError } from "../editing/host.js";
import { createRuntimeFixture, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { cleanCheck, qaDraft, timelineCheck } from "../testing/qa.js";
import {
  directorScript,
  finding,
  qaChat,
  quality,
  script,
  settled,
  visionScript,
} from "./harness.js";
import { QaToolError } from "./host.js";

function clip(id: string, kind: TimelineClip["kind"], overrides: Partial<TimelineClip> = {}) {
  const base: TimelineClip = {
    id,
    domId: null,
    kind,
    label: id,
    start: 0,
    duration: 4,
    end: 4,
    track: kind === "audio" ? 1 : 0,
    zIndex: null,
    src: kind === "audio" ? "assets/music.mp3" : `assets/${id}.mp4`,
    mediaStart: 0,
    sourceDuration: 20,
    volume: 1,
    muted: false,
    compositionSrc: null,
    locked: false,
    provenance: null,
  };
  return { ...base, ...overrides };
}

function timeline(clips: TimelineClip[], duration = 12): TimelineSnapshot {
  return {
    composition: { path: "index.html", width: 1920, height: 1080, duration },
    version: "v1",
    tracks: [],
    clips,
  };
}

/** The project before the turn: a talking head and music. The Director's first prompt then edits it. */
function edit(fixture: RuntimeFixture, clips: TimelineClip[], duration = 12) {
  fixture.editing.timelineResult = timeline(clips, duration);
  fixture.qa.bump();
}

const TALK = clip("talk", "video");
const MUSIC = clip("music", "audio");

describe("what a QA pass checks", () => {
  it("skips the visual review after an audio-only change and says why", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.timelineResult = timeline([TALK, MUSIC]);
      const chatId = await qaChat(fixture, quality(2));
      const director = directorScript(fixture, {
        first: async () => edit(fixture, [TALK, MUSIC, clip("sfx", "audio", { start: 2 })]),
      });
      script(fixture, { director: director.run, vision: visionScript([finding()]) });
      await fixture.turns.start(chatId, { prompt: "Add a whoosh" });
      await settled(fixture, chatId);

      expect(fixture.backend.sessionsOf("vision")).toEqual([]);
      expect(fixture.qa.frameRequests).toEqual([]);
      expect(fixture.qa.reports[0]).toMatchObject({
        scope: "deterministic",
        scopeNote: { code: "audio_only" },
        vision: { status: "skipped", reasonCode: "vision_audio_only", frames: 0 },
      });
      // The render and its deterministic checks still ran.
      expect(fixture.qa.checkRequests).toHaveLength(1);
      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
        status: "passed",
        scope: "deterministic",
        passes: [{ scope: "deterministic", scopeNote: { code: "audio_only" }, vision: "skipped" }],
      });
      expect(director.seen.finals[0]).toContain("The visual review was skipped");
    } finally {
      await fixture.cleanup();
    }
  });

  it("skips the visual review when a couple of clips were only retimed, and reviews anything bigger", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.timelineResult = timeline([TALK, MUSIC]);
      const small = await qaChat(fixture, quality(1));
      const retime = directorScript(fixture, {
        first: async () => edit(fixture, [clip("talk", "video", { start: 1, end: 5 }), MUSIC]),
      });
      script(fixture, { director: retime.run, vision: visionScript([]) });
      await fixture.turns.start(small, { prompt: "Nudge the talk" });
      await settled(fixture, small);
      expect(fixture.qa.reports[0]).toMatchObject({
        scope: "deterministic",
        scopeNote: { code: "small_change", params: { count: 1 } },
        vision: { status: "skipped", reasonCode: "vision_small_change" },
      });
      expect(fixture.backend.sessionsOf("vision")).toEqual([]);

      // A new picture is not a retiming: Vision looks.
      const fresh = await createRuntimeFixture();
      try {
        fresh.editing.timelineResult = timeline([TALK, MUSIC]);
        const big = await qaChat(fresh, quality(1));
        const broll = directorScript(fresh, {
          first: async () => edit(fresh, [TALK, MUSIC, clip("broll", "video", { track: 2 })]),
        });
        script(fresh, { director: broll.run, vision: visionScript([]) });
        await fresh.turns.start(big, { prompt: "Add B-roll" });
        await settled(fresh, big);
        expect(fresh.qa.reports[0]).toMatchObject({ scope: "full", vision: { status: "ran" } });
        expect(fresh.qa.reports[0]?.scopeNote).toBeUndefined();
      } finally {
        await fresh.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("reviews a change nobody can size (captions or styles changed, no clip did) and the first turn of an unknown project", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.timelineResult = timeline([TALK, MUSIC]);
      const chatId = await qaChat(fixture, quality(1));
      // The project changed (fingerprint) but no clip did.
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Restyle the captions" });
      await settled(fixture, chatId);
      expect(fixture.qa.reports[0]).toMatchObject({ scope: "full", vision: { status: "ran" } });
    } finally {
      await fixture.cleanup();
    }
  });

  it("re-checks a small correction without Vision, but keeps Vision for a fix that still waits for its look", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.timelineResult = timeline([TALK, MUSIC]);
      const chatId = await qaChat(fixture, quality(3));
      // Pass 1 (big change) finds a black stretch; the correction only retimes one clip.
      fixture.qa.checkResults = [
        cleanCheck({ issues: [qaDraft({ subject: "c2" })] }),
        cleanCheck(),
      ];
      const director = directorScript(fixture, {
        first: async () => edit(fixture, [TALK, MUSIC, clip("broll", "video", { track: 2 })]),
        correction: async () =>
          edit(fixture, [TALK, MUSIC, clip("broll", "video", { track: 2, start: 1, end: 5 })]),
      });
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Add B-roll" });
      await settled(fixture, chatId);

      expect(fixture.qa.reports.map((report) => report.scope)).toEqual(["full", "deterministic"]);
      expect(fixture.qa.reports[1]?.scopeNote).toMatchObject({ code: "small_change" });
      expect(fixture.backend.sessionsOf("vision")[0]?.prompts).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }

    const waiting = await createRuntimeFixture();
    try {
      waiting.editing.timelineResult = timeline([TALK, MUSIC]);
      const chatId = await qaChat(waiting, quality(3));
      waiting.qa.checkResults = [cleanCheck(), cleanCheck()];
      const director = directorScript(waiting, {
        first: async () => edit(waiting, [TALK, MUSIC, clip("broll", "video", { track: 2 })]),
        correction: async () =>
          edit(waiting, [TALK, MUSIC, clip("broll", "video", { track: 2, start: 1, end: 5 })]),
      });
      let calls = 0;
      const first = visionScript([finding()]);
      script(waiting, {
        director: director.run,
        vision: async (input, session) => {
          calls += 1;
          return calls === 1 ? first(input, session) : visionScript([])(input, session);
        },
      });
      await waiting.turns.start(chatId, { prompt: "Add B-roll" });
      await settled(waiting, chatId);
      // The B-roll finding of pass 1 is open and fixable: pass 2 must look again, whatever the size of the change.
      expect(waiting.qa.reports.map((report) => report.scope)).toEqual(["full", "full"]);
      expect(waiting.qa.reports[1]?.resolved.map((issue) => issue.id)).toEqual(["p1-1"]);
    } finally {
      await waiting.cleanup();
    }
  });
});

describe("timeline-only checks", () => {
  it("never renders a long composition, carries render findings it cannot re-check, and never calls them fixed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.timelineResult = timeline([TALK, MUSIC], 100);
      const chatId = await qaChat(fixture, quality(3));
      // Pass 1 (short enough) renders and finds black; the correction stretches the composition past 3 minutes.
      fixture.qa.checkResults = [cleanCheck({ issues: [qaDraft({ subject: "c2" })] })];
      const director = directorScript(fixture, {
        first: async () => edit(fixture, [TALK, MUSIC, clip("broll", "video", { track: 2 })], 100),
        correction: async () =>
          edit(fixture, [TALK, MUSIC, clip("broll", "video", { track: 2 })], 400),
      });
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Add B-roll" });
      await settled(fixture, chatId);

      expect(fixture.qa.reports.map((report) => report.scope)).toEqual(["full", "timeline"]);
      expect(fixture.editing.renderRequests).toHaveLength(1);
      const second = fixture.qa.reports[1];
      expect(second?.render).toBeNull();
      expect(second?.resolved).toEqual([]);
      expect(second?.issues).toMatchObject([
        { id: "p1-1", status: "persisting", notRechecked: true, fixable: false },
      ]);
      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
        status: "issues_remain",
        reasonCode: "not_rechecked",
        scope: "timeline",
      });
      expect(director.seen.finals[0]).toContain("NOT re-checked");
    } finally {
      await fixture.cleanup();
    }
  });

  it("runs the correction loop on timeline findings of a long composition, without a render", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.timelineResult = timeline([TALK], 400);
      const chatId = await qaChat(fixture, quality(2));
      const flash = qaDraft({
        kind: "awkward_cut",
        source: "timeline",
        check: "timeline.flash_clip",
        subject: "c9",
        message: "A flash clip.",
      });
      fixture.qa.timelineCheckResults = [timelineCheck({ issues: [flash] }), timelineCheck()];
      const director = directorScript(fixture);
      script(fixture, { director: director.run });
      await fixture.turns.start(chatId, { prompt: "Tighten the talk" });
      await settled(fixture, chatId);

      expect(director.seen.corrections).toHaveLength(1);
      expect(director.seen.corrections[0]).toContain(
        "checked the timeline in pass 1 of 2 without rendering",
      );
      expect(fixture.editing.renderRequests).toEqual([]);
      expect(fixture.qa.timelineCheckRequests).toHaveLength(2);
      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("passed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("falls back to the timeline checks when the render checks run out of time, instead of failing", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      fixture.qa.checkResults = [
        new QaToolError("timeout", "The render checks did not finish in time."),
      ];
      fixture.qa.timelineCheckResults = [
        timelineCheck({
          issues: [
            qaDraft({
              kind: "awkward_cut",
              source: "timeline",
              check: "timeline.flash_clip",
              subject: "c9",
            }),
          ],
        }),
        timelineCheck(),
      ];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Tighten the talk" });
      await settled(fixture, chatId);

      const [first] = fixture.qa.reports;
      expect(first).toMatchObject({
        scope: "timeline",
        scopeNote: { code: "check_timeout" },
        // The render happened; its checks did not finish.
        render: { path: "renders/final.mp4" },
        vision: { status: "skipped", reasonCode: "vision_timeline_only" },
      });
      expect(first?.checks).toEqual(
        expect.arrayContaining([
          {
            id: "render",
            status: "ran",
            detail: "The composition was rendered, but its render checks did not finish in time.",
          },
          expect.objectContaining({ id: "black_frames", status: "failed" }),
          expect.objectContaining({ id: "audio", status: "failed" }),
          { id: "timeline", status: "ran", detail: null },
        ]),
      );
      expect(fixture.chats.get(chatId)?.turns[0]?.status).toBe("completed");
      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({ scope: "timeline" });
      expect(director.seen.corrections).toHaveLength(1);
      // The correction prompt says the composition WAS rendered, not that nothing was.
      expect(director.seen.corrections[0]).toContain("the composition was rendered");
      expect(director.seen.corrections[0]).not.toContain("nothing was rendered");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails the pass when the timeout fallback cannot run either", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      fixture.qa.checkResults = [
        new QaToolError("timeout", "The render checks did not finish in time."),
      ];
      fixture.qa.timelineCheckResults = [new QaToolError("studio_unavailable", "Studio is down")];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Tighten the talk" });
      await settled(fixture, chatId);
      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
        status: "failed",
        reason: expect.stringContaining("timed out and the timeline checks failed too"),
      });
      expect(fixture.qa.reports).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("render failures", () => {
  it("ends QA at once, with the real reason, when the machine or Studio could not render", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(3));
      fixture.editing.renderQueue = [
        new EditingError("render_failed", "ffmpeg was not found on PATH"),
      ];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Add B-roll" });
      await settled(fixture, chatId);

      // No correction asked for: nothing in the project causes it.
      expect(director.seen.corrections).toEqual([]);
      expect(fixture.editing.renderRequests).toHaveLength(1);
      expect(fixture.qa.reports).toEqual([]);
      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
        status: "failed",
        reasonCode: "render_environment",
        reasonParams: { reason: "ffmpeg was not found on PATH" },
        reason: expect.stringContaining("not from the project"),
        passes: [{ phase: "failed", error: expect.stringContaining("ffmpeg was not found") }],
      });
      expect(director.seen.finals[0]).toContain('outcome="failed"');
      expect(director.seen.finals[0]).toContain("ffmpeg was not found");
      expect(fixture.chats.get(chatId)?.turns[0]?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("still sends a broken composition to a correction", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      fixture.editing.renderQueue = [new EditingError("render_failed", "clip hf-3 has no source")];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Add B-roll" });
      await settled(fixture, chatId);
      expect(director.seen.corrections).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("issues the user marked intentional", () => {
  const accepted = (overrides: Partial<QaAcceptedIssue> = {}): QaAcceptedIssue => ({
    id: "acc-0a1b2c3d",
    composition: "index.html",
    kind: "black_frames",
    check: "blackdetect",
    subject: null,
    start: 4,
    end: 5,
    message: "Black picture for 1 s.",
    acceptedAt: 1,
    ...overrides,
  });

  it("leaves them out of the pass, counts them, tells Vision and the Director, and does not ask for a fix", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      fixture.qa.acceptedItems = [
        accepted(),
        accepted({
          id: "acc-0a1b2c3e",
          kind: "incorrect_broll",
          start: 5,
          end: 7,
          subject: "c2",
          message: "Wrong B-roll.",
        }),
      ];
      fixture.qa.checkResults = [cleanCheck({ issues: [qaDraft()] })];
      const director = directorScript(fixture);
      let task = "";
      script(fixture, {
        director: director.run,
        vision: async (input, session) => {
          task = input.text;
          return visionScript([finding({ subject: "c2" })])(input, session);
        },
      });
      await fixture.turns.start(chatId, { prompt: "Add B-roll" });
      await settled(fixture, chatId);

      // Both the deterministic issue and Vision's finding are accepted: nothing is left to fix.
      expect(fixture.qa.reports).toHaveLength(1);
      expect(fixture.qa.reports[0]).toMatchObject({ issues: [], suppressed: 2 });
      expect(director.seen.corrections).toEqual([]);
      expect(task).toContain("The user marked these as intentional");
      expect(task).toContain("Wrong B-roll.");
      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
        status: "passed",
        passes: [{ suppressed: 2 }],
      });
      expect(director.seen.finals[0]).toContain(
        "2 issues the user marked intentional were left out",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("matches by time as well: another stretch of the same kind is still reported", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(1));
      fixture.qa.acceptedItems = [accepted()];
      fixture.qa.checkResults = [
        cleanCheck({ issues: [qaDraft({ start: 4, end: 5 }), qaDraft({ start: 30, end: 31 })] }),
      ];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Add B-roll" });
      await settled(fixture, chatId);
      expect(fixture.qa.reports[0]?.issues).toMatchObject([{ start: 30, end: 31 }]);
      expect(fixture.qa.reports[0]?.suppressed).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("ignores another composition's marks and an unreadable list", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(1));
      fixture.qa.acceptedItems = [accepted({ composition: "scenes/intro.html" })];
      fixture.qa.checkResults = [cleanCheck({ issues: [qaDraft()] })];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Add B-roll" });
      await settled(fixture, chatId);
      expect(fixture.qa.reports[0]).toMatchObject({
        suppressed: 0,
        issues: [{ kind: "black_frames" }],
      });

      const broken = await createRuntimeFixture();
      try {
        const brokenChat = await qaChat(broken, quality(1));
        broken.qa.acceptedError = new QaToolError("studio_unavailable", "down");
        broken.qa.checkResults = [cleanCheck({ issues: [qaDraft()] })];
        const again = directorScript(broken);
        script(broken, { director: again.run, vision: visionScript([]) });
        await broken.turns.start(brokenChat, { prompt: "Add B-roll" });
        await settled(broken, brokenChat);
        expect(broken.qa.reports[0]?.issues).toHaveLength(1);
        expect(broken.chats.get(brokenChat)?.turns[0]?.qa?.status).toBe("issues_remain");
      } finally {
        await broken.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("the QA card's live state", () => {
  it("forwards the render's progress into the pass and clears it when the render is done", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(1));
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Add B-roll" });
      await settled(fixture, chatId);

      const progress = fixture.chats
        .events(chatId)
        .flatMap((event) => (event.type === "qa.updated" ? [event.qa.passes[0]?.progress] : []))
        .filter((entry) => entry !== undefined);
      expect(progress).toEqual([
        { percent: 0, stage: "starting" },
        { percent: 100, stage: "done" },
      ]);
      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.passes[0]?.progress).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it("marks which passes' renders are still in the project once the session ended", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      fixture.editing.renderQueue = [
        {
          path: "renders/qa-1.mp4",
          bytes: 1,
          duration: 12,
          width: 1920,
          height: 1080,
          videoCodec: "h264",
          hasAudio: true,
        },
        {
          path: "renders/qa-2.mp4",
          bytes: 1,
          duration: 12,
          width: 1920,
          height: 1080,
          videoCodec: "h264",
          hasAudio: true,
        },
      ];
      // The service deletes the first preview and keeps the last.
      fixture.qa.finishRemoved = ["renders/qa-1.mp4"];
      fixture.qa.checkResults = [
        cleanCheck({ issues: [qaDraft({ subject: "c2" })] }),
        cleanCheck(),
      ];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Add B-roll" });
      await settled(fixture, chatId);

      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.passes).toMatchObject([
        { renderPath: "renders/qa-1.mp4", renderKept: false },
        { renderPath: "renders/qa-2.mp4", renderKept: true },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});
