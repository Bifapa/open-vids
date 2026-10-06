import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateTab,
  closeTab,
  fetchTabs,
  parseTabsSnapshot,
  readOpenvidsTabKey,
  sameTabsSnapshot,
  type TabsSnapshot,
} from "./openvidsTabs";

const HOME = "http://127.0.0.1:57035";
const KEY_A = "9f2c0a41b7d3e8c5";
const KEY_B = "0123456789abcdef";

const answer: TabsSnapshot = {
  enabled: true,
  active: "home",
  limit: 6,
  tabs: [
    { key: KEY_A, name: "My video", state: "open" },
    { key: KEY_B, name: "Other", state: "opening" },
  ],
};

describe("parseTabsSnapshot", () => {
  it("reads what the shell sends, tab order and states included", () => {
    expect(parseTabsSnapshot(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
  });

  it("takes an empty tab list and an active project key", () => {
    expect(parseTabsSnapshot({ enabled: true, active: KEY_A, limit: 6, tabs: [] })).toEqual({
      enabled: true,
      active: KEY_A,
      limit: 6,
      tabs: [],
    });
  });

  it("takes a bare enabled:false as a complete answer: draw nothing", () => {
    expect(parseTabsSnapshot({ enabled: false })).toEqual({
      enabled: false,
      active: "home",
      limit: 0,
      tabs: [],
    });
  });

  it.each([
    ["null", null],
    ["an array", [answer]],
    ["a string", "tabs"],
    ["no enabled flag", { active: "home", limit: 6, tabs: [] }],
    ["a truthy non-boolean enabled", { enabled: "yes", active: "home", limit: 6, tabs: [] }],
    ["a missing active", { enabled: true, limit: 6, tabs: [] }],
    ["an empty active", { enabled: true, active: "", limit: 6, tabs: [] }],
    ["a non-numeric limit", { enabled: true, active: "home", limit: "6", tabs: [] }],
    ["a fractional limit", { enabled: true, active: "home", limit: 2.5, tabs: [] }],
    ["a negative limit", { enabled: true, active: "home", limit: -1, tabs: [] }],
    ["tabs that are not a list", { enabled: true, active: "home", limit: 6, tabs: {} }],
    ["a tab that is not an object", { enabled: true, active: "home", limit: 6, tabs: ["x"] }],
    [
      "a tab without a key",
      { enabled: true, active: "home", limit: 6, tabs: [{ name: "A", state: "open" }] },
    ],
    [
      "a tab with an empty key",
      { enabled: true, active: "home", limit: 6, tabs: [{ key: "", name: "A", state: "open" }] },
    ],
    [
      "a tab whose name is not a string",
      { enabled: true, active: "home", limit: 6, tabs: [{ key: KEY_A, name: 7, state: "open" }] },
    ],
    [
      "a tab in an unknown state",
      {
        enabled: true,
        active: "home",
        limit: 6,
        tabs: [{ key: KEY_A, name: "A", state: "closed" }],
      },
    ],
    [
      "a repeated key",
      {
        enabled: true,
        active: "home",
        limit: 6,
        tabs: [
          { key: KEY_A, name: "A", state: "open" },
          { key: KEY_A, name: "B", state: "open" },
        ],
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(parseTabsSnapshot(value)).toBeNull();
  });

  it("rejects the whole answer when one tab is malformed, not just that tab", () => {
    expect(
      parseTabsSnapshot({
        enabled: true,
        active: "home",
        limit: 6,
        tabs: [{ key: KEY_A, name: "A", state: "open" }, { key: KEY_B }],
      }),
    ).toBeNull();
  });
});

describe("sameTabsSnapshot", () => {
  it("is true for an equal strip and false for any change a user could see", () => {
    expect(sameTabsSnapshot(answer, structuredClone(answer))).toBe(true);
    const renamed = structuredClone(answer);
    renamed.tabs[0].name = "Renamed";
    expect(sameTabsSnapshot(answer, renamed)).toBe(false);
    const opened = structuredClone(answer);
    opened.tabs[1].state = "open";
    expect(sameTabsSnapshot(answer, opened)).toBe(false);
    const reordered = { ...answer, tabs: [...answer.tabs].reverse() };
    expect(sameTabsSnapshot(answer, reordered)).toBe(false);
    expect(sameTabsSnapshot(answer, { ...answer, active: KEY_A })).toBe(false);
    expect(sameTabsSnapshot(answer, { ...answer, tabs: answer.tabs.slice(0, 1) })).toBe(false);
  });
});

describe("readOpenvidsTabKey", () => {
  it("reads a 16-digit lowercase hex key", () => {
    expect(readOpenvidsTabKey(`?openvidsHome=x&openvidsTab=${KEY_A}`)).toBe(KEY_A);
  });

  it.each([
    ["absent", "?openvidsHome=x"],
    ["empty", "?openvidsTab="],
    ["one digit short", `?openvidsTab=${KEY_A.slice(1)}`],
    ["one digit long", `?openvidsTab=${KEY_A}0`],
    ["uppercase", `?openvidsTab=${KEY_A.toUpperCase()}`],
    ["not hex", "?openvidsTab=zzzzzzzzzzzzzzzz"],
    ["a path traversal", "?openvidsTab=..%2F..%2F..%2F..%2F..%2Fx"],
    ["padded with whitespace", `?openvidsTab=%20${KEY_A.slice(1)}`],
    ["the reserved home key", "?openvidsTab=home"],
  ])("returns null when it is %s", (_label, search) => {
    expect(readOpenvidsTabKey(search)).toBeNull();
  });

  it("falls back to the current location when no query is given", () => {
    expect(readOpenvidsTabKey()).toBeNull();
  });
});

describe("the home server client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown, ok = true) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok,
      json: async () => body,
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("fetchTabs reads GET /api/tabs from the home origin and parses it", async () => {
    const fetchMock = stubFetch(answer);
    await expect(fetchTabs(HOME)).resolves.toEqual(answer);
    expect(fetchMock.mock.calls[0][0]).toBe(`${HOME}/api/tabs`);
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
  });

  it("fetchTabs is null for a malformed answer, a failed status, a network error or a bad origin", async () => {
    stubFetch({ enabled: true });
    await expect(fetchTabs(HOME)).resolves.toBeNull();
    stubFetch(answer, false);
    await expect(fetchTabs(HOME)).resolves.toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(fetchTabs(HOME)).resolves.toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("not json");
        },
      })),
    );
    await expect(fetchTabs(HOME)).resolves.toBeNull();
    const fetchMock = stubFetch(answer);
    await expect(fetchTabs("http://evil.example:80")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("activateTab posts the key as JSON and is true only for { ok: true }", async () => {
    const fetchMock = stubFetch({ ok: true });
    await expect(activateTab(HOME, KEY_A)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${HOME}/api/tabs/activate`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ key: KEY_A });

    stubFetch({ ok: false });
    await expect(activateTab(HOME, KEY_A)).resolves.toBe(false);
    stubFetch({ error: "still opening" }, false);
    await expect(activateTab(HOME, KEY_A)).resolves.toBe(false);
  });

  it("closeTab tells closed from cancelled from failed", async () => {
    const fetchMock = stubFetch({ closed: true });
    await expect(closeTab(HOME, KEY_A)).resolves.toBe("closed");
    expect(fetchMock.mock.calls[0][0]).toBe(`${HOME}/api/tabs/close`);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ key: KEY_A });

    stubFetch({ closed: false, cancelled: true });
    await expect(closeTab(HOME, KEY_A)).resolves.toBe("cancelled");
    stubFetch({ closed: false });
    await expect(closeTab(HOME, KEY_A)).resolves.toBe("failed");
    stubFetch({ error: "unknown tab" }, false);
    await expect(closeTab(HOME, KEY_A)).resolves.toBe("failed");
    stubFetch("closed");
    await expect(closeTab(HOME, KEY_A)).resolves.toBe("failed");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(closeTab(HOME, KEY_A)).resolves.toBe("failed");
  });
});
