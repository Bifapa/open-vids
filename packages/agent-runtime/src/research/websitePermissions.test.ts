import { describe, expect, it, vi } from "vitest";
import type { AgentId, ChatIntent, PermissionRequest } from "@hyperframes/agent-protocol";
import { PermissionBroker } from "../permissions.js";
import { TurnResearch } from "./executor.js";
import { ResearchToolError } from "./host.js";
import { FakeResearchHost, researchPolicy, sampleWebsiteStyle } from "../testing/research.js";
import { WebsiteResourceLog } from "./websiteResources.js";

/** Let the ask's publish microtask run. */
const tick = () => Promise.resolve();

/** Waits for the ask to reach the chat (the blocked-call path runs several microtasks first). */
async function asked(published: PermissionRequest[]): Promise<PermissionRequest> {
  for (let i = 0; i < 100; i += 1) {
    const first = published[0];
    if (first) return first;
    await Promise.resolve();
  }
  throw new Error("the permission request was never published");
}

/** Waits for a download card to reach the chat. */
async function assetCard(published: PermissionRequest[]): Promise<PermissionRequest> {
  for (let i = 0; i < 100; i += 1) {
    const card = published.find((request) => request.kind === "asset_download");
    if (card) return card;
    await Promise.resolve();
  }
  throw new Error("the download card was never published");
}
interface Harness {
  host: FakeResearchHost;
  broker: PermissionBroker;
  published: PermissionRequest[];
  call: (
    name: string,
    args: unknown,
    caller?: AgentId,
  ) => Promise<{ text: string; isError?: boolean }>;
  controller: AbortController;
}

/**
 * A turn whose Websites settings say `readLinkedPages`/`fullAccess` (the snapshot the turn read), with a live
 * permission broker: a call whose switch is off asks the user instead of failing.
 */
function harness(
  options: {
    readLinkedPages?: boolean;
    fullAccess?: boolean;
    askBeforeDownloads?: boolean;
    turnUserTexts?: string[];
    userTexts?: string[];
    intent?: ChatIntent;
    resources?: WebsiteResourceLog;
  } = {},
): Harness {
  const readLinkedPages = options.readLinkedPages ?? true;
  const fullAccess = options.fullAccess ?? false;
  const host = new FakeResearchHost();
  host.policyResult = researchPolicy({ websites: { readLinkedPages, fullAccess } });
  const published: PermissionRequest[] = [];
  let id = 0;
  const controller = new AbortController();
  const broker = new PermissionBroker({
    turnId: "turn-1",
    host,
    publish: async (permission) => {
      published.push(permission);
    },
    signal: controller.signal,
    now: () => 1_700_000_000_000,
    ids: () => `perm-${++id}`,
  });
  const turn = new TurnResearch({
    host,
    turnId: "turn-1",
    turnSignal: controller.signal,
    enabled: ["motion"],
    turn: { mode: "normal", action: null },
    storyOptions: null,
    intent: options.intent ?? "edit",
    access: { assets: true, websites: true, websiteFiles: readLinkedPages && fullAccess },
    websiteSettings: { readLinkedPages, fullAccess },
    permissions: broker,
    websites: { chatId: "chat-1", resources: options.resources ?? new WebsiteResourceLog() },
    userTexts: () => options.userTexts ?? ["look at https://linear.app — make a motion intro"],
    turnUserTexts: () => options.turnUserTexts ?? ["look at https://linear.app"],
    askBeforeDownloads: options.askBeforeDownloads ?? false,
    model: () => "anthropic/claude-haiku",
  });
  const call = (name: string, args: unknown, caller: AgentId = "director") =>
    turn.execute(caller, name, args, new AbortController().signal);
  return { host, broker, published, call, controller };
}

describe("a call whose setting is off asks the user in chat", () => {
  it("asks before reading when readLinkedPages is off, then reads with the once-grant", async () => {
    const { host, broker, published, call } = harness({ readLinkedPages: false });
    const reading = call("read_website", { url: "https://linear.app/pricing" });
    await tick();
    expect(published).toEqual([
      expect.objectContaining({
        id: "perm-1",
        kind: "read_linked_pages",
        action: "read",
        site: "linear.app",
        agent: "director",
        state: "pending",
      }),
    ]);
    // Nothing reached Studio before the user answered.
    expect(host.websiteRequests).toEqual([]);

    await broker.answer("perm-1", "once");
    const result = await reading;
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("The user allowed reading linked pages on linear.app once");
    expect(host.grants).toEqual([{ turnId: "turn-1", access: "read", site: "linear.app" }]);
    expect(host.policyUpdates).toEqual([]);
    // The retry carries the turn id so the grant matches it on the server.
    expect(host.websiteRequests).toEqual([
      { url: "https://linear.app/pricing", allowedSites: ["linear.app"], turnId: "turn-1" },
    ]);

    // A later read of the same turn does not ask again: the grant covers it.
    expect((await call("read_website", { url: "https://linear.app" })).isError).toBeUndefined();
    expect(published).toHaveLength(2);
    expect(host.websiteRequests).toHaveLength(2);
  });

  it("turns reading on for always and tells the model the user did", async () => {
    const { host, broker, published, call } = harness({ readLinkedPages: false });
    const reading = call("read_website", { url: "https://linear.app" });
    await tick();
    const answered = await broker.answer("perm-1", "always");
    expect(answered.state).toBe("enabled");
    const result = await reading;
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("The user turned reading linked pages on");
    expect(host.policyUpdates).toEqual([{ websites: { readLinkedPages: true } }]);
    expect(host.grants).toEqual([]);
    expect(published.map((permission) => permission.state)).toEqual(["pending", "enabled"]);
  });

  it("refuses the call when the user chooses Don't allow, and does not ask again in the turn", async () => {
    const { host, broker, published, call } = harness({ readLinkedPages: false });
    const reading = call("read_website", { url: "https://linear.app" });
    await tick();
    await broker.answer("perm-1", "deny");
    const refused = await reading;
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Don't allow");
    expect(refused.text).toContain("do not ask again in this turn");
    expect(host.websiteRequests).toEqual([]);

    const again = await call("read_website", { url: "https://linear.app" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("do not ask again");
    expect(published).toHaveLength(2);
    expect(host.websiteRequests).toEqual([]);
  });

  it("refuses the call when the turn ends before the user answers", async () => {
    const { host, broker, controller, call } = harness({ readLinkedPages: false });
    const reading = call("read_website", { url: "https://linear.app" });
    await tick();
    controller.abort();
    await broker.expireAll();
    const refused = await reading;
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("turn ended before the user answered");
    expect(host.websiteRequests).toEqual([]);
  });

  it("never asks for a URL the runtime's allowlist would refuse anyway", async () => {
    const { host, published, call } = harness({ readLinkedPages: false });
    const refused = await call("read_website", { url: "https://example.com" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("not a page of a website the user linked");
    expect(published).toEqual([]);
    expect(host.websiteRequests).toEqual([]);
    expect(host.policyUpdates).toEqual([]);
    expect(host.grants).toEqual([]);
  });

  it("asks for full access before get_website_file and record_website, with the tool's action", async () => {
    const { host, broker, published, call } = harness();
    const saving = call("get_website_file", { url: "https://linear.app/app.css", mode: "save" });
    await tick();
    expect(published[0]).toMatchObject({
      kind: "website_full_access",
      action: "download",
      site: "linear.app",
    });
    expect(host.websiteFileRequests).toEqual([]);
    await broker.answer("perm-1", "once");
    const saved = await saving;
    expect(saved.isError).toBeUndefined();
    expect(saved.text).toContain("The user allowed full access to linked sites on linear.app once");
    expect(saved.text).toContain("assets/web/linear.app/files/app.css");
    expect(host.grants).toEqual([{ turnId: "turn-1", access: "full", site: "linear.app" }]);
    expect(host.websiteFileRequests).toEqual([
      {
        url: "https://linear.app/app.css",
        mode: "save",
        allowedSites: ["linear.app"],
        turnId: "turn-1",
        agent: "director",
        model: "anthropic/claude-haiku",
      },
    ]);

    // The same full grant covers a recording and a code read: no further card.
    expect(
      (await call("record_website", { url: "https://linear.app", seconds: 4 })).isError,
    ).toBeUndefined();
    expect(
      (await call("get_website_file", { url: "https://linear.app/app.css", mode: "read" })).isError,
    ).toBeUndefined();
    expect(published).toHaveLength(2);
    expect(host.recordRequests).toEqual([
      {
        url: "https://linear.app",
        allowedSites: ["linear.app"],
        seconds: 4,
        turnId: "turn-1",
        agent: "director",
        model: "anthropic/claude-haiku",
      },
    ]);
  });

  it("does not ask for reading after a full-access allow in the same turn", async () => {
    const { host, broker, published, call } = harness({ readLinkedPages: false });
    const saving = call("get_website_file", { url: "https://linear.app/app.css", mode: "save" });
    await tick();
    await broker.answer("perm-1", "once");
    await saving;

    const reading = await call("read_website", { url: "https://linear.app" });
    expect(reading.isError).toBeUndefined();
    expect(reading.text).toContain("full access to linked sites on linear.app once");
    expect(published).toHaveLength(2);
    expect(host.websiteRequests).toEqual([
      { url: "https://linear.app", allowedSites: ["linear.app"], turnId: "turn-1" },
    ]);
  });

  it("turns both switches on for full access (reading included)", async () => {
    const { host, broker, call } = harness();
    const recording = call("record_website", { url: "https://linear.app", seconds: 4 });
    await tick();
    expect((await broker.answer("perm-1", "always")).state).toBe("enabled");
    const result = await recording;
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("The user turned full access to linked sites on");
    expect(host.policyUpdates).toEqual([{ websites: { readLinkedPages: true, fullAccess: true } }]);
  });

  it("counts the user's allow answer to a download card as the download approval when askBeforeDownloads is on", async () => {
    const { host, broker, published, call } = harness({
      readLinkedPages: false,
      askBeforeDownloads: true,
      turnUserTexts: ["look at https://linear.app"],
    });
    const saving = call("get_website_file", { url: "https://linear.app/app.css", mode: "save" });
    await tick();
    expect(published[0]).toMatchObject({ action: "download" });
    await broker.answer("perm-1", "once");
    const result = await saving;
    expect(result.isError).toBeUndefined();
    expect(result.text).not.toContain("Not downloaded");
    expect(host.websiteFileRequests).toHaveLength(1);
    expect(published).toHaveLength(2);
  });

  it("does not take an allow answer to an open-page card for a download approval: the save asks its own card", async () => {
    const { host, broker, published, call } = harness({
      readLinkedPages: false,
      askBeforeDownloads: true,
      turnUserTexts: ["look at https://linear.app"],
    });
    const saving = call("read_website", { url: "https://linear.app", save: true });
    await tick();
    expect(published[0]).toMatchObject({ kind: "read_linked_pages", action: "read" });
    await broker.answer("perm-1", "once");
    const download = await assetCard(published);
    expect(download).toMatchObject({
      kind: "asset_download",
      action: "download",
      site: "linear.app",
      agent: "director",
      state: "pending",
      asset: { title: "linear.app", source: "linear.app", license: null },
    });
    // The page was not saved before the user answered the download card.
    expect(host.websiteRequests).toEqual([]);
    await broker.answer(download.id, "once");
    const result = await saving;
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("The user allowed downloads for this turn from the chat.");
    expect(result.text).toContain("The user allowed reading linked pages on linear.app once");
    expect(host.websiteRequests).toHaveLength(1);
    expect(host.websiteRequests[0]).toMatchObject({ save: true });
  });

  it("needs no second download card for a website save after an allowed asset_download card", async () => {
    const { host, broker, published, call } = harness({
      readLinkedPages: true,
      fullAccess: true,
      askBeforeDownloads: true,
      turnUserTexts: ["look at https://linear.app"],
    });
    const first = call("get_website_file", { url: "https://linear.app/a.json", mode: "save" });
    const card = await asked(published);
    expect(card).toMatchObject({ kind: "asset_download", action: "download", site: "linear.app" });
    expect(card.asset).toMatchObject({ title: "a.json", source: "linear.app" });
    await broker.answer(card.id, "once");
    expect((await first).isError).toBeUndefined();

    const saved = await call("read_website", { url: "https://linear.app", save: true });
    const recorded = await call("record_website", { url: "https://linear.app", seconds: 4 });
    expect(saved.isError).toBeUndefined();
    expect(recorded.isError).toBeUndefined();
    expect(published.filter((request) => request.state === "pending")).toHaveLength(1);
    expect(host.websiteFileRequests).toHaveLength(1);
    expect(host.websiteRequests).toHaveLength(1);
    expect(host.recordRequests).toHaveLength(1);
  });

  it("refuses the website save and the recording of the turn after “Don't allow” on the download card", async () => {
    const { host, broker, published, call } = harness({
      readLinkedPages: true,
      fullAccess: true,
      askBeforeDownloads: true,
      turnUserTexts: ["look at https://linear.app"],
    });
    const recording = call("record_website", { url: "https://linear.app", seconds: 4 });
    const card = await asked(published);
    expect(card).toMatchObject({ kind: "asset_download", action: "record" });
    await broker.answer(card.id, "deny");
    const refused = await recording;
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("declined downloads");
    const saved = await call("read_website", { url: "https://linear.app", save: true });
    expect(saved.isError).toBe(true);
    expect(saved.text).toContain("declined downloads");
    expect(published).toHaveLength(2);
    expect(host.recordRequests).toEqual([]);
    expect(host.websiteRequests).toEqual([]);
  });

  it("re-reads the policy after a refusal and asks when the switch was turned off mid-turn", async () => {
    const { host, broker, published, call } = harness({ readLinkedPages: true });
    // The turn read "reading on", but the user switched it off in Settings: the server refuses once, and the
    // re-read sees the fresh policy.
    host.policyResult = researchPolicy({
      websites: { readLinkedPages: false, fullAccess: false },
    });
    host.nextError = new ResearchToolError(
      "blocked_by_policy",
      "Reading linked websites is turned off.",
    );
    const reading = call("read_website", { url: "https://linear.app" });
    const request = await asked(published);
    expect(request).toMatchObject({ kind: "read_linked_pages", state: "pending" });
    await broker.answer(request.id, "once");
    const result = await reading;
    expect(result.isError).toBeUndefined();
    expect(host.policyCalls).toBe(1);
    expect(host.websiteRequests).toHaveLength(2);
    expect(host.grants).toEqual([{ turnId: "turn-1", access: "read", site: "linear.app" }]);
  });

  it("keeps the refusal final when the fresh policy still allows the setting (the block was not the switch)", async () => {
    const { host, published, call } = harness({ readLinkedPages: true });
    host.nextError = new ResearchToolError(
      "blocked_by_policy",
      "Only public addresses may be read.",
    );
    const refused = await call("read_website", { url: "https://linear.app" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Only public addresses may be read.");
    expect(refused.text).toContain("do not retry this turn");
    expect(published).toEqual([]);
    expect(host.websiteRequests).toHaveLength(1);
  });

  it("asks again after a restart's lost grant only when the setting is off, and never for Ask turns", async () => {
    const ask = harness({ readLinkedPages: false, intent: "ask" });
    const refused = await ask.call("read_website", { url: "https://linear.app", save: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("cannot save files");
    expect(ask.published).toEqual([]);
  });

  it("asks again when Studio forgot the turn's Allow once (a restart), instead of refusing for good", async () => {
    const { host, broker, published, call } = harness({ readLinkedPages: false });
    const first = call("read_website", { url: "https://linear.app/pricing" });
    await tick();
    await broker.answer("perm-1", "once");
    expect((await first).isError).toBeUndefined();

    // Studio restarted: its in-memory grant is gone, but the broker still holds the answer.
    host.nextError = new ResearchToolError(
      "blocked_by_policy",
      "Reading linked websites is turned off.",
    );
    const second = call("read_website", { url: "https://linear.app/features" });
    const card = await vi.waitFor(() => {
      const pending = published.find((request) => request.id !== "perm-1");
      if (!pending) throw new Error("no second card yet");
      return pending;
    });
    expect(card).toMatchObject({ kind: "read_linked_pages", site: "linear.app", state: "pending" });
    await broker.answer(card.id, "once");
    const result = await second;
    expect(result.isError).toBeUndefined();
    expect(host.grants).toHaveLength(2);
    expect(host.websiteRequests).toHaveLength(3);
  });

  it("keeps the refusal final when the card it just showed was answered and Studio still says no", async () => {
    const { host, broker, published, call } = harness({ readLinkedPages: false });
    host.nextError = new ResearchToolError("blocked_by_policy", "Reading is off.");
    const reading = call("read_website", { url: "https://linear.app" });
    await tick();
    await broker.answer("perm-1", "once");
    const result = await reading;
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Reading is off.");
    // No second card: asking again would not change what Studio said to this very call.
    expect(published.filter((request) => request.state === "pending")).toHaveLength(1);
  });

  describe("per site", () => {
    const userTexts = ["https://linear.app and https://stripe.com and https://apple.com"];

    it("asks for each site on its own, and sends Studio only the sites the user allowed", async () => {
      const { host, broker, published, call } = harness({ readLinkedPages: false, userTexts });
      const linear = call("read_website", { url: "https://linear.app" });
      await tick();
      expect(published[0]).toMatchObject({ site: "linear.app", state: "pending" });
      await broker.answer("perm-1", "once");
      await linear;
      expect(host.websiteRequests[0]?.allowedSites).toEqual(["linear.app"]);

      const stripe = call("read_website", { url: "https://stripe.com/pricing" });
      await tick();
      expect(published.at(-1)).toMatchObject({
        id: "perm-2",
        site: "stripe.com",
        state: "pending",
      });
      await broker.answer("perm-2", "deny");
      const refused = await stripe;
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("stripe.com");
      expect(host.websiteRequests).toHaveLength(1);

      // linear.app stays allowed, with no new card, and its redirect scope still excludes the others.
      expect((await call("read_website", { url: "https://linear.app/x" })).isError).toBeUndefined();
      expect(host.websiteRequests[1]?.allowedSites).toEqual(["linear.app"]);
      // pending + allowed (linear), pending + denied (stripe); the repeated linear read showed no new card.
      expect(published).toHaveLength(4);
    });

    it("lets Turn on cover every linked site", async () => {
      const { host, broker, published, call } = harness({ readLinkedPages: false, userTexts });
      const first = call("read_website", { url: "https://linear.app" });
      await tick();
      await broker.answer("perm-1", "always");
      await first;
      host.policyResult = researchPolicy({
        websites: { readLinkedPages: true, fullAccess: false },
      });
      expect((await call("read_website", { url: "https://stripe.com" })).isError).toBeUndefined();
      expect(published).toHaveLength(2);
      expect(host.websiteRequests[1]?.allowedSites).toEqual([
        "linear.app",
        "stripe.com",
        "apple.com",
      ]);
    });
  });
});

describe("an address without a domain name", () => {
  it("is refused up front, with no card and no grant, even when a read of a linked site listed it", async () => {
    const resources = new WebsiteResourceLog();
    const site = sampleWebsiteStyle("https://linear.app/");
    const [template] = site.resources;
    if (!template) throw new Error("the sample site lists no resource");
    site.resources.push({ ...template, url: "https://203.0.113.9/app.js", kind: "script" });
    await resources.rememberRead("chat-1", { site, screenshots: [] });
    const { host, published, call } = harness({ fullAccess: false, resources });

    const result = await call("get_website_file", {
      url: "https://203.0.113.9/app.js",
      mode: "read",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("address without a domain name");
    expect(result.text).toContain("Ask the user for the site's own domain name");
    expect(published).toEqual([]);
    expect(host.grants).toEqual([]);
    expect(host.websiteFileRequests).toEqual([]);
  });
});
