import { describe, expect, it } from "vitest";
import type { AgentId, SpecialistId, StoryAction } from "@hyperframes/agent-protocol";
import { buildHostTools } from "../agents/tools.js";
import { TurnEditing } from "../editing/executor.js";
import { FakeEditingHost } from "../testing/editing.js";
import {
  FakeResearchHost,
  ccBy,
  sampleCandidate,
  sampleProvenance,
  sampleSearchResult,
} from "../testing/research.js";
import { TurnResearch, type TurnResearchOptions } from "./executor.js";
import { ResearchToolError } from "./host.js";
import { RESEARCH_TOOL_NAMES } from "./tools.js";

const RESEARCH_TOOLS = Object.values<string>(RESEARCH_TOOL_NAMES).filter(
  (name) => name !== "read_website",
);
const EXTERNAL_TOOLS = RESEARCH_TOOLS.filter((name) => name !== "read_sources");
const TEAM: SpecialistId[] = ["editor", "vision", "motion", "audio", "research"];
const NO_RESEARCH: SpecialistId[] = ["editor", "vision", "motion", "audio"];
const AGENTS: AgentId[] = ["director", "editor", "vision", "motion", "audio", "research", "jev"];

interface Turn {
  mode: "normal" | "story";
  storyAction?: StoryAction | null;
}

function researchToolsOf(
  agent: AgentId,
  enabled: SpecialistId[],
  turn: Turn,
  research = true,
  websites = false,
): string[] {
  return buildHostTools(
    agent,
    { enabled, jev: true, editing: true, analysis: true, story: true, research, websites, ...turn },
    async () => ({ text: "" }),
  )
    .map((tool) => tool.name)
    .filter((name) => name === "read_website" || RESEARCH_TOOLS.includes(name));
}

describe("research tool availability", () => {
  it("gives Research the external tools and the Director only read_sources", () => {
    for (const turn of [
      { mode: "normal" },
      { mode: "story", storyAction: null },
      { mode: "story", storyAction: "review" },
      { mode: "story", storyAction: "resolve" },
    ] satisfies Turn[]) {
      expect(researchToolsOf("research", TEAM, turn)).toEqual(RESEARCH_TOOLS);
      expect(researchToolsOf("director", TEAM, turn)).toEqual(["read_sources"]);
      for (const agent of ["editor", "vision", "motion", "audio", "jev"] as const) {
        expect(researchToolsOf(agent, TEAM, turn)).toEqual([]);
      }
    }
  });

  it("gives nobody a research tool when Research is disabled in the chat", () => {
    for (const agent of AGENTS) {
      expect(researchToolsOf(agent, NO_RESEARCH, { mode: "normal" })).toEqual([]);
      expect(researchToolsOf(agent, [], { mode: "story", storyAction: "resolve" })).toEqual([]);
    }
  });

  it("gives nobody a research tool when the Asset Search policy could not be read", () => {
    for (const agent of AGENTS) {
      expect(researchToolsOf(agent, TEAM, { mode: "normal" }, false)).toEqual([]);
    }
  });

  it("offers none in a story build or rebuild turn", () => {
    for (const storyAction of ["build", "rebuild"] as const) {
      for (const agent of AGENTS) {
        expect(researchToolsOf(agent, TEAM, { mode: "story", storyAction })).toEqual([]);
      }
    }
  });

  it("never gives the Director a way to search, read pages, import or resolve", () => {
    for (const enabled of [TEAM, NO_RESEARCH, []]) {
      for (const storyAction of [null, "review", "build", "rebuild", "resolve"] as const) {
        const names = researchToolsOf("director", enabled, { mode: "story", storyAction });
        expect(names.filter((name) => EXTERNAL_TOOLS.includes(name))).toEqual([]);
      }
    }
  });
});

describe("read_website availability", () => {
  it("is offered to the Director, Motion and Research, and to nobody else", () => {
    for (const agent of AGENTS) {
      const names = researchToolsOf(agent, TEAM, { mode: "normal" }, true, true);
      expect(names.includes("read_website")).toBe(
        ["director", "motion", "research"].includes(agent),
      );
    }
  });

  it("does not depend on Research being enabled or on the Asset Search policy being readable", () => {
    expect(researchToolsOf("director", NO_RESEARCH, { mode: "normal" }, false, true)).toEqual([
      "read_website",
    ]);
    expect(researchToolsOf("motion", NO_RESEARCH, { mode: "normal" }, false, true)).toEqual([
      "read_website",
    ]);
    expect(researchToolsOf("director", TEAM, { mode: "normal" }, false, true)).toEqual([
      "read_website",
    ]);
  });

  it("is missing for a specialist that is not in the chat's team, and without a research host", () => {
    expect(researchToolsOf("motion", ["editor"], { mode: "normal" }, false, true)).toEqual([]);
    expect(researchToolsOf("director", TEAM, { mode: "normal" }, true, false)).toEqual([
      "read_sources",
    ]);
  });

  it("is offered in Plan and Ask turns (reading is harmless) but not in a story build or rebuild turn", () => {
    for (const intent of ["plan", "ask"] as const) {
      const names = buildHostTools(
        "director",
        {
          enabled: TEAM,
          jev: false,
          editing: true,
          analysis: true,
          story: true,
          websites: true,
          intent,
        },
        async () => ({ text: "" }),
      ).map((tool) => tool.name);
      expect(names).toContain("read_website");
    }
    for (const storyAction of ["build", "rebuild"] as const) {
      expect(researchToolsOf("director", TEAM, { mode: "story", storyAction }, true, true)).toEqual(
        [],
      );
    }
  });
});

// ── Executor ─────────────────────────────────────────────────────────────────

function research(overrides: Partial<TurnResearchOptions> = {}) {
  const host = new FakeResearchHost();
  const controller = new AbortController();
  const turn = new TurnResearch({
    host,
    turnId: "turn-1",
    turnSignal: controller.signal,
    enabled: TEAM,
    turn: { mode: "normal", action: null },
    storyOptions: null,
    intent: "edit",
    userTexts: () => [],
    model: () => "anthropic/claude-haiku",
    ...overrides,
  });
  const call = (name: string, args: unknown, caller: AgentId = "research") =>
    turn.execute(caller, name, args, new AbortController().signal);
  return { host, turn, call, controller };
}

describe("the research executor", () => {
  it("refuses search, page reading, import and resolution to anyone but Research, without reaching Studio", async () => {
    const { host, call } = research();
    const calls: Array<[string, unknown]> = [
      ["search_assets", { query: "waves", mediaKind: "video" }],
      ["inspect_url", { url: "https://example.com/page" }],
      ["import_asset", { url: "https://example.com/a.mp4" }],
      ["resolve_missing_asset", { missing: "m1", asset: "assets/a.mp4" }],
    ];
    for (const caller of ["director", "editor", "vision", "motion", "audio", "jev"] as const) {
      for (const [name, args] of calls) {
        const result = await call(name, args, caller);
        expect(result).toMatchObject({ isError: true });
        expect(result.text).toContain("not available to you");
      }
    }
    expect(host.searchRequests).toEqual([]);
    expect(host.inspectRequests).toEqual([]);
    expect(host.importRequests).toEqual([]);
    expect(host.resolveRequests).toEqual([]);

    // The Director may read the project's sources and licenses.
    expect((await call("read_sources", {}, "director")).isError).toBeUndefined();
    expect(host.sourcesCalls).toBe(1);
  });

  it("refuses everything when Research is not enabled in the chat, even to Research", async () => {
    const { host, call } = research({ enabled: NO_RESEARCH });
    for (const caller of ["research", "director"] as const) {
      expect((await call("read_sources", {}, caller)).isError).toBe(true);
    }
    expect((await call("search_assets", { query: "x", mediaKind: "video" })).isError).toBe(true);
    expect(host.searchRequests).toEqual([]);
    expect(host.sourcesCalls).toBe(0);
  });

  it("sends no policy mode, and sets turn, agent and model itself whatever the model says", async () => {
    const { host, call } = research();
    await call("search_assets", {
      query: "  ocean waves  ",
      mediaKind: "video",
      sources: ["wikimedia-commons", "web", "web"],
      limit: 4,
      mode: "any",
      policy: { mode: "any" },
    });
    expect(host.searchRequests).toEqual([
      { query: "ocean waves", mediaKind: "video", sources: ["wikimedia-commons", "web"], limit: 4 },
    ]);

    await call("import_asset", {
      candidate: "cand-1",
      url: null,
      name: null,
      resolveMissing: null,
      turnId: "someone-elses-turn",
      agent: "user",
      model: "attacker/model",
      mode: "any",
      retrievedBy: { agent: "user" },
    });
    expect(host.importRequests).toEqual([
      { candidate: "cand-1", turnId: "turn-1", agent: "research", model: "anthropic/claude-haiku" },
    ]);

    await call("resolve_missing_asset", {
      missing: "m1",
      asset: "assets/research/a.mp4",
      turnId: "x",
    });
    expect(host.resolveRequests).toEqual([
      { missing: "m1", asset: "assets/research/a.mp4", turnId: "turn-1" },
    ]);
  });

  it("requires exactly one of candidate and url for an import", async () => {
    const { host, call } = research();
    const both = await call("import_asset", { candidate: "c", url: "https://example.com/a.mp4" });
    const neither = await call("import_asset", { name: "x" });
    expect(both.text).toContain("exactly one of candidate and url");
    expect(neither.text).toContain("exactly one of candidate and url");
    expect(host.importRequests).toEqual([]);

    await call("import_asset", { url: "https://example.com/a.mp4", name: "waves" });
    expect(host.importRequests[0]).toMatchObject({
      url: "https://example.com/a.mp4",
      name: "waves",
    });
    expect(host.importRequests[0]).not.toHaveProperty("candidate");
  });

  it("refuses malformed search arguments itself", async () => {
    const { host, call } = research();
    for (const args of [
      {},
      { query: "x" },
      { query: "x", mediaKind: "gif" },
      { query: "", mediaKind: "video" },
      { query: "x", mediaKind: "video", limit: 0 },
      { query: "x", mediaKind: "video", sources: "web" },
    ]) {
      const result = await call("search_assets", args);
      expect(result).toMatchObject({ isError: true });
      expect(result.text).toContain("invalid_request");
    }
    expect(host.searchRequests).toEqual([]);
  });

  it("limits a resolve turn to the Missing Asset nodes the user chose", async () => {
    const { host, call } = research({
      turn: { mode: "story", action: "resolve" },
      storyOptions: { missing: ["m1"] },
    });
    const outside = await call("import_asset", { candidate: "c", resolveMissing: "m2" });
    expect(outside).toMatchObject({ isError: true });
    expect(outside.text).toContain(
      "m2 is not one of the Missing Asset nodes this turn may resolve",
    );
    const outsideResolve = await call("resolve_missing_asset", { missing: "m2", asset: "a.mp4" });
    expect(outsideResolve.isError).toBe(true);
    expect(host.importRequests).toEqual([]);
    expect(host.resolveRequests).toEqual([]);

    // Inside the list, and an import that resolves nothing, both go through.
    expect((await call("import_asset", { candidate: "c", resolveMissing: "m1" })).isError).toBe(
      undefined,
    );
    expect((await call("resolve_missing_asset", { missing: "m1", asset: "a.mp4" })).isError).toBe(
      undefined,
    );
    expect(host.importRequests[0]?.resolveMissing).toBe("m1");
    expect(host.resolveRequests).toHaveLength(1);
  });

  it("does not restrict resolution outside a resolve turn", async () => {
    const { host, call } = research({ storyOptions: { missing: ["m1"] } });
    await call("import_asset", { candidate: "c", resolveMissing: "m7" });
    expect(host.importRequests[0]?.resolveMissing).toBe("m7");
  });

  it("tells the model a policy refusal is final", async () => {
    const { host, call } = research();
    host.nextError = new ResearchToolError(
      "blocked_by_policy",
      "example.com is not an enabled trusted source",
    );
    const result = await call("inspect_url", { url: "https://example.com/x" });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain("blocked_by_policy");
    expect(result.text).toContain("cannot change it");
  });

  it("stops accepting calls on shutdown and cancels the ones in flight", async () => {
    const { host, turn, call } = research();
    const gate = Promise.withResolvers<void>();
    host.importGate = gate.promise;
    const pending = call("import_asset", { candidate: "c" });
    await Promise.resolve();
    const closing = turn.shutdown();
    expect(host.importSignals[0]?.aborted).toBe(true);
    expect((await call("read_sources", {})).text).toContain("research is closed");
    gate.resolve();
    await closing;
    expect((await pending).isError).toBeUndefined();
  });
});

// ── What the model reads ─────────────────────────────────────────────────────

describe("research results", () => {
  it("lists candidates with source, license status and confidence, author, size and what is already in the project", async () => {
    const { host, call, turn } = research();
    host.searchCandidates = [
      sampleCandidate("cand-1"),
      sampleCandidate("cand-2", {
        title: "Wave closeup",
        source: { id: "web", name: "example.com", trusted: false },
        license: {
          id: "unknown",
          name: "Unknown",
          url: null,
          confidence: "none",
          status: "unknown",
          basis: "no license found",
        },
        author: null,
        inProject: "assets/research/wave-closeup.mp4",
      }),
    ];
    const text = (await call("search_assets", { query: "waves", mediaKind: "video" })).text;
    expect(text).toContain("id cand-1");
    expect(text).toContain("Wikimedia Commons (trusted source)");
    expect(text).toContain("CC BY 4.0 (attribution required; confidence high)");
    expect(text).toContain("by Jane Doe · 1920×1080 · 12.5 s · 4.2 MB");
    expect(text).toContain("example.com (web)");
    expect(text).toContain(
      "Unknown (UNKNOWN: not verified, the user must check it; confidence none)",
    );
    expect(text).toContain("author unknown");
    expect(text).toContain("already in the project as assets/research/wave-closeup.mp4");
    // What the turn saw names the import row.
    expect(turn.candidate("cand-1")).toEqual({ title: "Ocean waves", license: "CC BY 4.0" });
  });

  it("reports per-source errors and what the policy blocked, stating that agents cannot change the policy", async () => {
    const { host, call } = research();
    host.searchResult = {
      ...sampleSearchResult({ query: "waves", mediaKind: "video" }, []),
      searched: [
        {
          source: { id: "nasa-images", name: "NASA Images", trusted: true },
          results: 0,
          error: "timeout",
        },
      ],
      blocked: [{ source: "web", reason: "the web is not allowed in trusted mode" }],
    };
    const text = (await call("search_assets", { query: "waves", mediaKind: "video" })).text;
    expect(text).toContain("NASA Images: FAILED — timeout");
    expect(text).toContain("web: BLOCKED by the user's Asset Search policy");
    expect(text).toContain("Agents cannot change the policy");
    expect(text).toContain("No candidates");
  });

  it("reports an import: path, fetch, duplicate, resolved node, resolve error, warnings and a provenance line", async () => {
    const { host, call } = research();
    const fresh = (await call("import_asset", { candidate: "cand-1", resolveMissing: "m1" })).text;
    expect(fresh).toContain("Imported assets/research/ocean-waves.mp4 (downloaded");
    expect(fresh).toContain("converted VP9/WebM → H.264/MP4");
    expect(fresh).toContain(
      "Source: “Ocean waves” · Wikimedia Commons (trusted source) · license CC BY 4.0 (attribution required; confidence high) · by Jane Doe",
    );
    expect(fresh).toContain(
      "Credit line: “Ocean waves” by Jane Doe, CC BY 4.0, via Wikimedia Commons",
    );
    expect(fresh).toContain("Resolved Missing Asset m1 → node v9");

    host.importResult = {
      asset: "assets/research/ocean-waves.mp4",
      provenance: sampleProvenance({ licenseStatus: "unknown", license: "Unknown" }),
      fetch: "none",
      duplicate: { asset: "assets/research/ocean-waves.mp4", reason: "same_content" },
      resolved: null,
      resolveError: { code: "locked", message: "m1 is locked" },
      warnings: ["the file has no audio"],
    };
    const duplicate = (await call("import_asset", { candidate: "cand-1", resolveMissing: "m1" }))
      .text;
    expect(duplicate).toContain(
      "Already in the project: assets/research/ocean-waves.mp4 (same content)",
    );
    expect(duplicate).toContain("NOT resolved — locked: m1 is locked");
    expect(duplicate).toContain("Warning: the file has no audio");

    host.importResult = {
      ...host.importResult,
      duplicate: null,
      fetch: "cache",
      resolveError: null,
    };
    expect((await call("import_asset", { url: "https://example.com/a.mp4" })).text).toContain(
      "from the project's download cache, no network",
    );
  });

  it("lists the project's sources with licenses, issues and credits", async () => {
    const { host, call } = research();
    host.sourcesResult = {
      ...host.sourcesResult,
      records: [
        {
          ...sampleProvenance({
            licenseStatus: "restricted",
            license: "CC BY-NC 4.0",
            licenseId: "cc_by_nc",
          }),
          present: true,
          usedIn: [],
          issues: ["Non-commercial license"],
        },
      ],
      summary: { clear: 0, attribution: 0, restricted: 1, unknown: 0, total: 1, missingFiles: 0 },
    };
    const text = (await call("read_sources", {}, "director")).text;
    expect(text).toContain("1 restricted");
    expect(text).toContain("not used yet");
    expect(text).toContain("look at: Non-commercial license");
    expect(text).toContain("Credits:");
  });
});

describe("research activity labels", () => {
  const tool = (name: string) => {
    const found = buildHostTools(
      "research",
      { enabled: TEAM, jev: false, editing: false, analysis: false, research: true },
      async () => ({ text: "" }),
    ).find((hostTool) => hostTool.name === name);
    if (!found) throw new Error(`no ${name}`);
    return found;
  };

  it("names what is searched, read, imported and resolved", () => {
    expect(tool("search_assets").activity?.({ query: "ocean waves", mediaKind: "video" })).toEqual({
      category: "search",
      label: "Searching sources · ocean waves (video)",
    });
    expect(
      tool("search_assets").activity?.({ query: "x", mediaKind: "audio", sources: ["web"] })?.label,
    ).toBe("Searching the web · x (audio)");
    expect(tool("inspect_url").activity?.({ url: "https://www.example.com/a" })?.label).toBe(
      "Reading a web page · example.com",
    );
    expect(tool("inspect_url").activity?.({ url: 12 })?.label).toBe("Reading a web page");
    expect(tool("resolve_missing_asset").activity?.({})?.label).toBe("Resolving a missing asset");
    expect(tool("read_sources").activity?.(null)?.label).toBe("Reading project sources");
    expect(tool("import_asset").activity?.({ url: "https://example.com/a.mp4" })?.label).toBe(
      "Importing a file from example.com",
    );
  });

  it("names the candidate and its license on an import, and the source on a single-source search", () => {
    const tools = buildHostTools(
      "research",
      {
        enabled: TEAM,
        jev: false,
        editing: false,
        analysis: false,
        research: true,
        researchCandidate: (id) =>
          id === "cand-1" ? { title: "Ocean waves", license: ccBy().name } : undefined,
        researchSourceName: (id) => (id === "wikimedia-commons" ? "Wikimedia Commons" : undefined),
      },
      async () => ({ text: "" }),
    );
    const find = (name: string) => tools.find((hostTool) => hostTool.name === name);
    expect(find("import_asset")?.activity?.({ candidate: "cand-1" })?.label).toBe(
      "Importing “Ocean waves” · CC BY 4.0",
    );
    expect(find("import_asset")?.activity?.({ candidate: "gone" })?.label).toBe(
      "Importing an asset",
    );
    expect(
      find("search_assets")?.activity?.({
        query: "ocean waves",
        mediaKind: "video",
        sources: ["wikimedia-commons"],
      })?.label,
    ).toBe("Searching Wikimedia Commons… · ocean waves");
  });
});

// ── render_video ─────────────────────────────────────────────────────────────

describe("render_video license report", () => {
  function render(researchHost: FakeResearchHost | undefined) {
    const editing = new FakeEditingHost();
    const turn = new TurnEditing({
      host: editing,
      turnSignal: new AbortController().signal,
      userRequests: ["please render the video"],
      ...(researchHost && { research: researchHost }),
    });
    return {
      editing,
      run: (args: unknown = {}) => turn.execute("render_video", args, new AbortController().signal),
    };
  }

  it("appends license warnings and credits of the composition that was rendered, without blocking", async () => {
    const host = new FakeResearchHost();
    host.exportCheckResult = {
      composition: "index.html",
      assets: [sampleProvenance()].map((record) => ({
        ...record,
        present: true,
        usedIn: ["index.html"],
        issues: [],
      })),
      warnings: [
        {
          asset: "assets/research/clip.mp4",
          status: "unknown",
          license: "Unknown",
          message: "No license was found for this file",
        },
      ],
      credits: ["“Ocean waves” by Jane Doe, CC BY 4.0, via Wikimedia Commons"],
    };
    const { editing, run } = render(host);
    const result = await run({ quality: "draft" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Rendered renders/");
    expect(result.text).toContain("License warnings for index.html (the render is not blocked");
    expect(result.text).toContain("assets/research/clip.mp4: Unknown (unknown)");
    expect(result.text).toContain("“Ocean waves” by Jane Doe, CC BY 4.0, via Wikimedia Commons");
    expect(editing.renderRequests).toHaveLength(1);
    // The default composition is resolved from the timeline, the named one is used as given.
    expect(host.exportChecks).toEqual(["index.html"]);
    await run({ composition: "scenes/outro.html" });
    expect(host.exportChecks).toEqual(["index.html", "scenes/outro.html"]);
  });

  it("says nothing when the project ships no researched assets", async () => {
    const host = new FakeResearchHost();
    const { run } = render(host);
    const result = await run();
    expect(result.text).not.toContain("License");
  });

  it("keeps the finished render and notes a license check that failed", async () => {
    const host = new FakeResearchHost();
    host.nextExportCheckError = new ResearchToolError("studio_unavailable", "Studio is restarting");
    const { run } = render(host);
    const result = await run();
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Rendered ");
    expect(result.text).toContain("License check: could not be run (Studio is restarting)");
  });

  it("does not run a check without a research host", async () => {
    const { run } = render(undefined);
    const result = await run();
    expect(result.text).toContain("Rendered ");
    expect(result.text).not.toContain("License");
  });
});
