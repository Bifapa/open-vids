import { describe, expect, it } from "vitest";
import { isUsageReport, parseUsageEntry, parseUsageQuery, usageEntryKey } from "./index.js";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: null };
const line = {
  chatId: "c",
  chatTitle: "T",
  turnId: "t",
  runId: null,
  agent: "director",
  model: null,
  usage,
  at: 5,
};

describe("parseUsageEntry", () => {
  it("reads a journal line and refuses anything that is not one", () => {
    expect(parseUsageEntry(line)).toEqual(line);
    expect(parseUsageEntry({ ...line, internal: "render_qa", agent: "vision" })).toMatchObject({
      internal: "render_qa",
    });
    for (const broken of [
      { ...line, agent: "stranger" },
      { ...line, internal: "other" },
      { ...line, usage: { ...usage, cost: "1" } },
      { ...line, at: Number.NaN },
      { ...line, runId: 4 },
      "text",
    ]) {
      expect(parseUsageEntry(broken)).toBeNull();
    }
  });

  it("identifies a line by turn and run", () => {
    expect(usageEntryKey({ turnId: "t", runId: null })).not.toBe(
      usageEntryKey({ turnId: "t", runId: "r" }),
    );
  });
});

describe("parseUsageQuery", () => {
  it("takes epoch milliseconds and refuses an inverted or malformed period", () => {
    expect(parseUsageQuery(new URLSearchParams("since=10&until=20"))).toEqual({
      ok: true,
      value: { since: 10, until: 20 },
    });
    expect(parseUsageQuery(new URLSearchParams(""))).toEqual({
      ok: true,
      value: { since: null, until: null },
    });
    expect(parseUsageQuery(new URLSearchParams("since=20&until=10")).ok).toBe(false);
    expect(parseUsageQuery(new URLSearchParams("since=-1")).ok).toBe(false);
    expect(parseUsageQuery(new URLSearchParams("until=abc")).ok).toBe(false);
  });
});

describe("isUsageReport", () => {
  it("accepts a report and rejects a damaged one", () => {
    const slice = { usage, unpricedTokens: 3 };
    const report = {
      period: { since: null, until: null },
      total: slice,
      byAgent: [{ ...slice, agent: "render_qa", internal: true }],
      byModel: [{ ...slice, model: null }],
      byChat: [{ ...slice, chatId: "c", title: "T", deleted: false }],
      live: false,
    };
    expect(isUsageReport(report)).toBe(true);
    expect(
      isUsageReport({ ...report, byAgent: [{ ...slice, agent: "nobody", internal: true }] }),
    ).toBe(false);
    expect(isUsageReport({ ...report, live: "no" })).toBe(false);
  });
});
