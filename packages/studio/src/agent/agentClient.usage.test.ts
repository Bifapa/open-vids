import { describe, expect, it, vi } from "vitest";
import { createAgentClient } from "./agentClient";

const REPORT = {
  period: { since: null, until: null },
  total: {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
    unpricedTokens: 0,
  },
  byAgent: [],
  byModel: [],
  byChat: [],
  live: false,
};

function requestedUrl(query: { since: number | null; until: number | null }): Promise<string> {
  const fetchImpl = vi.fn(async () => Response.json(REPORT));
  return createAgentClient("demo", { fetchImpl })
    .getUsage(query)
    .then(() => String(fetchImpl.mock.calls[0]?.[0]));
}

describe("getUsage", () => {
  it("sends the period, also where URLSearchParams has no `size` (WebKit 16, the app's macOS 11 floor)", async () => {
    // Safari 16 lacks the property: a client that reads it would drop the period and report all-time figures.
    const sizeless = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size");
    Object.defineProperty(URLSearchParams.prototype, "size", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(await requestedUrl({ since: 1_000, until: 2_000 })).toMatch(
        /\/agent\/usage\?since=1000&until=2000$/,
      );
      expect(await requestedUrl({ since: null, until: null })).toMatch(/\/agent\/usage$/);
    } finally {
      if (sizeless) Object.defineProperty(URLSearchParams.prototype, "size", sizeless);
    }
  });
});
