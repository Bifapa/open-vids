import { describe, expect, it } from "vitest";
import {
  RESEARCH_LIMITS,
  type PermissionDecision,
  type PermissionRequest,
} from "@hyperframes/agent-protocol";
import { PermissionBroker } from "../permissions.js";
import { FakeResearchHost, ccBy, sampleCandidate, sampleProvenance } from "../testing/research.js";
import { waitUntil } from "../testing/runtimeFixture.js";
import { TurnResearch } from "./executor.js";
import { ResearchToolError } from "./host.js";
import { WebsiteResourceLog } from "./websiteResources.js";

/** Waits until the call reached the chat with a card of `kind`, and returns it. */
async function pendingCard(
  published: PermissionRequest[],
  kind: PermissionRequest["kind"],
): Promise<PermissionRequest> {
  const open = () =>
    published.filter((entry) => entry.kind === kind && entry.state === "pending").at(-1);
  await waitUntil(() => open() !== undefined, `a pending ${kind} card`);
  const card = open();
  if (!card) throw new Error(`no pending ${kind} card was published`);
  return card;
}

const NON_COMMERCIAL = ccBy({
  id: "cc_by_nc",
  name: "CC BY-NC 4.0",
  status: "restricted",
});

/** A Research executor with a live broker; downloads need no approval unless a test turns the ask on. */
function harness(askBeforeDownloads = false) {
  const host = new FakeResearchHost();
  const published: PermissionRequest[] = [];
  const controller = new AbortController();
  let id = 0;
  const broker = new PermissionBroker({
    turnId: "turn-1",
    host,
    publish: async (permission) => {
      published.push(permission);
    },
    signal: controller.signal,
    ids: () => `perm-${++id}`,
  });
  const research = new TurnResearch({
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
    askBeforeDownloads,
    model: () => "anthropic/claude-haiku",
  });
  const call = (name: string, args: unknown) =>
    research.execute("research", name, args, new AbortController().signal);
  const answer = async (kind: PermissionRequest["kind"], decision: PermissionDecision) =>
    broker.answer((await pendingCard(published, kind)).id, decision);
  return { host, published, call, answer };
}

describe("importing a restricted-license asset", () => {
  it("asks for the asset before the call when Research's results already said it is restricted", async () => {
    const { host, published, call, answer } = harness();
    host.searchCandidates = [sampleCandidate("nc-1", { title: "Sunset", license: NON_COMMERCIAL })];
    await call("search_assets", { query: "sunset", mediaKind: "video" });

    const importing = call("import_asset", { candidate: "nc-1" });
    const card = await pendingCard(published, "restricted_asset");
    expect(card).toMatchObject({
      action: "download",
      agent: "research",
      asset: { title: "Sunset", license: "CC BY-NC 4.0" },
    });
    // Nothing reached the server while the card is open.
    expect(host.importRequests).toEqual([]);

    await answer("restricted_asset", "once");
    const result = await importing;
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("restricted-license asset");
    expect(host.importRequests).toHaveLength(1);
    expect(host.importRequests[0]).toMatchObject({ candidate: "nc-1", allowRestricted: true });
  });

  it("refuses without calling the server when the user does not allow it", async () => {
    const { host, call, answer } = harness();
    host.searchCandidates = [sampleCandidate("nc-1", { license: NON_COMMERCIAL })];
    await call("search_assets", { query: "sunset", mediaKind: "video" });

    const importing = call("import_asset", { candidate: "nc-1" });
    await answer("restricted_asset", "deny");
    const result = await importing;
    expect(result.isError).toBe(true);
    expect(result.text).toContain("the user did not allow this restricted-license asset");
    expect(host.importRequests).toEqual([]);
  });

  it("asks after the server's refusal when the runtime did not know the asset, naming it from the refusal", async () => {
    const { host, published, call, answer } = harness();
    host.nextError = new ResearchToolError("restricted_license", "restricted", {
      title: "Rain loop",
      license: "CC BY-ND 4.0",
      source: "Flickr",
    });

    const importing = call("import_asset", { url: "https://example.com/rain.mp4" });
    const card = await pendingCard(published, "restricted_asset");
    expect(card.asset).toEqual({ title: "Rain loop", source: "Flickr", license: "CC BY-ND 4.0" });
    // The first attempt went out without the permission and was refused.
    expect(host.importRequests).toHaveLength(1);
    expect(host.importRequests[0]?.allowRestricted).toBeUndefined();

    await answer("restricted_asset", "once");
    const result = await importing;
    expect(result.isError).toBeUndefined();
    expect(host.importRequests).toHaveLength(2);
    expect(host.importRequests[1]).toMatchObject({
      url: "https://example.com/rain.mp4",
      allowRestricted: true,
    });
  });

  it("stops after the refusal when the user declines the card the refusal raised", async () => {
    const { host, call, answer } = harness();
    host.nextError = new ResearchToolError("restricted_license", "restricted", {
      title: "Rain loop",
    });
    const importing = call("import_asset", { url: "https://example.com/rain.mp4" });
    await answer("restricted_asset", "deny");
    const result = await importing;
    expect(result.isError).toBe(true);
    expect(host.importRequests).toHaveLength(1);
  });

  it("asks for each restricted asset on its own, even after downloads were approved", async () => {
    const { host, published, call, answer } = harness(true);
    host.searchCandidates = [
      sampleCandidate("nc-1", { license: NON_COMMERCIAL }),
      sampleCandidate("nc-2", { title: "Another", license: NON_COMMERCIAL }),
    ];
    await call("search_assets", { query: "sunset", mediaKind: "video" });

    const first = call("import_asset", { candidate: "nc-1" });
    await answer("asset_download", "once");
    await answer("restricted_asset", "once");
    expect((await first).isError).toBeUndefined();

    const second = call("import_asset", { candidate: "nc-2" });
    const secondCard = await pendingCard(published, "restricted_asset");
    expect(secondCard.asset?.title).toBe("Another");
    await answer("restricted_asset", "once");
    expect((await second).isError).toBeUndefined();
    const cardsOf = (kind: PermissionRequest["kind"]) =>
      new Set(published.filter((card) => card.kind === kind).map((card) => card.id));
    expect(cardsOf("restricted_asset").size).toBe(2);
    expect(cardsOf("asset_download").size).toBe(1);
  });
});

describe("the imports of one turn", () => {
  const LIMIT = RESEARCH_LIMITS.importsPerTurn;
  const urlOf = (index: number) => ({ url: `https://example.com/clip-${index}.mp4` });

  it("refuses the import after the limit with a clear text, without calling the server", async () => {
    const { host, call } = harness();
    for (let index = 0; index < LIMIT; index += 1) {
      expect((await call("import_asset", urlOf(index))).isError).toBeUndefined();
    }
    const refused = await call("import_asset", urlOf(LIMIT));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`at most ${LIMIT} imports per turn`);
    expect(host.importRequests).toHaveLength(LIMIT);
  });

  it("gives an import back when it failed or found a duplicate, so only new files count", async () => {
    const { host, call } = harness();
    for (let index = 0; index < LIMIT - 1; index += 1) await call("import_asset", urlOf(index));

    host.nextError = new ResearchToolError("studio_unavailable", "the site did not answer");
    expect((await call("import_asset", urlOf(100))).isError).toBe(true);

    host.importResult = {
      asset: "assets/research/ocean-waves.mp4",
      provenance: sampleProvenance(),
      fetch: "cache",
      duplicate: { asset: "assets/research/ocean-waves.mp4", reason: "same_url" },
      resolved: null,
      resolveError: null,
      warnings: [],
    };
    expect((await call("import_asset", urlOf(101))).isError).toBeUndefined();
    host.importResult = null;

    // The failed and the duplicate import did not use the last slot.
    expect((await call("import_asset", urlOf(102))).isError).toBeUndefined();
    const refused = await call("import_asset", urlOf(103));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Import limit reached");
  });

  it("lets only one of two parallel imports take the last slot", async () => {
    const { host, call } = harness();
    for (let index = 0; index < LIMIT - 1; index += 1) await call("import_asset", urlOf(index));

    const [first, second] = await Promise.all([
      call("import_asset", urlOf(200)),
      call("import_asset", urlOf(201)),
    ]);
    expect([first.isError, second.isError].filter((failed) => failed === true)).toHaveLength(1);
    expect(host.importRequests).toHaveLength(LIMIT);
  });

  it("gives the slot back when the user declines the restricted-license card", async () => {
    const { host, call, answer } = harness();
    host.searchCandidates = [sampleCandidate("nc-1", { license: NON_COMMERCIAL })];
    await call("search_assets", { query: "sunset", mediaKind: "video" });
    for (let index = 0; index < LIMIT - 1; index += 1) await call("import_asset", urlOf(index));

    const declined = call("import_asset", { candidate: "nc-1" });
    await answer("restricted_asset", "deny");
    expect((await declined).isError).toBe(true);

    expect((await call("import_asset", urlOf(300))).isError).toBeUndefined();
    expect((await call("import_asset", urlOf(301))).text).toContain("Import limit reached");
  });
});
