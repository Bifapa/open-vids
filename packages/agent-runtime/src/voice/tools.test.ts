import { describe, expect, it } from "vitest";
import {
  isRecord,
  type AgentId,
  type ChatIntent,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import { directorInstructions, specialistInstructions } from "../agents/roles.js";
import { buildHostTools } from "../agents/tools.js";
import { changesProject } from "../intent.js";
import { qaPhaseRefusal } from "../qa/phase.js";
import { voiceFeatureEnabled } from "./feature.js";
import { VOICE_TOOL_NAMES, buildVoiceTools, isVoiceToolName, voiceToolsFor } from "./tools.js";

const VOICE_TOOLS = Object.values<string>(VOICE_TOOL_NAMES);
const TEAM: SpecialistId[] = ["editor", "vision", "motion", "audio", "research"];
const AGENTS: AgentId[] = ["director", "editor", "vision", "motion", "audio", "research", "jev"];

function toolsOf(
  agent: AgentId,
  enabled: SpecialistId[],
  options: { voice?: boolean; intent?: ChatIntent } = {},
): string[] {
  return buildHostTools(
    agent,
    {
      enabled,
      jev: true,
      editing: true,
      analysis: true,
      story: true,
      ...(options.voice !== undefined && { voice: options.voice }),
      ...(options.intent && { intent: options.intent }),
    },
    async () => ({ text: "" }),
  )
    .map((tool) => tool.name)
    .filter((name) => VOICE_TOOLS.includes(name));
}

describe("voice tool availability", () => {
  it("gives Audio both tools and the Director the setup tool when Audio is on", () => {
    for (const agent of AGENTS) {
      expect(toolsOf(agent, TEAM, { voice: true })).toEqual(
        agent === "audio"
          ? ["request_voice_setup", "generate_voiceover"]
          : agent === "director"
            ? ["request_voice_setup"]
            : [],
      );
    }
  });

  it("lets the Director inherit generate_voiceover when Audio is off, and gives a disabled Audio nothing", () => {
    const withoutAudio = TEAM.filter((id) => id !== "audio");
    expect(toolsOf("director", withoutAudio, { voice: true })).toEqual([
      "request_voice_setup",
      "generate_voiceover",
    ]);
    expect(toolsOf("audio", withoutAudio, { voice: true })).toEqual([]);
    expect(toolsOf("director", [], { voice: true })).toEqual([
      "request_voice_setup",
      "generate_voiceover",
    ]);
    expect(voiceToolsFor("audio", TEAM)).toEqual(["request_voice_setup", "generate_voiceover"]);
  });

  it("offers no voice tool to anybody when the runtime has no voice host", () => {
    for (const enabled of [TEAM, []]) {
      for (const agent of AGENTS) {
        expect(toolsOf(agent, enabled, { voice: false })).toEqual([]);
        expect(toolsOf(agent, enabled)).toEqual([]);
      }
    }
  });

  it("drops the voice tools from an Ask turn: they change the project and cost money", () => {
    expect(changesProject("request_voice_setup")).toBe(true);
    expect(changesProject("generate_voiceover")).toBe(true);
    expect(toolsOf("audio", TEAM, { voice: true, intent: "ask" })).toEqual([]);
    expect(toolsOf("director", TEAM, { voice: true, intent: "ask" })).toEqual([]);
  });

  it("is refused in every Render QA phase", () => {
    for (const name of VOICE_TOOLS) {
      for (const phase of ["review", "correction", "final"] as const) {
        expect(qaPhaseRefusal(phase, name)).toContain(name);
      }
      expect(qaPhaseRefusal(null, name)).toBeNull();
    }
  });

  it("tells the agents about voiceLine in edit_timeline only when the runtime has a voice host", () => {
    const editTimeline = (voice: boolean) => {
      const tool = buildHostTools(
        "audio",
        { enabled: TEAM, jev: false, editing: true, analysis: false, voice },
        async () => ({ text: "" }),
      ).find((candidate) => candidate.name === "edit_timeline");
      if (!tool) throw new Error("no edit_timeline");
      return tool;
    };
    const off = editTimeline(false);
    const on = editTimeline(true);
    const offText = JSON.stringify([off.description, off.parameters]);
    expect(offText).not.toContain("voiceLine");
    expect(offText).not.toContain("voiceover");
    expect(JSON.stringify(off.parameters)).toContain('"required":["op","asset","start","track"]');
    const onText = JSON.stringify([on.description, on.parameters]);
    expect(onText).toContain("voiceLine");
    expect(JSON.stringify(on.parameters)).toContain('"required":["op","start","track"]');
    // The captions-from-voiceover operation follows the same gate: schema, guide and name.
    expect(offText).not.toContain("captions_from_voiceover");
    expect(JSON.stringify(on.parameters)).toContain('"captions_from_voiceover"');
    expect(on.description).toContain("- captions_from_voiceover:");
    expect(on.name).toBe(off.name);
  });

  it("recognizes its own tool names", () => {
    expect(isVoiceToolName("generate_voiceover")).toBe(true);
    expect(isVoiceToolName("edit_timeline")).toBe(false);
  });
});

describe("voice tool definitions", () => {
  const tools = buildVoiceTools("audio", TEAM, async () => ({ text: "" }));

  it("describes the arguments and requires what the executor needs", () => {
    const setup = tools.find((tool) => tool.name === "request_voice_setup");
    const generate = tools.find((tool) => tool.name === "generate_voiceover");
    expect(setup?.parameters).toMatchObject({
      required: ["sampleText"],
      additionalProperties: false,
    });
    expect(generate?.parameters).toMatchObject({
      required: ["lines"],
      additionalProperties: false,
    });
    const properties = isRecord(generate?.parameters) ? generate.parameters.properties : null;
    expect(isRecord(properties) && Object.keys(properties)).toEqual(["lines", "lineIds"]);
  });

  it("labels the activity rows from untrusted arguments without throwing", () => {
    const generate = tools.find((tool) => tool.name === "generate_voiceover");
    expect(generate?.activity?.({ lines: [{ text: "a" }, { text: "b" }] })).toMatchObject({
      category: "edit",
      labelCode: "generating_voiceover",
      labelParams: { count: 2 },
    });
    expect(generate?.activity?.(null)).toMatchObject({ category: "edit" });
    expect(generate?.activity?.({ lines: "x" })).not.toHaveProperty("labelCode");
    expect(
      tools.find((tool) => tool.name === "request_voice_setup")?.activity?.(undefined),
    ).toMatchObject({ labelCode: "requesting_voice_setup" });
  });
});

describe("voice prompt text", () => {
  it("is part of the roles only when the runtime has a voice host", () => {
    expect(directorInstructions(TEAM, { voice: true })).toContain("request_voice_setup");
    expect(directorInstructions(TEAM, { voice: true })).toContain("FIRST");
    expect(directorInstructions(TEAM)).not.toContain("request_voice_setup");
    expect(directorInstructions(TEAM, { voice: false })).not.toContain("generate_voiceover");
    expect(specialistInstructions("audio", { voice: true })).toContain("generate_voiceover");
    expect(specialistInstructions("audio", { voice: true })).toContain("voiceLine");
    expect(specialistInstructions("audio")).not.toContain("voiceover");
    expect(specialistInstructions("editor", { voice: true })).not.toContain("generate_voiceover");
    expect(specialistInstructions("editor", { voice: true })).toContain("captions_from_voiceover");
    expect(specialistInstructions("audio", { voice: true })).toContain("captions_from_voiceover");
    expect(specialistInstructions("editor")).not.toContain("captions_from_voiceover");
  });

  it("gives the Director the Audio duties when Audio is off", () => {
    const withoutAudio = TEAM.filter((id) => id !== "audio");
    expect(directorInstructions(withoutAudio, { voice: true })).toContain(
      "Voiceover: when your task asks for narration",
    );
    expect(directorInstructions(TEAM, { voice: true })).not.toContain(
      "Voiceover: when your task asks for narration",
    );
    expect(directorInstructions(withoutAudio)).not.toContain("generate_voiceover");
  });
});

describe("the voice feature gate", () => {
  it("is on only for an explicit OPENVIDS_BETA_FEATURES=1", () => {
    expect(voiceFeatureEnabled({ OPENVIDS_BETA_FEATURES: "1" })).toBe(true);
    expect(voiceFeatureEnabled({ OPENVIDS_BETA_FEATURES: "0" })).toBe(false);
    expect(voiceFeatureEnabled({ OPENVIDS_BETA_FEATURES: "true" })).toBe(false);
    expect(voiceFeatureEnabled({})).toBe(false);
  });
});
