import type { StoryAction } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { buildHostTools } from "../agents/tools.js";
import { FakeStoryHost, chapterNode, storyGraph, storyView } from "../testing/story.js";
import { TurnStory } from "./executor.js";
import { storyModeRules, type StoryResearch } from "./prompt.js";

const RESEARCH: StoryResearch = { researchReady: true, researchEnabled: true, scope: null };
const rules = (action: StoryAction | null, voice: boolean) =>
  storyModeRules(action, true, null, RESEARCH, voice);

describe("the narration steps of a story turn's rules", () => {
  it("generate the voice of narrated chapters before build_story, in the build turn with voice on", () => {
    const text = rules("build", true);
    expect(text).toContain("3. Narration voice.");
    expect(text).toContain("request_voice_setup");
    expect(text).toContain("generate_voiceover");
    expect(text).toContain(`{id: "chapter-<chapterId>", text: <that chapter's narration`);
    expect(text).toContain("in story order");
    // The build and the later steps follow the narration step; the final mix ducks music under the voice.
    expect(text).toContain("4. Build.");
    expect(text).toContain("6. Final sound mix.");
    expect(text).toContain("duck_audio");
    expect(text.indexOf("3. Narration voice.")).toBeLessThan(text.indexOf("4. Build."));
  });

  it("say nothing about narration or voice with voice off, and keep the steps as they were", () => {
    for (const action of [null, "review", "build", "rebuild"] as const) {
      const text = rules(action, false);
      expect(text, String(action)).not.toMatch(/narration|voice|duck_audio/i);
    }
    const build = rules("build", false);
    expect(build).toContain("3. Build.");
    expect(build).toContain("5. Final sound mix.");
  });

  it("let the Director write narration when the user asks for a narrated video, in plan and review turns", () => {
    for (const action of [null, "review"] as const) {
      const text = rules(action, true);
      expect(text, String(action)).toContain('the chapter field "narration"');
      expect(text, String(action)).toContain("when the user asks for a narrated video");
      expect(text, String(action)).toContain('"set by user"');
    }
  });
});

const TEAM = ["editor", "audio"] as const;

function storyToolsOf(agent: "director" | "editor", action: StoryAction | null, voice: boolean) {
  return buildHostTools(
    agent,
    {
      enabled: [...TEAM],
      jev: false,
      editing: true,
      analysis: true,
      story: true,
      mode: "story",
      storyAction: action,
      voice,
    },
    async () => ({ text: "" }),
  ).filter((tool) => /_story$/.test(tool.name));
}

describe("story tools and narration", () => {
  it("offer no narration anywhere (schemas, descriptions) without the voice host", () => {
    const tools = [
      ...storyToolsOf("director", null, false),
      ...storyToolsOf("director", "build", false),
      ...storyToolsOf("editor", "build", false),
      ...storyToolsOf("director", "rebuild", false),
    ];
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read_story", "edit_story", "build_story", "rebuild_story"]),
    );
    for (const tool of tools) {
      expect(JSON.stringify([tool.description, tool.parameters]), tool.name).not.toMatch(
        /narration|voice/i,
      );
    }
  });

  it("offer the narration field and how a build handles it with the voice host", () => {
    const edit = storyToolsOf("director", null, true).find((tool) => tool.name === "edit_story");
    expect(JSON.stringify(edit?.parameters)).toContain('"narration"');
    expect(edit?.description).toContain("the voiceover text of the chapter");
    const build = storyToolsOf("editor", "build", true).find((tool) => tool.name === "build_story");
    expect(build?.description).toContain('"chapter-<chapterId>"');
    const rebuild = storyToolsOf("director", "rebuild", true).find(
      (tool) => tool.name === "rebuild_story",
    );
    expect(rebuild?.description).toContain("Narration:");
  });

  it("show read_story the narration, and its voice status only with the voice host", async () => {
    const graph = storyGraph({
      nodes: [
        chapterNode("ch1", { title: "Cold open", narration: "Welcome to the show." }),
        chapterNode("ch2", {
          title: "Second",
          narration: "More words.",
          userEdited: ["narration"],
        }),
      ],
    });
    const view = storyView(graph);
    view.facts = {
      ch1: { timeline: null, narration: { generated: true, seconds: 2.5, textCurrent: true } },
      ch2: { timeline: null, narration: { generated: false, seconds: null, textCurrent: false } },
    };
    for (const voice of [true, false]) {
      const host = new FakeStoryHost();
      host.viewResult = view;
      const story = new TurnStory({
        host,
        turnId: "turn-1",
        turnSignal: new AbortController().signal,
        storyOptions: null,
        voice,
      });
      const { text } = await story.execute("read_story", {}, new AbortController().signal);
      expect(text).toContain("narration: Welcome to the show.");
      expect(text).toContain("narration (set by user): More words.");
      if (voice) {
        expect(text).toContain("[voice generated, 00:02.5 (2.5 s)]");
        expect(text).toContain("[voice not generated yet]");
      } else {
        expect(text).not.toMatch(/voice/i);
      }
    }
  });
});
