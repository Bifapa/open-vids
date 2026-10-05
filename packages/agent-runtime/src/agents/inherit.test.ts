import { describe, expect, it } from "vitest";
import type { AgentId } from "@hyperframes/agent-protocol";
import { disabledSpecialists, withInheritedTools } from "./inherit.js";

const base = (agent: AgentId): string[] => {
  if (agent === "director") return ["inspect_project", "render_video"];
  if (agent === "editor") return ["edit_timeline", "render_video"];
  if (agent === "research") return ["search_assets"];
  return [];
};

describe("withInheritedTools", () => {
  it("gives the Director its own tools and those of every specialist that is off, once each", () => {
    expect(withInheritedTools("director", ["editor", "vision", "motion", "audio"], base)).toEqual([
      "inspect_project",
      "render_video",
      "search_assets",
    ]);
    expect(withInheritedTools("director", [], base)).toEqual([
      "inspect_project",
      "render_video",
      "edit_timeline",
      "search_assets",
    ]);
  });

  it("changes nothing for anyone else", () => {
    expect(withInheritedTools("editor", [], base)).toEqual(["edit_timeline", "render_video"]);
    expect(withInheritedTools("jev", [], base)).toEqual([]);
  });

  it("lists the specialists that are off", () => {
    expect(disabledSpecialists(["editor", "audio"])).toEqual(["vision", "motion", "research"]);
  });
});
