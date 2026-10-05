import { describe, expect, it } from "vitest";
import type { AgentId, PermissionDecision, PermissionRequest } from "@hyperframes/agent-protocol";
import { downloadApprovalRefusal, downloadDeclinedRefusal } from "../autonomy.js";
import { PermissionBroker } from "../permissions.js";
import { FakeResearchHost, sampleCandidate } from "../testing/research.js";
import { TurnResearch, type TurnResearchOptions } from "./executor.js";
import { WebsiteResourceLog } from "./websiteResources.js";

/** Waits until the call reached the chat with a pending download card. */
async function pendingCard(published: PermissionRequest[]): Promise<PermissionRequest> {
  for (let i = 0; i < 100; i += 1) {
    const card = published.find((request) => request.state === "pending");
    if (card) return card;
    await Promise.resolve();
  }
  throw new Error("the permission request was never published");
}

interface Options {
  overrides?: Partial<TurnResearchOptions>;
  withBroker?: boolean;
  disableDownloadAsk?: (signal: AbortSignal) => Promise<void>;
}

/** A Research executor that asks before downloads, with a live broker (or none). */
function harness(options: Options = {}) {
  const host = new FakeResearchHost();
  host.searchCandidates = [sampleCandidate("cand-1")];
  const published: PermissionRequest[] = [];
  const controller = new AbortController();
  let id = 0;
  const broker =
    options.withBroker === false
      ? null
      : new PermissionBroker({
          turnId: "turn-1",
          host,
          publish: async (permission) => {
            published.push(permission);
          },
          signal: controller.signal,
          ids: () => `perm-${++id}`,
          ...(options.disableDownloadAsk && { disableDownloadAsk: options.disableDownloadAsk }),
        });
  const turn = new TurnResearch({
    host,
    turnId: "turn-1",
    turnSignal: controller.signal,
    enabled: ["research"],
    turn: { mode: "normal", action: null },
    storyOptions: null,
    intent: "edit",
    permissions: broker,
    websites: { chatId: "chat-1", resources: new WebsiteResourceLog() },
    userTexts: () => [],
    turnUserTexts: () => [],
    askBeforeDownloads: true,
    model: () => "anthropic/claude-haiku",
    ...options.overrides,
  });
  const call = (name: string, args: unknown, caller: AgentId = "research") =>
    turn.execute(caller, name, args, new AbortController().signal);
  const answer = async (decision: PermissionDecision) => {
    const card = await pendingCard(published);
    if (!broker) throw new Error("no broker");
    return broker.answer(card.id, decision);
  };
  return { host, published, call, answer, controller, broker };
}

describe("an unapproved download asks the user in the chat", () => {
  it("publishes one asset_download card with the remembered candidate and resumes on Allow once", async () => {
    const { host, published, call, answer } = harness();
    await call("search_assets", { query: "waves", mediaKind: "video" });
    const importing = call("import_asset", { candidate: "cand-1" });
    const card = await pendingCard(published);
    expect(card).toMatchObject({
      kind: "asset_download",
      action: "download",
      site: "wikimedia.org",
      agent: "research",
      state: "pending",
      asset: { title: "Ocean waves", source: "Wikimedia Commons", license: "CC BY 4.0" },
    });
    expect(host.importRequests).toEqual([]);

    await answer("once");
    const result = await importing;
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("The user allowed downloads for this turn from the chat.");
    expect(host.importRequests).toHaveLength(1);
    expect(host.grants).toEqual([]);

    // The answer covers the rest of the turn: a second import asks nothing and carries no note.
    const second = await call("import_asset", { url: "https://example.com/b.mp4" });
    expect(second.isError).toBeUndefined();
    expect(second.text).not.toContain("The user allowed downloads");
    expect(host.importRequests).toHaveLength(2);
    expect(published.filter((request) => request.state === "pending")).toHaveLength(1);
  });

  it("names a URL import by its file name and host, and an unknown candidate by nothing", async () => {
    const { published, call, answer } = harness();
    const byUrl = call("import_asset", { url: "https://cdn.example.com/media/Big%20Wave.mp4" });
    const card = await pendingCard(published);
    expect(card).toMatchObject({
      site: "example.com",
      asset: { title: "Big Wave.mp4", source: "cdn.example.com", license: null },
    });
    await answer("once");
    await byUrl;

    const unknown = harness();
    const importing = unknown.call("import_asset", { candidate: "never-seen" });
    const unknownCard = await pendingCard(unknown.published);
    expect(unknownCard.site).toBeNull();
    expect(unknownCard).not.toHaveProperty("asset");
    await unknown.answer("deny");
    await importing;
  });

  it("calls the settings switch on Don't ask again and tells the model", async () => {
    const switched: AbortSignal[] = [];
    const { published, call, answer } = harness({
      disableDownloadAsk: async (signal) => void switched.push(signal),
    });
    const importing = call("import_asset", { candidate: "cand-1" });
    await pendingCard(published);
    expect((await answer("always")).state).toBe("enabled");
    const result = await importing;
    expect(result.text).toContain("The user turned asking before downloads off.");
    expect(switched).toHaveLength(1);
  });

  it("refuses with the declined text on Don't allow, and every later download of the turn without asking again", async () => {
    const { host, published, call, answer } = harness();
    const first = call("import_asset", { candidate: "cand-1" });
    await pendingCard(published);
    await answer("deny");
    const refused = await first;
    expect(refused).toEqual({ text: downloadDeclinedRefusal(), isError: true });

    const later = await call("import_asset", { url: "https://example.com/a.mp4" });
    expect(later).toEqual({ text: downloadDeclinedRefusal(), isError: true });
    expect(host.importRequests).toEqual([]);
    expect(published).toHaveLength(2);
  });

  it("refuses when the turn ends before the user answers", async () => {
    const { host, published, call, controller } = harness();
    const importing = call("import_asset", { candidate: "cand-1" });
    await pendingCard(published);
    controller.abort();
    const refused = await importing;
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("turn ended before the user answered");
    expect(host.importRequests).toEqual([]);
    expect(published.at(-1)?.state).toBe("expired");
  });

  it("shares one card between concurrent downloads", async () => {
    const { host, published, call, answer } = harness();
    const first = call("import_asset", { candidate: "cand-1" });
    const second = call("import_asset", { url: "https://example.com/a.mp4" });
    await pendingCard(published);
    await answer("once");
    expect((await first).isError).toBeUndefined();
    expect((await second).isError).toBeUndefined();
    expect(host.importRequests).toHaveLength(2);
    expect(published.filter((request) => request.state === "pending")).toHaveLength(1);
  });

  it("asks nothing when a message of the turn approves, in a resolve turn, or when the setting is off", async () => {
    const approved = harness({ overrides: { turnUserTexts: () => ["Download the ocean clip"] } });
    expect((await approved.call("import_asset", { candidate: "cand-1" })).isError).toBeUndefined();
    expect(approved.published).toEqual([]);

    const resolving = harness({
      overrides: { turn: { mode: "story", action: "resolve" } },
    });
    expect((await resolving.call("import_asset", { candidate: "cand-1" })).isError).toBeUndefined();
    expect(resolving.published).toEqual([]);

    const free = harness({ overrides: { askBeforeDownloads: false } });
    expect((await free.call("import_asset", { candidate: "cand-1" })).isError).toBeUndefined();
    expect(free.published).toEqual([]);
  });

  it("keeps the old text refusal when there is no chat to show a card in", async () => {
    const { host, call } = harness({ withBroker: false });
    const refused = await call("import_asset", { candidate: "cand-1" });
    expect(refused).toEqual({ text: downloadApprovalRefusal(), isError: true });
    expect(host.importRequests).toEqual([]);
  });
});

describe("resolving a Missing Asset node after the story was built", () => {
  const BUILD = { mode: "story", action: "build" } as const;

  it("allows resolveMissing before the build, then refuses it and resolve_missing_asset, and still imports loose files", async () => {
    let built = false;
    const { host, call } = harness({
      overrides: { turn: BUILD, storyBuilt: () => built, askBeforeDownloads: false },
    });
    expect(
      (await call("import_asset", { candidate: "cand-1", resolveMissing: "m1" })).isError,
    ).toBeUndefined();
    expect(host.importRequests[0]?.resolveMissing).toBe("m1");

    built = true;
    const late = await call("import_asset", { candidate: "cand-1", resolveMissing: "m2" });
    expect(late.isError).toBe(true);
    expect(late.text).toContain("already built in this turn");
    expect(late.text).toContain("edit_timeline");
    const lateResolve = await call("resolve_missing_asset", { missing: "m2", asset: "a.mp4" });
    expect(lateResolve.isError).toBe(true);
    expect(lateResolve.text).toContain("already built in this turn");
    expect(host.importRequests).toHaveLength(1);
    expect(host.resolveRequests).toEqual([]);

    // Late material is imported without resolveMissing, to be placed with edit_timeline.
    expect((await call("import_asset", { candidate: "cand-1" })).isError).toBeUndefined();
    expect(host.importRequests).toHaveLength(2);
    expect(host.importRequests[1]).not.toHaveProperty("resolveMissing");
  });

  it("refuses before the user is asked about the download", async () => {
    const { host, published, call } = harness({
      overrides: { turn: BUILD, storyBuilt: () => true },
    });
    const refused = await call("import_asset", { candidate: "cand-1", resolveMissing: "m1" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("already built in this turn");
    expect(published).toEqual([]);
    expect(host.importRequests).toEqual([]);
  });

  it("freezes nothing outside a build turn", async () => {
    const { host, call } = harness({
      overrides: { turn: { mode: "story", action: "resolve" }, storyBuilt: () => true },
    });
    expect(
      (await call("import_asset", { candidate: "cand-1", resolveMissing: "m1" })).isError,
    ).toBeUndefined();
    expect(
      (await call("resolve_missing_asset", { missing: "m1", asset: "a.mp4" })).isError,
    ).toBeUndefined();
    expect(host.importRequests).toHaveLength(1);
    expect(host.resolveRequests).toHaveLength(1);
  });
});
