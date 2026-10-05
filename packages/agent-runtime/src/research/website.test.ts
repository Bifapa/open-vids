import { describe, expect, it } from "vitest";
import { MAX_ALLOWED_SITES, type AgentId } from "@hyperframes/agent-protocol";
import type { BackendPromptOutcome } from "../backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { FakeResearchHost, researchPolicy, sampleWebsiteStyle } from "../testing/research.js";
import { TurnResearch, type TurnResearchOptions } from "./executor.js";
import { ResearchToolError } from "./host.js";
import { websiteAccessLine, type ResearchTurnState } from "./prompt.js";
import { WebsiteResourceLog } from "./websiteResources.js";

function executor(overrides: Partial<TurnResearchOptions> = {}) {
  const host = new FakeResearchHost();
  const turn = new TurnResearch({
    host,
    turnId: "turn-1",
    turnSignal: new AbortController().signal,
    enabled: ["motion"],
    turn: { mode: "normal", action: null },
    storyOptions: null,
    intent: "edit",
    websites: { chatId: "chat-1", resources: new WebsiteResourceLog() },
    userTexts: () => ["вот ссылка https://www.linear.app/features — сделай моушн"],
    turnUserTexts: () => ["вот ссылка https://www.linear.app/features — сделай моушн"],
    askBeforeDownloads: false,
    model: () => "anthropic/claude-haiku",
    ...overrides,
  });
  const call = (args: unknown, caller: AgentId = "director") =>
    turn.execute(caller, "read_website", args, new AbortController().signal);
  const callTool = (name: string, args: unknown, caller: AgentId = "director") =>
    turn.execute(caller, name, args, new AbortController().signal);
  return { host, call, callTool, resources: overrides.websites?.resources };
}

describe("read_website scope: only a site the user linked", () => {
  it("reads the linked site, its www. and subdomains, and refuses every other address before Studio is asked", async () => {
    const { host, call } = executor();
    for (const url of [
      "https://linear.app",
      "https://www.linear.app/pricing",
      "https://docs.linear.app/start",
    ]) {
      expect((await call({ url })).isError).toBeUndefined();
    }
    expect(host.websiteRequests.map((request) => request.url)).toEqual([
      "https://linear.app",
      "https://www.linear.app/pricing",
      "https://docs.linear.app/start",
    ]);

    for (const url of [
      "https://example.com",
      "https://linear.app.evil.com",
      "https://notlinear.app",
      "http://127.0.0.1:5400/",
      "file:///etc/passwd",
    ]) {
      const refused = await call({ url });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("not a page of a website the user linked");
      expect(refused.text).toContain("ask the user for the link");
    }
    expect(host.websiteRequests).toHaveLength(3);
  });

  it("refuses everything when the user linked nothing, and says so", async () => {
    const { host, call } = executor({ userTexts: () => ["make me an intro"] });
    const refused = await call({ url: "https://linear.app" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("has not linked any website");
    expect(host.websiteRequests).toEqual([]);
  });

  it("is limited to the Director, Motion and Research of the chat's team", async () => {
    const { host, call } = executor();
    for (const caller of ["vision", "editor", "audio", "jev"] as const) {
      expect((await call({ url: "https://linear.app" }, caller)).text).toContain(
        "not available to you",
      );
    }
    expect((await call({ url: "https://linear.app" }, "motion")).isError).toBeUndefined();
    expect(host.websiteRequests).toHaveLength(1);
  });
});

describe("a redirect off the linked site", () => {
  const OTHER = "https://victim-other-site.com/dashboard";
  const redirecting = "https://www.linear.app/out?to=https://victim-other-site.com/dashboard";

  it("shows and remembers nothing of a read that ended on another site", async () => {
    const resources = new WebsiteResourceLog();
    const { host, call, callTool } = executor({
      access: { assets: true, websites: true, websiteFiles: true },
      websites: { chatId: "chat-1", resources },
    });
    host.websiteResult = {
      site: { ...sampleWebsiteStyle(OTHER), url: redirecting },
      screenshots: [
        { name: "viewport.jpg", mimeType: "image/jpeg", data: "AAAA", width: 1440, height: 900 },
      ],
    };

    const refused = await call({ url: redirecting });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("blocked_by_policy");
    expect(refused.text).toContain("redirected to https://victim-other-site.com/dashboard");
    expect(refused.text).not.toContain("Example — build better");
    expect(refused.images ?? []).toEqual([]);
    // The other site's files were not remembered, so its API is still out of reach.
    const file = await callTool("get_website_file", {
      url: "https://victim-other-site.com/api/export.json",
      mode: "read",
    });
    expect(file.isError).toBe(true);
    expect(host.websiteFileRequests).toEqual([]);
  });

  it("refuses a file or a recording whose redirect left the linked site, but not one inside it", async () => {
    const { host, callTool } = executor({
      access: { assets: true, websites: true, websiteFiles: true },
    });

    host.websiteFileResult = {
      url: redirecting,
      finalUrl: OTHER,
      kind: "stylesheet",
      mimeType: "text/css",
      bytes: 10,
      text: "body { color: red }",
    };
    const file = await callTool("get_website_file", { url: redirecting, mode: "read" });
    expect(file.isError).toBe(true);
    expect(file.text).not.toContain("body { color: red }");

    host.recordResult = {
      path: "assets/web/victim-other-site.com/recordings/page.mp4",
      finalUrl: OTHER,
      width: 1920,
      height: 1080,
      duration: 4,
      bytes: 100,
      notes: [],
    };
    const recording = await callTool("record_website", { url: redirecting, seconds: 4 });
    expect(recording.isError).toBe(true);

    host.websiteFileResult = {
      url: "https://linear.app/a.css",
      finalUrl: "https://docs.linear.app/a.css",
      kind: "stylesheet",
      mimeType: "text/css",
      bytes: 10,
      text: "body { color: blue }",
    };
    const inside = await callTool("get_website_file", {
      url: "https://linear.app/a.css",
      mode: "read",
    });
    expect(inside.isError).toBeUndefined();
    expect(inside.text).toContain("body { color: blue }");
  });
});

describe("the site scope the runtime hands Studio", () => {
  it("names the linked sites on a read, a file and a recording, so Studio can stop a redirect itself", async () => {
    const { host, call, callTool } = executor({
      access: { assets: true, websites: true, websiteFiles: true },
    });
    await call({ url: "https://www.linear.app/pricing" });
    await callTool("get_website_file", { url: "https://linear.app/a.css", mode: "read" });
    await callTool("record_website", { url: "https://docs.linear.app/", seconds: 4 });

    expect(host.websiteRequests.map((request) => request.allowedSites)).toEqual([["linear.app"]]);
    expect(host.websiteFileRequests.map((request) => request.allowedSites)).toEqual([
      ["linear.app"],
    ]);
    expect(host.recordRequests.map((request) => request.allowedSites)).toEqual([["linear.app"]]);
  });

  it("adds the site of a CDN file an earlier read listed, and nothing else", async () => {
    const resources = new WebsiteResourceLog();
    const { host, call, callTool } = executor({
      access: { assets: true, websites: true, websiteFiles: true },
      websites: { chatId: "chat-1", resources },
    });
    const site = sampleWebsiteStyle("https://linear.app/");
    host.websiteResult = {
      site: {
        ...site,
        resources: [
          {
            url: "https://cdn.assets-example.net/hero.mp4",
            kind: "video",
            mimeType: "video/mp4",
            bytes: 1000,
            width: null,
            height: null,
            duration: null,
            usage: "video",
          },
        ],
      },
      screenshots: [],
    };
    await call({ url: "https://linear.app/" });
    await callTool("get_website_file", {
      url: "https://cdn.assets-example.net/hero.mp4",
      mode: "save",
    });

    expect(host.websiteFileRequests[0]?.allowedSites).toEqual(["linear.app", "assets-example.net"]);
  });

  it("sends at most the cap of sites when the chat linked more, always with the request's own site", async () => {
    const many = Array.from({ length: 60 }, (_, index) => `https://site-${index}.example`);
    const resources = new WebsiteResourceLog();
    const { host, call, callTool } = executor({
      access: { assets: true, websites: true, websiteFiles: true },
      websites: { chatId: "chat-1", resources },
      userTexts: () => [many.join(" ")],
    });
    const site = sampleWebsiteStyle("https://site-59.example/");
    host.websiteResult = {
      site: {
        ...site,
        resources: [
          {
            url: "https://cdn.assets-example.net/hero.mp4",
            kind: "video",
            mimeType: "video/mp4",
            bytes: 1000,
            width: null,
            height: null,
            duration: null,
            usage: "video",
          },
        ],
      },
      screenshots: [],
    };

    await call({ url: "https://site-59.example/" });
    await callTool("get_website_file", {
      url: "https://cdn.assets-example.net/hero.mp4",
      mode: "save",
    });
    await callTool("record_website", { url: "https://site-58.example/", seconds: 4 });

    const read = host.websiteRequests[0]?.allowedSites ?? [];
    const file = host.websiteFileRequests[0]?.allowedSites ?? [];
    const record = host.recordRequests[0]?.allowedSites ?? [];
    expect(read).toHaveLength(MAX_ALLOWED_SITES);
    expect(read[0]).toBe("site-59.example");
    expect(file).toHaveLength(MAX_ALLOWED_SITES);
    expect(file[0]).toBe("assets-example.net");
    expect(record).toHaveLength(MAX_ALLOWED_SITES);
    expect(record[0]).toBe("site-58.example");
  });

  it("judges a redirect by the sites it sent Studio, so a CDN file that moves within its CDN is not reported blocked", async () => {
    const resources = new WebsiteResourceLog();
    const { host, call, callTool } = executor({
      access: { assets: true, websites: true, websiteFiles: true },
      websites: { chatId: "chat-1", resources },
    });
    const site = sampleWebsiteStyle("https://linear.app/");
    host.websiteResult = {
      site: {
        ...site,
        resources: [
          {
            url: "https://cdn.assets-example.net/pkg",
            kind: "video",
            mimeType: "video/mp4",
            bytes: 1000,
            width: null,
            height: null,
            duration: null,
            usage: "video",
          },
        ],
      },
      screenshots: [],
    };
    await call({ url: "https://linear.app/" });
    host.websiteFileResult = {
      url: "https://cdn.assets-example.net/pkg",
      finalUrl: "https://cdn.assets-example.net/pkg@1.2.3/hero.mp4",
      kind: "video",
      mimeType: "video/mp4",
      bytes: 10,
    };

    const moved = await callTool("get_website_file", {
      url: "https://cdn.assets-example.net/pkg",
      mode: "save",
    });
    expect(moved.isError).toBeUndefined();
    expect(moved.text).not.toContain("blocked_by_policy");

    // Studio would refuse a hop outside the list it was sent, so the runtime refuses it too.
    host.websiteFileResult = {
      url: "https://cdn.assets-example.net/pkg",
      finalUrl: "https://elsewhere.example.org/hero.mp4",
      kind: "video",
      mimeType: "video/mp4",
      bytes: 10,
    };
    const left = await callTool("get_website_file", {
      url: "https://cdn.assets-example.net/pkg",
      mode: "save",
    });
    expect(left.isError).toBe(true);
    expect(left.text).toContain("blocked_by_policy");
  });
});

describe("read_website results", () => {
  it("passes the screenshots through as images and summarizes the style with how to use the fonts", async () => {
    const { call } = executor();
    const result = await call({ url: "https://linear.app", save: true });
    expect(result.images).toEqual([
      { mimeType: "image/jpeg", data: "AAAA" },
      { mimeType: "image/jpeg", data: "BBBB" },
    ]);
    expect(result.text).toContain("#5e6ad2 · accent");
    expect(result.text).toContain('"Inter"');
    expect(result.text).toContain("Google Fonts");
    expect(result.text).toContain(
      '@font-face { font-family: "Brand Display"; src: url("assets/web/linear.app/brand-display-700.woff2")',
    );
    expect(result.text).toContain("Logo file: assets/web/linear.app/logo.svg");
    expect(result.text).toContain("license unknown");
  });

  it("lists the page's files media first, with size, dimensions and usage, and where they can be fetched", async () => {
    const { call } = executor();
    const result = await call({ url: "https://linear.app" });
    expect(result.text).toContain("Files the page uses (5, media first):");
    expect(result.text).toContain(
      "- video · 1920×1080 · 6.5 s · 4.2 MB · linear.app/media/hero.mp4",
    );
    expect(result.text).toContain("· <video> autoplay loop in .hero");
    const video = result.text.indexOf("hero.mp4");
    const image = result.text.indexOf("product.png");
    const animation = result.text.indexOf("loader.json");
    expect(video).toBeGreaterThan(-1);
    expect(video).toBeLessThan(image);
    expect(image).toBeLessThan(animation);
    expect(result.text).toContain("cdn.example-cdn.com/lottie/loader.json");
    expect(result.text).toContain(
      "if full access to linked sites is off, the call asks the user in chat",
    );

    // With full access on the model is told to fetch them instead of imitating.
    const full = executor({
      access: { assets: true, websites: true, websiteFiles: true },
    });
    const withAccess = await full.call({ url: "https://linear.app" });
    expect(withAccess.text).toContain('Fetch one with get_website_file (mode "save"');
    expect(withAccess.text).toContain("record_website");
  });

  it("caps the file list and counts the rest", async () => {
    const { host, call } = executor();
    const base = sampleWebsiteStyle("https://linear.app");
    host.websiteResult = {
      site: {
        ...base,
        resources: Array.from({ length: 45 }, (_, index) => ({
          url: `https://linear.app/img/${index}.png`,
          kind: "image",
          mimeType: "image/png",
          bytes: 10_000,
          width: 100,
          height: 100,
          duration: null,
          usage: "card",
        })),
      },
      screenshots: [],
    };
    const result = await call({ url: "https://linear.app" });
    expect(result.text).toContain("Files the page uses (45, media first):");
    expect(result.text).toContain("- … and 5 more (not listed).");
    expect(result.text).not.toContain("img/44.png");
  });

  it("says nothing was saved when save is off", async () => {
    const { host, call } = executor();
    const result = await call({ url: "https://linear.app" });
    expect(result.text).toContain("Nothing was saved");
    expect(host.websiteRequests).toEqual([
      { url: "https://linear.app", allowedSites: ["linear.app"], turnId: "turn-1" },
    ]);
  });

  it("sets turn, agent and model itself for a save, whatever the model sends", async () => {
    const { host, call } = executor();
    await call({
      url: "https://linear.app",
      save: true,
      turnId: "forged",
      agent: "user",
      model: "evil/model",
      requestId: "x",
    });
    expect(host.websiteRequests).toEqual([
      {
        url: "https://linear.app",
        allowedSites: ["linear.app"],
        save: true,
        turnId: "turn-1",
        agent: "director",
        model: null,
      },
    ]);
  });

  it("turns the server's switched-off refusal into a clear instruction", async () => {
    const { host, call } = executor();
    host.nextError = new ResearchToolError(
      "blocked_by_policy",
      "Reading linked websites is switched off.",
    );
    const result = await call({ url: "https://linear.app" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Reading linked websites is switched off.");
    expect(result.text).toContain("Reading linked websites is off");
    expect(result.text).toContain("do not retry this turn");
  });

  it("refuses a malformed call itself", async () => {
    const { host, call } = executor();
    for (const args of [{}, { url: "" }, { url: "https://linear.app", save: "yes" }]) {
      const result = await call(args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("invalid_request");
    }
    expect(host.websiteRequests).toEqual([]);
  });
});

describe("read_website is read-only in Ask turns", () => {
  it("refuses save in an Ask turn but still reads", async () => {
    const { host, call } = executor({ intent: "ask" });
    const saved = await call({ url: "https://linear.app", save: true });
    expect(saved.isError).toBe(true);
    expect(saved.text).toContain("cannot save files");
    expect(host.websiteRequests).toEqual([]);

    expect((await call({ url: "https://linear.app" })).isError).toBeUndefined();
    expect(host.websiteRequests).toHaveLength(1);
  });
});

// ── In a running turn: which texts count as the user's ───────────────────────

async function settled(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

describe("read_website in a running turn", () => {
  it("counts the first prompt and steering as the user's links, never what an agent wrote", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["motion"]);
      const gate = Promise.withResolvers<BackendPromptOutcome>();
      const results: Record<string, { isError?: boolean; text: string }> = {};
      fixture.backend.promptScript = async (input, session) => {
        if (session.input.agent !== "director") return "completed";
        // A link the assistant writes itself (a reply, a search result) never widens the scope.
        input.onEvent({
          type: "text.delta",
          delta: "Maybe look at https://assistant-linked.com too.",
        });
        results.fromAssistant = await session.callTool("read_website", {
          url: "https://assistant-linked.com",
        });
        results.fromPrompt = await session.callTool("read_website", { url: "https://linear.app" });
        results.activity = {
          text: JSON.stringify(
            session.input.hostTools
              .find((tool) => tool.name === "read_website")
              ?.activity?.({ url: "https://www.linear.app/x" }),
          ),
        };
        return gate.promise;
      };
      const turn = await fixture.turns.start(chat.id, {
        prompt: "вот ссылка https://linear.app — сделай 5-секундный моушн-интро в их стиле",
      });
      await waitUntil(() => results.activity !== undefined, "the first reads");

      await fixture.turns.steer(chat.id, turn.id, { text: "и ещё https://stripe.com/payments" });
      const director = fixture.backend.sessionsOf("director")[0];
      const steered = await director?.callTool("read_website", { url: "https://stripe.com" });
      gate.resolve("completed");
      await settled(fixture, chat.id);

      expect(results.fromAssistant?.isError).toBe(true);
      expect(results.fromAssistant?.text).toContain("not a page of a website the user linked");
      expect(results.fromPrompt?.isError).toBeUndefined();
      expect(steered?.isError).toBeUndefined();
      expect(fixture.research.websiteRequests.map((request) => request.url)).toEqual([
        "https://linear.app",
        "https://stripe.com",
      ]);
      expect(JSON.parse(results.activity?.text ?? "null")).toEqual({
        category: "inspect",
        label: "Reading linear.app",
        labelCode: "reading_host",
        labelParams: { host: "linear.app" },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("gives Motion the tool and stamps a saved read with the turn and the caller", async () => {
    const fixture = await createRuntimeFixture();
    await fixture.settings.update({ autonomy: { askBeforeDownloads: false } });
    try {
      const chat = await fixture.chats.create({}, ["motion"]);
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent === "director") {
          await session.callTool("delegate", {
            agent: "motion",
            title: "Intro",
            task: "Build the intro in linear.app's style",
          });
          await session.callTool("wait_for_agents", {});
        } else if (session.input.agent === "motion") {
          await session.callTool("read_website", { url: "https://linear.app", save: true });
        }
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Style me after https://linear.app" });
      await settled(fixture, chat.id);

      const turnId = fixture.chats.get(chat.id)?.turns[0]?.id;
      expect(fixture.research.websiteRequests).toEqual([
        {
          url: "https://linear.app",
          allowedSites: ["linear.app"],
          save: true,
          turnId,
          agent: "motion",
          model: null,
        },
      ]);
      expect(
        fixture.backend.sessionsOf("motion")[0]?.input.hostTools.map((tool) => tool.name),
      ).toContain("read_website");
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses save in an Ask turn through the whole turn runner", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({});
      let saved: { isError?: boolean; text: string } | undefined;
      fixture.backend.promptScript = async (_input, session) => {
        saved = await session.callTool("read_website", { url: "https://linear.app", save: true });
        return "completed";
      };
      await fixture.turns.start(chat.id, {
        prompt: "What colors does https://linear.app use?",
        intent: "ask",
      });
      await settled(fixture, chat.id);
      expect(saved?.isError).toBe(true);
      expect(saved?.text).toContain("Ask turn");
      expect(fixture.research.websiteRequests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

// ── Full access to linked sites ──────────────────────────────────────────────

describe("the website settings context line for website readers", () => {
  const ready = (websites: {
    readLinkedPages: boolean;
    fullAccess: boolean;
  }): ResearchTurnState => ({
    status: "ready",
    policy: researchPolicy({ websites }),
  });

  it("says full access is off and that a call asks the user in chat", () => {
    const line = websiteAccessLine(ready({ readLinkedPages: true, fullAccess: false }));
    expect(line).toContain("Full access to linked sites is off");
    expect(line).toContain("get_website_file");
    expect(line).toContain("record_website");
    expect(line).toContain("ask the user in chat");
  });

  it("says reading is off and that the tools ask the user in chat", () => {
    const line = websiteAccessLine(ready({ readLinkedPages: false, fullAccess: false }));
    expect(line).toContain("Reading linked pages is off");
    expect(line).toContain("read_website");
    expect(line).toContain("asks the user in chat");
  });

  it("says nothing when both settings are on or the policy could not be read", () => {
    expect(websiteAccessLine(ready({ readLinkedPages: true, fullAccess: true }))).toBe("");
    expect(websiteAccessLine(undefined)).toBe("");
    expect(websiteAccessLine({ status: "unavailable", reason: "Studio is down" })).toBe("");
  });
});

describe("full access in a running turn", () => {
  it("offers the full-access tools and omits the off line when the policy says full access is on", async () => {
    const fixture = await createRuntimeFixture();
    await fixture.settings.update({ autonomy: { askBeforeDownloads: false } });
    try {
      const chat = await fixture.chats.create({}, ["motion"]);
      fixture.research.policyResult = researchPolicy({
        websites: { readLinkedPages: true, fullAccess: true },
      });
      let motionTask = "";
      fixture.backend.promptScript = async (input, session) => {
        if (session.input.agent === "director") {
          await session.callTool("delegate", {
            agent: "motion",
            title: "Intro",
            task: "Build the intro in the site's style",
          });
          await session.callTool("wait_for_agents", {});
        } else if (session.input.agent === "motion") {
          motionTask = input.text;
          await session.callTool("get_website_file", {
            url: "https://linear.app/app.css",
            mode: "read",
          });
        }
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Style me after https://linear.app" });
      await settled(fixture, chat.id);

      const names =
        fixture.backend.sessionsOf("motion")[0]?.input.hostTools.map((tool) => tool.name) ?? [];
      expect(names).toContain("read_website");
      expect(names).toContain("get_website_file");
      expect(names).toContain("record_website");
      expect(motionTask).not.toContain("Full access to linked sites is off");
      expect(fixture.research.websiteFileRequests).toEqual([
        {
          url: "https://linear.app/app.css",
          mode: "read",
          allowedSites: ["linear.app"],
          turnId: fixture.chats.get(chat.id)?.turns[0]?.id,
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("tells the readers the setting is off and still offers the tools, which ask the user in chat", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["motion"]);
      let directorPrompt = "";
      let motionTask = "";
      fixture.backend.promptScript = async (input, session) => {
        if (session.input.agent === "director") {
          directorPrompt = input.text;
          await session.callTool("delegate", {
            agent: "motion",
            title: "Intro",
            task: "Build the intro in the site's style",
          });
          await session.callTool("wait_for_agents", {});
        } else if (session.input.agent === "motion") {
          motionTask = input.text;
        }
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Style me after https://linear.app" });
      await settled(fixture, chat.id);

      expect(directorPrompt).toContain("Full access to linked sites is off");
      expect(motionTask).toContain("Full access to linked sites is off");
      expect(motionTask).toContain("ask the user in chat");
      // The tools are offered anyway: calling one asks the user instead of failing.
      const names =
        fixture.backend.sessionsOf("motion")[0]?.input.hostTools.map((tool) => tool.name) ?? [];
      expect(names).toContain("read_website");
      expect(names).toContain("get_website_file");
      expect(names).toContain("record_website");
      expect(fixture.research.websiteFileRequests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});
