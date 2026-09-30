import { describe, expect, it } from "vitest";
import type {
  AgentId,
  ChatMode,
  SpecialistId,
  StoryAction,
  StoryActionOptions,
} from "@hyperframes/agent-protocol";
import { buildHostTools } from "../agents/tools.js";
import {
  FakeStoryHost,
  chapterNode,
  sampleBuildResult,
  sampleRebuildResult,
  sampleSyncReport,
  storyGraph,
  storyView,
  userEditedStory,
  userTrim,
} from "../testing/story.js";
import { TurnStory } from "./executor.js";
import { formatStory } from "./format.js";
import { StoryToolError } from "./host.js";
import { STORY_TOOL_NAMES, timelineWritesAllowed } from "./tools.js";

const TIMELINE_WRITERS = ["edit_timeline", "render_video", "build_rough_cut"];
const STORY_TOOLS = Object.values<string>(STORY_TOOL_NAMES);
const TEAM: SpecialistId[] = ["editor", "vision", "motion", "audio", "research"];
const AGENTS: AgentId[] = ["director", "editor", "vision", "motion", "audio", "research", "jev"];

interface Turn {
  mode: ChatMode;
  storyAction?: StoryAction | null;
}

function toolsOf(agent: AgentId, enabled: SpecialistId[], turn: Turn, story = true): string[] {
  return buildHostTools(
    agent,
    { enabled, jev: true, editing: true, analysis: true, story, ...turn },
    async () => ({ text: "" }),
  ).map((tool) => tool.name);
}

const storyToolsOf = (agent: AgentId, enabled: SpecialistId[], turn: Turn) =>
  toolsOf(agent, enabled, turn).filter((name) => STORY_TOOLS.includes(name));

describe("story tool availability", () => {
  for (const action of [null, "review"] as const) {
    it(`gives nobody a timeline-writing tool in a story ${action ?? "plan"} turn, and edit_story only to the Director`, () => {
      for (const enabled of [TEAM, []]) {
        for (const agent of AGENTS) {
          const names = toolsOf(agent, enabled, { mode: "story", storyAction: action });
          expect(names.filter((name) => TIMELINE_WRITERS.includes(name))).toEqual([]);
          expect(names.includes("build_story")).toBe(false);
          expect(names.includes("rebuild_story")).toBe(false);
          expect(names.includes("edit_story")).toBe(agent === "director");
          expect(names.includes("read_story")).toBe(agent !== "jev");
        }
      }
      // Analysis and read-only editing tools stay: planning needs the cached analysis.
      const director = toolsOf("director", [], { mode: "story", storyAction: action });
      expect(director).toEqual(
        expect.arrayContaining([
          "analyze_media",
          "plan_cut",
          "inspect_project",
          "inspect_timeline",
          "browse_presets",
        ]),
      );
    });
  }

  it("gives build_story to the Editor in a build turn, or to the Director when no Editor is enabled", () => {
    const build: Turn = { mode: "story", storyAction: "build" };
    expect(storyToolsOf("director", TEAM, build)).toEqual(["read_story"]);
    expect(storyToolsOf("editor", TEAM, build)).toEqual(["read_story", "build_story"]);
    for (const agent of ["vision", "motion", "audio", "research"] as const) {
      expect(storyToolsOf(agent, TEAM, build)).toEqual(["read_story"]);
    }
    expect(storyToolsOf("jev", TEAM, build)).toEqual([]);

    const solo = ["vision", "motion"] satisfies SpecialistId[];
    expect(storyToolsOf("director", solo, build)).toEqual(["read_story", "build_story"]);
    expect(storyToolsOf("editor", solo, build)).toEqual(["read_story", "build_story"]);
  });

  it("keeps the normal editing tools in a build turn, and never lets the graph change while it compiles", () => {
    const build: Turn = { mode: "story", storyAction: "build" };
    const editor = toolsOf("editor", TEAM, build);
    expect(editor).toEqual(
      expect.arrayContaining(["edit_timeline", "render_video", "build_rough_cut"]),
    );
    expect(toolsOf("director", [], build)).toEqual(expect.arrayContaining(["edit_timeline"]));
    expect(toolsOf("director", [], build)).not.toContain("edit_story");
  });

  it("gives rebuild_story to the Director alone in a rebuild turn: no graph edit, no build, no timeline writer for anyone", () => {
    const rebuild: Turn = { mode: "story", storyAction: "rebuild" };
    for (const enabled of [TEAM, []]) {
      expect(storyToolsOf("director", enabled, rebuild)).toEqual(["read_story", "rebuild_story"]);
      for (const agent of ["editor", "vision", "motion", "audio", "research"] as const) {
        expect(storyToolsOf(agent, enabled, rebuild)).toEqual(["read_story"]);
      }
      expect(storyToolsOf("jev", enabled, rebuild)).toEqual([]);
      for (const agent of AGENTS) {
        expect(
          toolsOf(agent, enabled, rebuild).filter((name) => TIMELINE_WRITERS.includes(name)),
        ).toEqual([]);
      }
    }
    expect(timelineWritesAllowed({ mode: "story", action: "rebuild" })).toBe(false);
    expect(timelineWritesAllowed({ mode: "story", action: "build" })).toBe(true);
  });

  it("never offers rebuild_story in a normal turn or a build turn", () => {
    for (const turn of [{ mode: "normal" }, { mode: "story", storyAction: "build" }] as Turn[]) {
      for (const agent of AGENTS) {
        expect(toolsOf(agent, TEAM, turn)).not.toContain("rebuild_story");
        expect(toolsOf(agent, [], turn)).not.toContain("rebuild_story");
      }
    }
  });

  it("offers read_story but neither edit_story nor build_story in a normal turn, and nothing without a story host", () => {
    for (const enabled of [TEAM, []]) {
      expect(storyToolsOf("director", enabled, { mode: "normal" })).toEqual(["read_story"]);
    }
    expect(toolsOf("editor", TEAM, { mode: "normal" })).toEqual(
      expect.arrayContaining(TIMELINE_WRITERS),
    );
    for (const agent of AGENTS) {
      const names = toolsOf(agent, TEAM, { mode: "story", storyAction: "build" }, false);
      expect(names.filter((name) => STORY_TOOLS.includes(name))).toEqual([]);
    }
  });
});

function turnStory(host = new FakeStoryHost(), storyOptions: StoryActionOptions | null = null) {
  const turn = new AbortController();
  const story = new TurnStory({ host, turnId: "turn-7", turnSignal: turn.signal, storyOptions });
  const call = (name: string, args: unknown) =>
    story.execute(name, args, new AbortController().signal);
  return { host, story, call };
}

describe("read_story", () => {
  it("marks locked nodes and everything the user set by hand, and lists their decisions", async () => {
    const { host, call } = turnStory();
    host.viewResult = userEditedStory();
    const { text, isError } = await call("read_story", {});

    expect(isError).toBeUndefined();
    expect(text).toContain("Play order (3 chapters): ch1");
    // Locked chapter, with the field the user changed.
    expect(text).toMatch(/1\. ch1 "Cold open" · LOCKED/);
    expect(text).toContain("title (set by user)");
    // The duration the user chose is marked on the chapter line itself.
    expect(text).toMatch(/2\. ch2 "The problem".*estimated 00:45\.0 \(45 s\) \(set by user\)/);
    expect(text).toContain("ranges: assets/raw-talk.mp4 01:02.0–01:30.0 (62–90 s) g3");
    // The decisions section and the lock list.
    expect(text).toContain("User decisions (the user set these by hand");
    expect(text).toContain('- ch1 "Cold open": title');
    expect(text).toContain('- ch2 "The problem": estimatedDuration');
    expect(text).toContain("nodes created by the user: v1");
    expect(text).toContain("attachments made by the user: v1 → ch2");
    expect(text).toContain("link removed by the user (do not re-add): ch2 → ch3");
    expect(text).toContain(
      'Locked (never change these nodes or their attachments): ch1 "Cold open"',
    );
    // The user's attachment shows on its chapter and on the material.
    expect(text).toContain('attached: video v1 "Keyboard close-up" [middle, added by user]');
    expect(text).toContain("version sha256:story-v1");
  });

  it("shows where a built chapter sits on the timeline and the cleaned material length", async () => {
    const { host, call } = turnStory();
    const view = userEditedStory();
    view.facts = {
      ch1: { materialDuration: 9.4, timeline: { clips: 3, start: 0, end: 12 } },
      ch2: { timeline: null },
    };
    host.viewResult = view;
    const { text } = await call("read_story", {});
    expect(text).toContain("material 00:09.4 (9.4 s)");
    expect(text).toContain("on the timeline: 00:00.0–00:12.0 (3 clips)");
    expect(text.match(/on the timeline/g)).toHaveLength(1);
  });

  it("asks to fit a chapter's ranges to a length the user set, but never flags a locked chapter", () => {
    const view = userEditedStory();
    view.facts = {
      ch1: { materialDuration: 40, timeline: null },
      ch2: { materialDuration: 120, timeline: null },
      ch3: { materialDuration: 31, timeline: null },
    };
    const text = formatStory(view);
    const attention = text.slice(text.indexOf("Needs attention"), text.indexOf("Locked ("));
    expect(attention).toContain(
      'ch2 "The problem": its A-roll runs 02:00.0 (120 s) but the user wants about 00:45.0 (45 s)',
    );
    expect(attention).not.toContain("ch1");
    expect(attention).not.toContain("ch3");
  });

  it("says there is no story yet, and tells how to start one", async () => {
    const { call } = turnStory();
    expect((await call("read_story", {})).text).toContain("There is no story yet");
  });

  it("renders a graph without user decisions as such", () => {
    const view = storyView(storyGraph({ nodes: [chapterNode("ch1")] }));
    const text = formatStory(view);
    expect(text).toContain("User decisions: none yet.");
    expect(text).toContain("Locked: nothing.");
    expect(text).not.toContain("(set by user)");
  });
});

describe("edit_story", () => {
  it("returns a service refusal as a tool error with its code and the failing operation", async () => {
    const { host, call } = turnStory();
    host.nextError = new StoryToolError("locked", 'Chapter ch1 "Cold open" is locked', 2);
    const result = await call("edit_story", {
      operations: [
        { op: "set_story", title: "x" },
        { op: "connect", from: "ch1", to: "ch2" },
        { op: "update_node", id: "ch1", set: { title: "Changed" } },
      ],
    });
    expect(result).toEqual({
      isError: true,
      text: 'locked (operations[2]): Chapter ch1 "Cold open" is locked',
    });
    expect(host.editFinished).toEqual([]);
  });

  it("passes a user_decision refusal through unchanged", async () => {
    const { host, call } = turnStory();
    host.nextError = new StoryToolError(
      "user_decision",
      "ch2 estimatedDuration was set by the user",
      0,
    );
    const result = await call("edit_story", {
      operations: [{ op: "update_node", id: "ch2", set: { estimatedDuration: 20 } }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "user_decision (operations[0]): ch2 estimatedDuration was set by the user",
    );
  });

  it("drops the nulls models send for omitted fields, keeps the ones that mean 'clear', and stamps the turn", async () => {
    const { host, call } = turnStory();
    const result = await call("edit_story", {
      baseVersion: null,
      operations: [
        {
          op: "add_node",
          ref: "intro",
          transition: null,
          node: {
            kind: "chapter",
            title: "Intro",
            purpose: null,
            previewFrame: null,
            sourceRanges: [{ source: "assets/raw-talk.mp4", segments: ["g1", "g2"], from: null }],
          },
        },
        {
          op: "attach",
          node: "@intro",
          chapter: "ch1",
          placement: null,
          offset: null,
          duration: 4,
        },
        { op: "update_node", id: "ch2", set: { description: "New", previewFrame: null } },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(host.editRequests).toEqual([
      {
        turnId: "turn-7",
        operations: [
          {
            op: "add_node",
            ref: "intro",
            node: {
              kind: "chapter",
              title: "Intro",
              previewFrame: null,
              sourceRanges: [{ source: "assets/raw-talk.mp4", segments: ["g1", "g2"] }],
            },
          },
          { op: "attach", node: "@intro", chapter: "ch1", offset: null, duration: 4 },
          { op: "update_node", id: "ch2", set: { description: "New", previewFrame: null } },
        ],
      },
    ]);
    expect(result.text).toContain("Applied 3 operations");
    expect(result.text).toContain("1. add_node → n1");
  });

  it("refuses a malformed batch with the failing operation before calling the service", async () => {
    const { host, call } = turnStory();
    const result = await call("edit_story", {
      operations: [
        { op: "connect", from: "ch1", to: "ch2" },
        { op: "attach", node: "v1" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^invalid_request \(operations\[1\]\): /);
    expect(host.editRequests).toEqual([]);
  });

  it("refuses tools the turn does not know", async () => {
    const { story } = turnStory();
    expect(await story.execute("delete_story", {}, new AbortController().signal)).toEqual({
      isError: true,
      text: "Unknown story tool delete_story.",
    });
  });
});

describe("build_story", () => {
  it("builds with the version and turn, and reports each chapter's span, what was replaced and kept, and warnings", async () => {
    const { host, call } = turnStory();
    host.viewResult = userEditedStory();
    const result = await call("build_story", { baseVersion: "sha256:story-v1" });

    expect(host.buildRequests).toEqual([{ baseVersion: "sha256:story-v1", turnId: "turn-7" }]);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Built the story on index.html: 00:57.0 (57 s)");
    expect(result.text).toContain('- ch1 "Cold open" 00:00.0–00:12.0 (estimated 12 s, 3 clips)');
    expect(result.text).toContain('- ch2 "The problem" 00:12.0–00:57.0 (estimated 45 s, 5 clips)');
    expect(result.text).toContain("Replaced 4 earlier clips; kept 2 clips");
    expect(result.text).toContain("- Wrap up: missing Close-up of the product box");
    expect(result.text).toContain("Verify the result with inspect_timeline.");
  });

  it("supports a dry run that says nothing was written, and surfaces a stale version as a conflict", async () => {
    const { host, call } = turnStory();
    const dry = await call("build_story", { dryRun: true });
    expect(host.buildRequests.at(-1)).toMatchObject({ dryRun: true });
    expect(dry.text).toContain("Dry run (nothing was written)");

    host.nextError = new StoryToolError("conflict", "The story changed since version sha256:old");
    expect(await call("build_story", { baseVersion: "sha256:old" })).toEqual({
      isError: true,
      text: "conflict: The story changed since version sha256:old",
    });
  });
});

describe("build_story options", () => {
  it("takes the locked chapters the user allowed from the turn, and ignores any the model sends", async () => {
    const { host, call } = turnStory(new FakeStoryHost(), { allowLocked: ["ch1"] });
    await call("build_story", { baseVersion: "sha256:story-v1", allowLocked: ["ch1", "ch2"] });
    expect(host.buildRequests).toEqual([
      { baseVersion: "sha256:story-v1", turnId: "turn-7", allowLocked: ["ch1"] },
    ]);

    const none = turnStory();
    await none.call("build_story", { allowLocked: ["ch1"] });
    expect(none.host.buildRequests).toEqual([{ turnId: "turn-7" }]);
  });

  it("reports the manual edits the build replaced and the locked chapters it kept", async () => {
    const { host, call } = turnStory();
    host.viewResult = userEditedStory();
    host.buildResult = {
      ...sampleBuildResult(host.viewResult),
      replacedEdits: [userTrim()],
      keptLocked: ["ch1"],
    };
    const { text } = await call("build_story", {});
    expect(text).toContain("Manual edits to generated clips that the build replaced (1):");
    expect(text).toContain('- modified "Keyboard close-up" (clip-9) by the user: start, duration');
    expect(text).toContain(
      'Locked chapters whose built section was kept as it was: ch1 "Cold open"',
    );
  });
});

describe("rebuild_story", () => {
  const options: StoryActionOptions = {
    chapters: ["ch2"],
    manualEdits: "replace",
    allowLocked: ["ch1"],
  };

  it("merges the user's options for the turn into the request, with the version and the turn", async () => {
    const { host, call } = turnStory(new FakeStoryHost(), options);
    host.viewResult = userEditedStory();
    const result = await call("rebuild_story", { baseVersion: "sha256:story-v1" });

    expect(result.isError).toBeUndefined();
    expect(host.rebuildRequests).toEqual([
      {
        baseVersion: "sha256:story-v1",
        turnId: "turn-7",
        chapters: ["ch2"],
        manualEdits: "replace",
        allowLocked: ["ch1"],
      },
    ]);
  });

  it("does not let the model widen the scope, the manual-edit policy or the locked permissions", async () => {
    const { host, call } = turnStory(new FakeStoryHost(), { chapters: ["ch2"] });
    await call("rebuild_story", {
      chapters: ["ch1", "ch2", "ch3"],
      manualEdits: "replace",
      allowLocked: ["ch1"],
      turnId: "someone-else",
    });
    expect(host.rebuildRequests).toEqual([{ turnId: "turn-7", chapters: ["ch2"] }]);

    const plain = turnStory();
    await plain.call("rebuild_story", {
      chapters: ["ch1"],
      manualEdits: "replace",
      allowLocked: ["ch1"],
      dryRun: true,
    });
    expect(plain.host.rebuildRequests).toEqual([{ turnId: "turn-7", dryRun: true }]);
  });

  it("refuses arguments the tool does not have before calling the service", async () => {
    const { host, call } = turnStory();
    const result = await call("rebuild_story", { everything: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^invalid_request/);
    expect(host.rebuildRequests).toEqual([]);
  });

  it("reports what was rebuilt, moved and kept by chapter title, with the edits kept and the locked chapters pending", async () => {
    const { host, call } = turnStory();
    host.viewResult = userEditedStory();
    const { text } = await call("rebuild_story", {});

    expect(text).toContain("Rebuilt the affected sections on index.html: 01:12.0 (72 s)");
    expect(text).toContain('(regenerated or built for the first time): ch2 "The problem"');
    expect(text).toContain('(content untouched): ch3 "Wrap up"');
    expect(text).toContain("Manual edits kept although the story changed that unit (1):");
    expect(text).toContain('- modified "Keyboard close-up" (clip-9) by the user: start, duration');
    expect(text).toContain(
      'not rebuilt (the user has to allow them in the Story workspace): ch1 "Cold open"',
    );
    expect(text).toContain("Verify the result with inspect_timeline.");
  });

  it("names the titles of chapters that left the story, and lists replaced edits", async () => {
    const { host, call } = turnStory();
    host.viewResult = userEditedStory();
    const base = sampleRebuildResult(host.viewResult);
    host.rebuildResult = {
      ...base,
      rebuilt: [],
      removed: ["ch9"],
      keptEdits: [],
      replacedEdits: [userTrim("clip-4", "Logo sting")],
      keptLocked: [],
      report: {
        ...base.report,
        sections: [
          ...base.report.sections,
          { ...base.report.sections[2]!, chapter: "ch9", title: "Old outro" },
        ],
      },
    };
    const { text } = await call("rebuild_story", {});
    expect(text).toContain('(taken off the timeline): ch9 "Old outro"');
    expect(text).toContain("Manual edits replaced by the rebuild (1):");
    expect(text).toContain('- modified "Logo sting" (clip-4) by the user');
  });

  it("tells an in-sync timeline from changes held back, never claims a write for either, and reports a dry run", async () => {
    const { host, call } = turnStory();
    host.viewResult = userEditedStory();
    const nothing = {
      ...sampleRebuildResult(host.viewResult),
      changed: false,
      rebuilt: [],
      moved: [],
      keptEdits: [],
      keptLocked: [],
    };
    host.rebuildResult = { ...nothing, report: { ...nothing.report, state: "in_sync" } };
    const synced = await call("rebuild_story", {});
    expect(synced.text).toContain("Already in sync");
    expect(synced.text).toContain("nothing was written");
    expect(synced.text).not.toContain("Verify the result");

    // The story still differs, but the only change would replace the user's edit: nothing is written, and it says why.
    host.rebuildResult = {
      ...nothing,
      report: { ...nothing.report, state: "out_of_sync" },
      keptEdits: [userTrim()],
    };
    const held = await call("rebuild_story", {});
    expect(held.text).not.toContain("Already in sync");
    expect(held.text).toContain("Nothing was written");
    expect(held.text).toContain("Manual edits kept");

    host.rebuildResult = null;
    const dry = await call("rebuild_story", { dryRun: true });
    expect(host.rebuildRequests.at(-1)).toMatchObject({ dryRun: true });
    expect(dry.text).toContain("Dry run (nothing was written)");
    expect(dry.text).toContain("Would be rebuilt");
  });

  it("returns a service refusal with its code", async () => {
    const { host, call } = turnStory();
    host.nextError = new StoryToolError("conflict", "The story changed since version sha256:old");
    expect(await call("rebuild_story", { baseVersion: "sha256:old" })).toEqual({
      isError: true,
      text: "conflict: The story changed since version sha256:old",
    });
  });
});

describe("Timeline sync in read_story", () => {
  const withSync = (sync = sampleSyncReport()) => ({ ...userEditedStory(), sync });

  it("lists the changed and moved sections, the manual edits and who made them, the conflicts, locked chapters and unrelated clips", async () => {
    const { host, call } = turnStory();
    host.viewResult = withSync();
    const { text } = await call("read_story", {});

    expect(text).toContain("Timeline sync: OUT OF SYNC");
    expect(text).toContain("(ch2) and move 1 (ch3); length 01:10.0 → 01:12.0");
    expect(text).toContain(
      '- ch1 "Cold open": changed, LOCKED · 00:00.0–00:12.0 → 00:00.0–00:14.0',
    );
    expect(text).toContain(
      '- ch2 "The problem": changed, moves · 00:12.0–00:57.0 → 00:12.0–00:57.0',
    );
    expect(text).toContain(
      '· b-roll v1 "Keyboard close-up": changed (placement middle → end) → kept (holds manual edits); 1 manual edit',
    );
    expect(text).toContain(
      '- ch3 "Wrap up": content unchanged, moves · 00:57.0–01:10.0 → 00:59.0–01:12.0',
    );
    expect(text).toContain(
      "Manual edits to generated clips: 1 (1 by the user, 0 by the AI); 1 unit a rebuild must change hold edits",
    );
    expect(text).toContain('- modified "Keyboard close-up" (clip-9) by the user: start, duration');
    expect(text).toContain("Locked chapters with changes");
    expect(text).toContain(": ch1");
    expect(text).toContain('moving with their section: "Logo bug" +2 s');
  });

  it("says when the timeline is in sync, not built, or built before synchronization existed", async () => {
    const { host, call } = turnStory();
    const empty = sampleSyncReport();
    const sync = {
      ...empty,
      sections: [],
      affected: [],
      moved: [],
      lockedPending: [],
      manualEdits: 0,
      conflicts: 0,
      unrelated: [],
    };
    host.viewResult = withSync({ ...sync, state: "in_sync" });
    const inSync = (await call("read_story", {})).text;
    expect(inSync).toContain("Timeline sync: in sync");
    expect(inSync).not.toContain("OUT OF SYNC");

    host.viewResult = withSync({ ...sync, state: "not_built" });
    expect((await call("read_story", {})).text).toContain("not on the timeline yet");
    host.viewResult = withSync({ ...sync, state: "untracked" });
    expect((await call("read_story", {})).text).toContain(
      "only the full build_story takes them over",
    );

    host.viewResult = userEditedStory();
    expect((await call("read_story", {})).text).not.toContain("Timeline sync");
  });

  it("stays bounded, and the sync section is not what a long graph cuts off", () => {
    const chapters = Array.from({ length: 80 }, (_, index) =>
      chapterNode(`c${index}`, {
        title: `Chapter ${index} ${"with a long title ".repeat(6)}`,
        description: "x".repeat(300),
        position: { x: index * 400, y: 0 },
      }),
    );
    const sections = chapters.map((chapter) => ({
      ...sampleSyncReport().sections[1]!,
      chapter: chapter.id,
      title: chapter.title,
      units: Array.from({ length: 9 }, (_, unit) => ({
        ...sampleSyncReport().sections[1]!.units[1]!,
        node: `v${unit}`,
        edits: Array.from({ length: 4 }, (_, edit) => userTrim(`clip-${unit}-${edit}`)),
      })),
    }));
    const view = {
      ...storyView(storyGraph({ nodes: chapters })),
      sync: { ...sampleSyncReport(), sections, manualEdits: 2_880 },
    };
    const text = formatStory(view, 10_000);
    expect(text.length).toBeLessThanOrEqual(10_000 + 200);
    expect(text).toContain("Timeline sync: OUT OF SYNC");
    expect(text).toContain("the story is longer than this view");
    expect(text.indexOf("Timeline sync")).toBeGreaterThan(text.indexOf("the story is longer"));
    expect(text).toMatch(/… \d+ more sections/);
  });
});
