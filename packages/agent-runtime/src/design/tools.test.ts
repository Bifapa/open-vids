import { describe, expect, it } from "vitest";
import {
  DESIGN_ACTIONS,
  DESIGN_REQUIRED_TOKENS,
  isRecord,
  type AgentId,
  type DesignAction,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import { buildHostTools } from "../agents/tools.js";
import { changesProject } from "../intent.js";
import { DESIGN_TOOL_NAMES, buildDesignTools, designToolsFor } from "./tools.js";

const DESIGN_TOOLS = Object.values<string>(DESIGN_TOOL_NAMES);
const TIMELINE_WRITERS = ["edit_timeline", "render_video", "build_rough_cut"];
const TEAM: SpecialistId[] = ["editor", "vision", "motion", "audio", "research"];
const AGENTS: AgentId[] = ["director", "editor", "vision", "motion", "audio", "research", "jev"];

/** Follows nested object keys of a JSON schema; undefined when a step is not an object. */
function path(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function toolsOf(
  agent: AgentId,
  enabled: SpecialistId[],
  designAction: DesignAction | null,
  design = true,
) {
  return buildHostTools(
    agent,
    { enabled, jev: true, editing: true, analysis: true, story: true, designAction, design },
    async () => ({ text: "" }),
  ).map((tool) => tool.name);
}

const FREE_MODE = [
  "list_design_systems",
  "read_design_system",
  "extract_project_design",
  "save_design_system",
  "attach_design_system",
];

describe("design tool availability", () => {
  it("gives the design tools to the Director alone: all of them in a design turn, the typed-request subset in an ordinary one", () => {
    for (const enabled of [TEAM, []]) {
      for (const agent of AGENTS) {
        const designOf = (action: DesignAction | null) =>
          toolsOf(agent, enabled, action).filter((name) => DESIGN_TOOLS.includes(name));
        expect(designOf(null)).toEqual(agent === "director" ? FREE_MODE : []);
        for (const action of DESIGN_ACTIONS)
          expect(designOf(action)).toEqual(agent === "director" ? DESIGN_TOOLS : []);
      }
    }
    // The video palette belongs to the dialog-started video source.
    expect(toolsOf("director", TEAM, null)).not.toContain("video_palette");
  });

  it("offers nothing without a design host", () => {
    for (const agent of AGENTS) {
      for (const action of [null, ...DESIGN_ACTIONS]) {
        expect(
          toolsOf(agent, TEAM, action, false).filter((name) => DESIGN_TOOLS.includes(name)),
        ).toEqual([]);
      }
    }
    expect(designToolsFor("director", { available: false, action: "create" })).toEqual([]);
  });

  it("hides every timeline writer in a design turn and keeps the readers", () => {
    for (const action of DESIGN_ACTIONS) {
      for (const agent of AGENTS) {
        const names = toolsOf(agent, TEAM, action);
        expect(names.filter((name) => TIMELINE_WRITERS.includes(name))).toEqual([]);
        if (agent !== "jev") expect(names).toContain("inspect_project");
      }
    }
    // With the Editor off the Director has the timeline writers itself in an ordinary turn.
    expect(toolsOf("director", [], null)).toEqual(
      expect.arrayContaining(["edit_timeline", "render_video"]),
    );
  });

  it("counts the library write and the attach as project-changing, so an Ask turn never has them", () => {
    expect(changesProject("save_design_system")).toBe(true);
    expect(changesProject("attach_design_system")).toBe(true);
    expect(changesProject("read_design_system")).toBe(false);
    for (const designAction of [null, "create"] as const) {
      const ask = buildHostTools(
        "director",
        {
          enabled: TEAM,
          jev: false,
          editing: true,
          analysis: true,
          design: true,
          designAction,
          intent: "ask",
        },
        async () => ({ text: "" }),
      ).map((tool) => tool.name);
      expect(ask).toEqual(expect.arrayContaining(["list_design_systems", "read_design_system"]));
      expect(ask).not.toContain("save_design_system");
      expect(ask).not.toContain("attach_design_system");
    }
  });
});

describe("design tool descriptions and rows", () => {
  const tools = buildDesignTools("director", { available: true, action: "create" }, async () => ({
    text: "",
  }));
  const byName = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no ${name}`);
    return tool;
  };

  it("makes save_design_system require the 18 tokens and say how licenses and guesses are written", () => {
    const save = byName("save_design_system");
    const tokens = path(save.parameters, "properties", "spec", "properties", "tokens");
    expect(isRecord(tokens) ? tokens.required : null).toEqual([...DESIGN_REQUIRED_TOKENS]);
    expect(save.description).toContain("license: null");
    expect(save.description).toContain("guess: true");
    expect(save.description).toContain("invalid_system");
    expect(byName("read_design_system").description).toContain("baseVersion");
    expect(byName("extract_project_design").description).toContain("never invent");
  });

  it("labels each call with a coded activity row the chat can render", () => {
    expect(byName("save_design_system").activity?.({ name: "Night Drive", spec: {} })).toEqual({
      category: "edit",
      label: "Saving design system Night Drive",
      labelCode: "saving_design_system",
      labelParams: { id: "night-drive", name: "Night Drive" },
    });
    expect(
      byName("save_design_system").activity?.({ id: "nd", name: "Night Drive" }),
    ).toMatchObject({
      labelParams: { id: "nd", name: "Night Drive" },
    });
    expect(byName("save_design_system").activity?.({})).toEqual({
      category: "edit",
      label: "Saving the design system",
    });
    expect(byName("read_design_system").activity?.({ id: "acme" })).toMatchObject({
      labelCode: "reading_design_system",
      labelParams: { id: "acme" },
    });
    expect(byName("attach_design_system").activity?.({ id: "acme" })).toMatchObject({
      labelCode: "attaching_design_system",
    });
    expect(byName("video_palette").activity?.({})).toMatchObject({
      labelCode: "reading_video_palette",
    });
    expect(byName("list_design_systems").activity?.({})).toMatchObject({
      labelCode: "listing_design_systems",
    });
    expect(byName("extract_project_design").activity?.({})).toMatchObject({
      labelCode: "extracting_project_design",
    });
  });
});
