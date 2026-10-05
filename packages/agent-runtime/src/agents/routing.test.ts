import { describe, expect, it } from "vitest";
import type { AgentModelCatalog, SpecialistConfig } from "@hyperframes/agent-protocol";
import { summarizeReport } from "./runRecord.js";
import { routeDelegation } from "./routing.js";

const sonnet = { provider: "anthropic", modelId: "sonnet" };
const opus = { provider: "anthropic", modelId: "opus" };
const flash = { provider: "google", modelId: "flash" };
const catalog: AgentModelCatalog = {
  models: [sonnet, opus].map((model) => ({
    ...model,
    name: model.modelId,
    reasoning: true,
    efforts: ["low", "medium", "high"],
  })),
  defaultModel: sonnet,
  defaultThinking: "medium",
};

describe("routeDelegation", () => {
  const config: SpecialistConfig = {
    model: sonnet,
    thinking: "high",
    allowedModels: [opus, flash],
  };

  it("uses the configured model and effort when the Director asks for nothing", () => {
    expect(routeDelegation("editor", config, {}, catalog)).toEqual({
      ok: true,
      model: sonnet,
      thinking: "high",
      routed: false,
    });
  });

  it("lets the Director pick an allowed, available model and lower the effort", () => {
    expect(routeDelegation("editor", config, { model: opus, thinking: "low" }, catalog)).toEqual({
      ok: true,
      model: opus,
      thinking: "low",
      routed: true,
    });
  });

  it("refuses models the user did not allow, and allowed models without credentials", () => {
    const fixed: SpecialistConfig = { model: sonnet, thinking: null, allowedModels: [] };
    const notAllowed = routeDelegation("vision", fixed, { model: opus }, catalog);
    expect(notAllowed).toMatchObject({ ok: false });
    expect(notAllowed.ok ? "" : notAllowed.message).toContain("has not allowed other models");
    expect(routeDelegation("editor", config, { model: flash }, catalog)).toMatchObject({
      ok: false,
      message: expect.stringContaining("not available"),
    });
  });

  it("never raises thinking above the configured effort, or the default when unset", () => {
    expect(routeDelegation("motion", config, { thinking: "max" }, catalog)).toMatchObject({
      ok: false,
    });
    const unset: SpecialistConfig = { model: null, thinking: null, allowedModels: [] };
    expect(routeDelegation("motion", unset, { thinking: "high" }, catalog)).toMatchObject({
      ok: false,
      message: expect.stringContaining("limited to medium"),
    });
    expect(routeDelegation("motion", unset, { thinking: "minimal" }, catalog)).toEqual({
      ok: true,
      model: null,
      thinking: "minimal",
      routed: true,
    });
  });

  it("does not call an unloaded model list 'no credentials': an allowed model is accepted", () => {
    const empty: AgentModelCatalog = { models: [], defaultModel: null, defaultThinking: null };
    expect(routeDelegation("editor", config, { model: opus }, empty, true)).toMatchObject({
      ok: false,
      message: expect.stringContaining("no credentials"),
    });
    expect(routeDelegation("editor", config, { model: opus }, empty, false)).toEqual({
      ok: true,
      model: opus,
      thinking: "high",
      routed: true,
    });
    // The user's allow-list still binds.
    expect(
      routeDelegation(
        "vision",
        { model: sonnet, thinking: null, allowedModels: [] },
        { model: opus },
        empty,
        false,
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("has not allowed other models"),
    });
  });
});

describe("summarizeReport", () => {
  it("skips label-only lines and markdown to find the outcome sentence", () => {
    expect(
      summarizeReport(
        "**Report:**\n\n- Set the title clip to 4 s in `scene_01.html`.\n- Nothing else changed.",
      ),
    ).toBe("Set the title clip to 4 s in scene_01.html. Nothing else changed.");
    expect(summarizeReport("   ")).toBeNull();
  });
});
