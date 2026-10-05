import { describe, expect, it } from "vitest";
import { AGENT_DISPLAY_NAMES, SPECIALIST_IDS } from "@hyperframes/agent-protocol";
import { directorInstructions, specialistInstructions } from "./roles.js";

const count = (text: string, part: string) => text.split(part).length - 1;

describe("directorInstructions", () => {
  it("carries the working rules of exactly the specialists that are off, each shared block once", () => {
    const alone = directorInstructions([]);
    for (const name of SPECIALIST_IDS.map((id) => AGENT_DISPLAY_NAMES[id])) {
      expect(alone).toContain(`${name} is off in this chat: you do its work yourself`);
    }
    expect(count(alone, "Timeline conventions:")).toBe(1);
    expect(count(alone, "Composition frames: inspect_composition")).toBe(1);
    expect(count(alone, "What the user set by hand in the Story workspace")).toBe(1);

    const partial = directorInstructions(["editor", "vision", "motion", "audio"]);
    expect(partial).toContain("Research is off in this chat: you do its work yourself");
    expect(partial).not.toContain("Editor is off in this chat: you do its work yourself");
    expect(partial.length).toBeLessThan(alone.length);
  });

  it("is the plain Director when the whole team is on, and names the tools exactly", () => {
    const team = directorInstructions(SPECIALIST_IDS);
    expect(team).not.toContain("is off in this chat: you do its work yourself");
    expect(team).toContain("Tool names are exact");
    expect(team).toContain('delegate {agent: "editor", title, task}');
  });
});

describe("specialistInstructions", () => {
  it("never talks about a team to hand work to", () => {
    for (const id of SPECIALIST_IDS) {
      expect(specialistInstructions(id)).not.toContain("is off in this chat");
    }
  });
});
