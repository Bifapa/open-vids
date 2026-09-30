import { describe, expect, it } from "vitest";
import type { AgentId, ChatMode, SpecialistId, StoryAction } from "@hyperframes/agent-protocol";
import { buildHostTools } from "../agents/tools.js";
import {
  FakeStoryHost,
  chapterNode,
  storyGraph,
  storyView,
  userEditedStory,
} from "../testing/story.js";
import { TurnStory } from "./executor.js";
import { formatStory } from "./format.js";
import { StoryToolError } from "./host.js";
import { STORY_TOOL_NAMES } from "./tools.js";

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

function turnStory(host = new FakeStoryHost()) {
  const turn = new AbortController();
  const story = new TurnStory({ host, turnId: "turn-7", turnSignal: turn.signal });
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
