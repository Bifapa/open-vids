import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UsageEntry, UsageTotals } from "@hyperframes/agent-protocol";
import type { BackendPromptInput } from "../backend.js";
import type { ScriptedSession } from "../testing/backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { parseUsageJournal, UsageJournal } from "./journal.js";
import { buildUsageReport } from "./report.js";

const totals = (tokens: number, cost: number | null): UsageTotals => ({
  input: tokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: tokens,
  cost,
});

function entry(partial: Partial<UsageEntry> & Pick<UsageEntry, "turnId">): UsageEntry {
  return {
    chatId: "c1",
    chatTitle: "Chat",
    runId: null,
    agent: "director",
    model: { provider: "p", modelId: "m" },
    usage: totals(100, 0.1),
    at: 1_000,
    ...partial,
  };
}

const everyone = { since: null, until: null };
const titles = (...ids: string[]) => new Map(ids.map((id) => [id, `Title ${id}`]));

function report(
  journal: UsageEntry[],
  overrides: Partial<Parameters<typeof buildUsageReport>[0]> = {},
) {
  return buildUsageReport({
    journal,
    live: [],
    turnRunning: false,
    query: everyone,
    chatTitles: titles("c1"),
    ...overrides,
  });
}

describe("usage report fold", () => {
  it("makes the parts add up to the total, to the exact cost", () => {
    const entries = [
      entry({ turnId: "t1", usage: totals(10, 0.1) }),
      entry({ turnId: "t1", runId: "r1", agent: "editor", usage: totals(20, 0.2) }),
      entry({ turnId: "t2", runId: "r2", agent: "editor", usage: totals(30, 0.3) }),
      entry({ turnId: "t2", runId: "r3", agent: "vision", usage: totals(5, 0.7) }),
    ];
    const result = report(entries);
    expect(result.total.usage).toMatchObject({ totalTokens: 65, cost: 1.3 });
    for (const slices of [result.byAgent, result.byModel, result.byChat]) {
      expect(slices.reduce((sum, slice) => sum + slice.usage.totalTokens, 0)).toBe(65);
      expect(slices.reduce((sum, slice) => sum + (slice.usage.cost ?? 0), 0)).toBeCloseTo(1.3, 9);
    }
    expect(result.byAgent.map((slice) => [slice.agent, slice.usage.totalTokens])).toEqual([
      ["editor", 50],
      ["director", 10],
      ["vision", 5],
    ]);
  });

  it("never counts a missing cost as zero and marks the cost incomplete", () => {
    const result = report([
      entry({ turnId: "t1", usage: totals(100, null) }),
      entry({ turnId: "t2", runId: "r1", agent: "editor", usage: totals(50, 0.5) }),
    ]);
    expect(result.total).toMatchObject({ unpricedTokens: 100, usage: { cost: 0.5 } });
    expect(result.byAgent.find((slice) => slice.agent === "director")).toMatchObject({
      unpricedTokens: 100,
      usage: { cost: null },
    });
    expect(result.byAgent.find((slice) => slice.agent === "editor")?.unpricedTokens).toBe(0);
    expect(report([entry({ turnId: "t1", usage: totals(100, null) })]).total.usage.cost).toBeNull();
  });

  it("counts a repeated line once and a turn found in a copied chat once", () => {
    const first = entry({ turnId: "t1", usage: totals(10, 0.1) });
    const grown = entry({ turnId: "t1", usage: totals(40, 0.4) });
    const copy = entry({ turnId: "t1", chatId: "c2", usage: totals(40, 0.4) });
    const result = report([first, grown, copy], { chatTitles: titles("c1", "c2") });
    expect(result.total.usage.totalTokens).toBe(40);
  });

  it("filters by period on the turn's end time", () => {
    const entries = [
      entry({ turnId: "t1", at: 1_000 }),
      entry({ turnId: "t2", at: 2_000 }),
      entry({ turnId: "t3", at: 3_000 }),
    ];
    expect(report(entries, { query: { since: 2_000, until: 3_000 } }).total.usage.totalTokens).toBe(
      100,
    );
    expect(report(entries, { query: { since: 2_000, until: null } }).total.usage.totalTokens).toBe(
      200,
    );
  });

  it("keeps a deleted chat's usage in the totals, named by the title it had", () => {
    const entries = [
      entry({ turnId: "t1", chatId: "gone", chatTitle: "Old idea" }),
      entry({ turnId: "t2" }),
    ];
    const result = report(entries);
    expect(result.total.usage.totalTokens).toBe(200);
    expect(result.byChat.find((slice) => slice.chatId === "gone")).toMatchObject({
      deleted: true,
      title: "Old idea",
    });
    expect(result.byChat.find((slice) => slice.chatId === "c1")).toMatchObject({
      deleted: false,
      title: "Title c1",
    });
  });

  it("reports Render QA and Jev apart, adds the running turn, and prefers the journal", () => {
    const journal = [
      entry({ turnId: "t1", runId: "r1", agent: "vision", internal: "render_qa" }),
      entry({ turnId: "t1", runId: "r2", agent: "jev" }),
      entry({ turnId: "t1", runId: "r3", agent: "vision" }),
    ];
    const live = [
      entry({ turnId: "t1", runId: "r3", agent: "vision", usage: totals(999, 9) }),
      entry({ turnId: "t2", usage: totals(7, null) }),
    ];
    const result = report(journal, { live, turnRunning: true });
    expect(result.live).toBe(true);
    expect(result.total.usage.totalTokens).toBe(307);
    expect(result.byAgent.map((slice) => [slice.agent, slice.internal]).sort()).toEqual([
      ["director", false],
      ["jev", true],
      ["render_qa", true],
      ["vision", false],
    ]);
  });
});

const call = (input: number, cost: number | null) => ({
  type: "usage" as const,
  usage: totals(input, cost),
});

function scriptTurn(fixture: RuntimeFixture): void {
  let prompts = 0;
  fixture.backend.promptScript = async (input: BackendPromptInput, session: ScriptedSession) => {
    if (session.input.agent === "director") {
      // The Director is prompted again when its run has finished: only the first prompt reports and delegates.
      if ((prompts += 1) > 1) return "completed";
      input.onEvent(call(100, 0.1));
      await session.callTool("delegate", { agent: "editor", title: "Trim", task: "Trim" });
      await session.callTool("wait_for_agents", {});
      return "completed";
    }
    input.onEvent(call(50, null));
    return "completed";
  };
}

async function runTurn(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
  await fixture.chats.drain();
}

describe("usage of finished turns", () => {
  it("writes a line for the Director and for each run, and deleting the chat changes nothing", async () => {
    const fixture = await createRuntimeFixture();
    try {
      scriptTurn(fixture);
      const chat = await fixture.chats.create({}, ["editor"]);
      await runTurn(fixture, chat.id);

      const lines = await fixture.usage.all();
      expect(lines.map((line) => [line.agent, line.usage.totalTokens])).toEqual([
        ["director", 100],
        ["editor", 50],
      ]);
      const before = report(lines, { chatTitles: titles(chat.id) });
      expect(before.total).toMatchObject({ unpricedTokens: 50, usage: { totalTokens: 150 } });

      await fixture.turns.deleteChat(chat.id);
      const after = report(await fixture.usage.all(), { chatTitles: new Map() });
      expect(after.total).toEqual(before.total);
      expect(after.byChat).toMatchObject([{ chatId: chat.id, deleted: true }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rebuilds a missing journal from the chat logs, once, and leaves out turns from before a fork", async () => {
    const fixture = await createRuntimeFixture();
    try {
      scriptTurn(fixture);
      const chat = await fixture.chats.create({}, ["editor"]);
      await runTurn(fixture, chat.id);
      const journalFile = join(fixture.scope.projectDir, ".hyperframes", "agent", "usage.jsonl");
      await rm(journalFile);

      const rebuilt = new UsageJournal(fixture.scope.projectDir, fixture.store);
      expect((await rebuilt.all()).map((line) => line.usage.totalTokens)).toEqual([100, 50]);
      expect((await readFile(journalFile, "utf8")).trim().split("\n")).toHaveLength(2);

      // A fork copies the chats but starts its costs from zero.
      await rm(journalFile);
      const turnStart = fixture.chats.get(chat.id)?.turns[0]?.startedAt ?? 0;
      await writeFile(
        join(fixture.scope.projectDir, ".hyperframes", "agent", "fork.json"),
        JSON.stringify({ forkedAt: turnStart + 1 }),
      );
      expect(await new UsageJournal(fixture.scope.projectDir, fixture.store).all()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps what an aborted turn used, and rebuilds a turn that is still running as far as it got", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const reported = Promise.withResolvers<void>();
      fixture.backend.promptScript = async (input) => {
        input.onEvent(call(77, 0.7));
        reported.resolve();
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return "aborted";
      };
      const chat = await fixture.chats.create({}, []);
      const started = await fixture.turns.start(chat.id, { prompt: "Work" });
      await reported.promise;
      await fixture.chats.drain();
      // The runtime is gone mid-turn and its journal with it: the chat log is all that is left.
      const mid = new UsageJournal(fixture.scope.projectDir, fixture.store);
      expect((await mid.all()).map((line) => line.usage.totalTokens)).toEqual([77]);

      fixture.turns.abort(chat.id, started.id);
      await waitUntil(() => fixture.turns.activeTurn === null, "the turn to end");
      await fixture.chats.drain();
      const lines = await fixture.usage.all();
      expect(lines.map((line) => line.usage.totalTokens)).toEqual([77]);
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("aborted");
    } finally {
      await fixture.cleanup();
    }
  });

  it("skips a torn last line, and starts the next append on a new line", async () => {
    const fixture = await createRuntimeFixture();
    try {
      scriptTurn(fixture);
      const chat = await fixture.chats.create({}, ["editor"]);
      await runTurn(fixture, chat.id);
      const state = fixture.chats.get(chat.id);
      const turnId = state?.turns[0]?.id ?? "";
      const file = join(fixture.scope.projectDir, ".hyperframes", "agent", "usage.jsonl");
      const known = JSON.stringify(entry({ turnId: "older" }));
      await writeFile(file, `${known}\nnot json\n{"chatId":"c1","turnId":"half","ru`);

      const journal = new UsageJournal(fixture.scope.projectDir, fixture.store);
      expect((await journal.all()).map((line) => line.turnId)).toEqual(["older"]);
      if (state) await journal.recordTurn(state, turnId);
      const read = parseUsageJournal(await readFile(file, "utf8"));
      expect(read.map((line) => line.turnId)).toEqual(["older", turnId, turnId]);
    } finally {
      await fixture.cleanup();
    }
  });
});
