// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENVIDS_TABS_CHANGED_EVENT, type TabsSnapshot } from "../utils/openvidsTabs";
import { TABS_SAFETY_POLL_MS, useProjectTabs, type ProjectTabs } from "./useProjectTabs";

// happy-dom's globalThis lacks the React act-environment flag type.
const reactActEnv: { IS_REACT_ACT_ENVIRONMENT: boolean } = globalThis as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
reactActEnv.IS_REACT_ACT_ENVIRONMENT = true;

const HOME = "http://127.0.0.1:57035";
const OWN = "9f2c0a41b7d3e8c5";
const OTHER = "0123456789abcdef";
const ENABLED_URL = `/?openvidsHome=${encodeURIComponent(HOME)}&openvidsChannel=beta&openvidsTab=${OWN}`;

function tabsAnswer(...names: string[]): TabsSnapshot {
  return {
    enabled: true,
    active: "home",
    limit: 6,
    tabs: names.map((name, index) => ({
      key: index === 0 ? OWN : OTHER.slice(0, 15) + String(index),
      name,
      state: "open",
    })),
  };
}

/** A stand-in for the shell's home server: what `/api/tabs*` answers, and how it was asked. */
interface FakeHome {
  tabs: unknown;
  tabsReads: number;
  tabsInFlight: number;
  maxTabsInFlight: number;
  /** While set, `GET /api/tabs` waits for it (a slow read). */
  hold: Promise<void> | null;
  closeAnswer: Promise<unknown>;
  requests: string[];
}

let home: FakeHome;

function installHome(): void {
  home = {
    tabs: tabsAnswer("Alpha", "Beta"),
    tabsReads: 0,
    tabsInFlight: 0,
    maxTabsInFlight: 0,
    hold: null,
    closeAnswer: Promise.resolve({ closed: true }),
    requests: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.slice(HOME.length);
      home.requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/tabs") {
        home.tabsReads += 1;
        home.tabsInFlight += 1;
        home.maxTabsInFlight = Math.max(home.maxTabsInFlight, home.tabsInFlight);
        await home.hold;
        home.tabsInFlight -= 1;
        return { ok: true, json: async () => home.tabs };
      }
      if (path === "/api/tabs/close") return { ok: true, json: async () => home.closeAnswer };
      return { ok: true, json: async () => ({ ok: true }) };
    }),
  );
}

let visibility: DocumentVisibilityState = "visible";
let root: Root | null = null;
let hostEl: HTMLElement | null = null;
const seen: { latest: ProjectTabs | null } = { latest: null };

function Harness() {
  seen.latest = useProjectTabs();
  return null;
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(url: string = ENABLED_URL): Promise<void> {
  window.history.replaceState(null, "", url);
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  const mounted = root;
  act(() => mounted.render(<Harness />));
  await settle();
}

async function setVisibility(next: DocumentVisibilityState): Promise<void> {
  visibility = next;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function pushFromShell(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(OPENVIDS_TABS_CHANGED_EVENT));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  seen.latest = null;
  installHome();
});

afterEach(() => {
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  root = null;
  hostEl?.remove();
  hostEl = null;
  Reflect.deleteProperty(document, "visibilityState");
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("useProjectTabs gating", () => {
  it.each([
    ["the beta flag", `/?openvidsHome=${encodeURIComponent(HOME)}&openvidsTab=${OWN}`],
    ["a home origin", `/?openvidsChannel=beta&openvidsTab=${OWN}`],
    [
      "a valid home origin",
      `/?openvidsHome=${encodeURIComponent("http://evil.example:80")}&openvidsChannel=beta&openvidsTab=${OWN}`,
    ],
    ["a tab key", `/?openvidsHome=${encodeURIComponent(HOME)}&openvidsChannel=beta`],
    [
      "a well-formed tab key",
      `/?openvidsHome=${encodeURIComponent(HOME)}&openvidsChannel=beta&openvidsTab=home`,
    ],
  ])("draws nothing and asks the shell nothing without %s", async (_missing, url) => {
    await mount(url);
    await pushFromShell();
    await settle(TABS_SAFETY_POLL_MS * 3);
    expect(seen.latest).toBeNull();
    expect(home.requests).toEqual([]);
  });

  it("stays null until the shell answers, then offers its own key and the list", async () => {
    const slow = Promise.withResolvers<void>();
    home.hold = slow.promise;
    await mount();
    expect(seen.latest).toBeNull();
    slow.resolve();
    await settle();
    expect(seen.latest?.ownKey).toBe(OWN);
    expect(seen.latest?.snapshot).toEqual(tabsAnswer("Alpha", "Beta"));
    expect(seen.latest?.closingKey).toBeNull();
    expect(home.requests).toEqual(["GET /api/tabs"]);
  });

  it("is null when the shell says tabs are disabled, and again if it turns them off later", async () => {
    home.tabs = { enabled: false };
    await mount();
    expect(seen.latest).toBeNull();

    home.tabs = tabsAnswer("Alpha");
    await pushFromShell();
    expect(seen.latest?.snapshot.tabs).toHaveLength(1);

    home.tabs = { enabled: false };
    await pushFromShell();
    expect(seen.latest).toBeNull();
  });
});

describe("useProjectTabs refetching", () => {
  it("reads again when the shell pushes openvids-tabs-changed", async () => {
    await mount();
    expect(home.tabsReads).toBe(1);
    home.tabs = tabsAnswer("Alpha", "Beta", "Gamma");
    await pushFromShell();
    expect(home.tabsReads).toBe(2);
    expect(seen.latest?.snapshot.tabs.map((tab) => tab.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("reads again on focus and when the page becomes visible", async () => {
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(home.tabsReads).toBe(2);

    await setVisibility("hidden");
    expect(home.tabsReads).toBe(2);
    await setVisibility("visible");
    expect(home.tabsReads).toBe(3);
  });

  it("re-reads every 10 seconds while visible, and only then", async () => {
    await mount();
    await settle(TABS_SAFETY_POLL_MS - 1);
    expect(home.tabsReads).toBe(1);
    await settle(1);
    expect(home.tabsReads).toBe(2);
    await settle(TABS_SAFETY_POLL_MS);
    expect(home.tabsReads).toBe(3);
  });

  it("never reads while hidden, not on a timer, a push or a focus; shown again it reads at once and resumes", async () => {
    await mount();
    await setVisibility("hidden");
    const before = home.tabsReads;

    await settle(TABS_SAFETY_POLL_MS * 4);
    await pushFromShell();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(home.tabsReads).toBe(before);

    home.tabs = tabsAnswer("Alpha", "Delta");
    await setVisibility("visible");
    expect(home.tabsReads).toBe(before + 1);
    expect(seen.latest?.snapshot.tabs.map((tab) => tab.name)).toEqual(["Alpha", "Delta"]);
    await settle(TABS_SAFETY_POLL_MS);
    expect(home.tabsReads).toBe(before + 2);
  });

  it("does not poll at all when it mounts hidden, until the page is shown", async () => {
    visibility = "hidden";
    await mount();
    await settle(TABS_SAFETY_POLL_MS * 3);
    expect(home.tabsReads).toBe(0);
    await setVisibility("visible");
    expect(home.tabsReads).toBe(1);
  });

  it("never overlaps reads: a push during a slow read is read once more after it", async () => {
    const slow = Promise.withResolvers<void>();
    home.hold = slow.promise;
    await mount();
    expect(home.tabsReads).toBe(1);

    await pushFromShell();
    await pushFromShell();
    await settle(TABS_SAFETY_POLL_MS);
    expect(home.tabsReads).toBe(1);

    // The shell's change landed while the first read was out: its answer may predate it.
    home.hold = null;
    home.tabs = tabsAnswer("Alpha", "Late");
    slow.resolve();
    await settle();
    expect(home.tabsReads).toBe(2);
    expect(home.maxTabsInFlight).toBe(1);
    expect(seen.latest?.snapshot.tabs.map((tab) => tab.name)).toEqual(["Alpha", "Late"]);
  });

  it("keeps the strip it has when a read fails or answers nonsense", async () => {
    await mount();
    home.tabs = { enabled: true, tabs: "nope" };
    await pushFromShell();
    expect(seen.latest?.snapshot).toEqual(tabsAnswer("Alpha", "Beta"));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await pushFromShell();
    expect(seen.latest?.snapshot).toEqual(tabsAnswer("Alpha", "Beta"));
  });

  it("returns the same snapshot object when a read changed nothing", async () => {
    await mount();
    const first = seen.latest?.snapshot;
    await pushFromShell();
    expect(home.tabsReads).toBe(2);
    expect(seen.latest?.snapshot).toBe(first);
  });

  it("removes its listeners and timer when it unmounts", async () => {
    await mount();
    const mounted = root;
    if (!mounted) throw new Error("not mounted");
    act(() => mounted.unmount());
    root = null;
    const reads = home.tabsReads;

    await pushFromShell();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await setVisibility("hidden");
    await setVisibility("visible");
    await settle(TABS_SAFETY_POLL_MS * 3);
    expect(home.tabsReads).toBe(reads);
  });
});

describe("useProjectTabs actions", () => {
  it("activate asks the shell for that tab, and reads the list again only when it refused", async () => {
    await mount();
    act(() => seen.latest?.activate("home"));
    await settle();
    expect(home.requests).toEqual(["GET /api/tabs", "POST /api/tabs/activate"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        home.requests.push(url.slice(HOME.length));
        return url.endsWith("/activate")
          ? { ok: false, json: async () => ({ error: "still opening" }) }
          : { ok: true, json: async () => home.tabs };
      }),
    );
    home.requests.length = 0;
    act(() => seen.latest?.activate(OTHER));
    await settle();
    expect(home.requests).toEqual(["/api/tabs/activate", "/api/tabs"]);
  });

  it("close sends one request however often it is called, flags the tab while it waits, then reads again", async () => {
    const dialog = Promise.withResolvers<unknown>();
    home.closeAnswer = dialog.promise;
    await mount();
    home.requests.length = 0;

    act(() => {
      seen.latest?.close(OTHER);
      seen.latest?.close(OTHER);
      seen.latest?.close(OWN);
    });
    await settle();
    expect(home.requests).toEqual(["POST /api/tabs/close"]);
    expect(seen.latest?.closingKey).toBe(OTHER);

    home.tabs = tabsAnswer("Alpha");
    dialog.resolve({ closed: true });
    await settle();
    expect(seen.latest?.closingKey).toBeNull();
    expect(home.requests).toEqual(["POST /api/tabs/close", "GET /api/tabs"]);
    expect(seen.latest?.snapshot.tabs).toHaveLength(1);
  });

  it("close frees the tab again when the user cancels the shell's dialog", async () => {
    home.closeAnswer = Promise.resolve({ closed: false, cancelled: true });
    await mount();
    act(() => seen.latest?.close(OTHER));
    await settle();
    expect(seen.latest?.closingKey).toBeNull();
    expect(seen.latest?.snapshot.tabs).toHaveLength(2);

    // Free again: a second attempt goes out.
    home.requests.length = 0;
    act(() => seen.latest?.close(OTHER));
    await settle();
    expect(home.requests[0]).toBe("POST /api/tabs/close");
  });
});
