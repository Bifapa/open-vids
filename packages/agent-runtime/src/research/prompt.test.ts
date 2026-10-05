import { describe, expect, it } from "vitest";
import { RESEARCH_LIMITS } from "@hyperframes/agent-protocol";
import { researchPolicy, trustedSource } from "../testing/research.js";
import { renderResearchBlock, researchTeamLine, websiteAccessLine } from "./prompt.js";

const ready = (overrides = {}) => ({ status: "ready" as const, policy: researchPolicy(overrides) });
const unavailable = { status: "unavailable" as const, reason: "Studio did not answer" };

describe("researchTeamLine", () => {
  it("tells the Director to delegate Research and states the policy while Research is on", () => {
    const line = researchTeamLine(true, ready(), null);
    expect(line).toContain("Material from outside the project comes only from Research");
    expect(line).toContain("trusted sources only, 2 trusted sources enabled");
    expect(line).toContain("You never search or import yourself");
  });

  it("says nothing can be searched while no trusted source is enabled", () => {
    const line = researchTeamLine(
      true,
      ready({ sources: [trustedSource("off", { enabled: false })] }),
      null,
    );
    expect(line).toContain("0 trusted sources enabled");
    expect(line).toContain("nothing can be searched until the user enables a source");
  });

  it("hands the work to the Director when Research is off: the tools, the policy, the sources and the rules", () => {
    const line = researchTeamLine(false, ready(), null);
    expect(line).toContain("Research is off in this chat, so you do its work yourself with");
    for (const tool of ["search_assets", "inspect_url", "import_asset", "resolve_missing_asset"]) {
      expect(line).toContain(tool);
    }
    expect(line).toContain("trusted sources only");
    expect(line).toContain("wikimedia-commons · Wikimedia Commons");
    expect(line).toContain("The web backend");
    expect(line).toContain(`at most ${RESEARCH_LIMITS.importsPerTurn} imports per turn`);
    expect(line).toContain("A restricted-license asset asks the user for its own approval");
    expect(line).not.toContain("You never search or import yourself");
  });

  it("names the wider policy when the web is allowed", () => {
    const line = researchTeamLine(false, ready({ mode: "any" }), null);
    expect(line).toContain("any public source");
    expect(line).toContain('The web backend (id "web") and any public http(s) page');
  });

  it("keeps the tools and says the policy could not be read when Studio did not answer", () => {
    const off = researchTeamLine(false, unavailable, null);
    expect(off).toContain("you do its work yourself");
    expect(off).toContain("could not be read");
    expect(off).toContain("Studio did not answer");
    const on = researchTeamLine(true, unavailable, null);
    expect(on).toContain("Research is enabled, but");
    expect(on).toContain("Delegate as usual");
    expect(researchTeamLine(true, undefined, null)).toContain("could not be read");
  });

  it("closes research in a Rebuild turn whatever the settings say", () => {
    for (const enabled of [true, false]) {
      const line = researchTeamLine(enabled, ready(), "rebuild");
      expect(line).toContain("Research cannot search or import in a Rebuild turn");
    }
  });
});

describe("renderResearchBlock", () => {
  it("states the policy, the sources and the working rules with the turn's budget", () => {
    const block = renderResearchBlock(ready(), 5);
    expect(block).toContain('<asset-search-policy mode="trusted">');
    expect(block).toContain("nasa-images · NASA Images");
    expect(block).toContain("NOT allowed");
    expect(block).toContain("Compare at most 5 candidates per search");
    expect(block).toContain(`at most ${RESEARCH_LIMITS.importsPerTurn} imports in this turn`);
    expect(block.endsWith("</asset-search-policy>")).toBe(true);
  });

  it("carries the websites line only while a setting is off", () => {
    const off = researchPolicy({ websites: { readLinkedPages: true, fullAccess: false } });
    expect(renderResearchBlock({ status: "ready", policy: off }, 3)).toContain(
      "Full access to linked sites is off right now",
    );
    const open = ready({ websites: { readLinkedPages: true, fullAccess: true } });
    expect(renderResearchBlock(open, 3)).not.toContain("off right now");
  });

  it("says the policy is unknown, and what to do, when Studio could not be asked", () => {
    const block = renderResearchBlock(unavailable, 3);
    expect(block).toContain('<asset-search-policy status="unavailable">');
    expect(block).toContain("Studio did not answer");
    expect(block).toContain('search without "sources"');
  });
});

describe("websiteAccessLine", () => {
  it("is empty when the policy is unknown or both switches are on", () => {
    expect(websiteAccessLine(undefined)).toBe("");
    expect(websiteAccessLine(unavailable)).toBe("");
    expect(
      websiteAccessLine(ready({ websites: { readLinkedPages: true, fullAccess: true } })),
    ).toBe("");
  });

  it("says a call will ask in the chat when reading linked pages is off", () => {
    const line = websiteAccessLine(
      ready({ websites: { readLinkedPages: false, fullAccess: false } }),
    );
    expect(line).toContain("Reading linked pages is off right now");
    expect(line).toContain("asks the user in chat");
  });
});
