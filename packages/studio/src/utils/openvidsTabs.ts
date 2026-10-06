/**
 * Project tabs (beta feature `projectTabs`): the desktop shell keeps several projects open in one window,
 * each its own webview, and draws no chrome of its own. The pages draw the tab strip from what the shell's
 * home server answers, and ask it to switch or close a tab. Studio is a different loopback origin than the
 * home server and holds no home token, so it talks to the three `/api/tabs*` endpoints with a plain
 * `fetch` to the validated home origin, exactly like `invokeHomeMenuAction`: the home server grants its CORS
 * to the live Studio origin for these endpoints. Nothing here throws; an unreachable or confused home
 * server resolves `null` / `false` / `"failed"` and the strip keeps what it last knew.
 */
import { isRecord } from "@hyperframes/agent-protocol";
import { isValidOpenvidsHomeOrigin } from "./openvidsHost";

/** URL parameter the shell sets on a project webview (beta only): this page's own tab key. */
export const OPENVIDS_TAB_PARAM = "openvidsTab";

/** Window event the shell dispatches in every page whenever the tab list changed. */
export const OPENVIDS_TABS_CHANGED_EVENT = "openvids-tabs-changed";

/** The Projects page's tab key in `activateTab`; it is never part of the tab list. */
export const HOME_TAB_KEY = "home";

/** `open`: the project is ready; `opening`: its sidecar is still starting (no switching to it yet). */
export type ProjectTabState = "open" | "opening";

export interface ProjectTab {
  key: string;
  name: string;
  state: ProjectTabState;
}

export interface TabsSnapshot {
  /** False when the beta is off or the page is not in the desktop: draw nothing. */
  enabled: boolean;
  /** `"home"` or a project key. */
  active: string;
  /** Soft memory limit of open projects; the shell itself asks the user beyond it. */
  limit: number;
  /** Project tabs in tab order, without the Projects tab. */
  tabs: ProjectTab[];
}

export type CloseTabResult = "closed" | "cancelled" | "failed";

/** The shell mints 16 lowercase hex digits per project tab. */
const TAB_KEY_PATTERN = /^[0-9a-f]{16}$/;

function isProjectTabState(value: unknown): value is ProjectTabState {
  return value === "open" || value === "opening";
}

function parseProjectTab(value: unknown): ProjectTab | null {
  if (!isRecord(value)) return null;
  const { key, name, state } = value;
  if (typeof key !== "string" || key === "" || typeof name !== "string") return null;
  if (!isProjectTabState(state)) return null;
  return { key, name, state };
}

/**
 * Read the answer of `GET /api/tabs`. `{ enabled: false }` is a complete answer on its own (the rest is
 * ignored); an enabled one needs every field, with every tab well-formed and no key repeated. Anything
 * else is null, never a half-trusted snapshot.
 */
export function parseTabsSnapshot(value: unknown): TabsSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.enabled === false) return { enabled: false, active: HOME_TAB_KEY, limit: 0, tabs: [] };
  if (value.enabled !== true) return null;
  const { active, limit, tabs: rawTabs } = value;
  if (typeof active !== "string" || active === "") return null;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) return null;
  if (!Array.isArray(rawTabs)) return null;
  const tabs: ProjectTab[] = [];
  const seen = new Set<string>();
  for (const raw of rawTabs) {
    const tab = parseProjectTab(raw);
    if (!tab || seen.has(tab.key)) return null;
    seen.add(tab.key);
    tabs.push(tab);
  }
  return { enabled: true, active, limit, tabs };
}

/** Whether two answers describe the same strip, so a poll that changed nothing does not re-render it. */
export function sameTabsSnapshot(a: TabsSnapshot, b: TabsSnapshot): boolean {
  return (
    a.enabled === b.enabled &&
    a.active === b.active &&
    a.limit === b.limit &&
    a.tabs.length === b.tabs.length &&
    a.tabs.every((tab, index) => {
      const other = b.tabs[index];
      return (
        other !== undefined &&
        tab.key === other.key &&
        tab.name === other.name &&
        tab.state === other.state
      );
    })
  );
}

/**
 * This page's own tab key from the current location's query string (`openvidsTab`), or null when the shell
 * did not set one or it is not 16 lowercase hex digits.
 */
export function readOpenvidsTabKey(search?: string): string | null {
  let raw: string | null = null;
  try {
    const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
    raw = new URLSearchParams(query).get(OPENVIDS_TAB_PARAM);
  } catch {
    return null;
  }
  return raw !== null && TAB_KEY_PATTERN.test(raw) ? raw : null;
}

/** One request to the home server's tab endpoints: the parsed JSON body, or null on any failure. */
async function requestHomeTabs(
  homeOrigin: string,
  path: string,
  body?: { key: string },
): Promise<unknown> {
  try {
    if (!isValidOpenvidsHomeOrigin(homeOrigin)) return null;
    const response = await fetch(
      `${homeOrigin}${path}`,
      body === undefined
        ? { cache: "no-store" }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    if (!response.ok) return null;
    const data: unknown = await response.json().catch(() => null);
    return data;
  } catch {
    return null;
  }
}

/** The shell's current tab list, or null when it cannot be reached or answers something malformed. */
export async function fetchTabs(homeOrigin: string): Promise<TabsSnapshot | null> {
  return parseTabsSnapshot(await requestHomeTabs(homeOrigin, "/api/tabs"));
}

/** Bring a tab (`"home"` or a project key) to the front. False when the shell refused (unknown key, still opening). */
export async function activateTab(homeOrigin: string, key: string): Promise<boolean> {
  const data = await requestHomeTabs(homeOrigin, "/api/tabs/activate", { key });
  return isRecord(data) && data.ok === true;
}

/**
 * Close a project tab. The request can sit for as long as the user takes to answer the shell's own dialog
 * (a render or an agent turn is running), so it has no timeout. `cancelled`: the user said no.
 */
export async function closeTab(homeOrigin: string, key: string): Promise<CloseTabResult> {
  const data = await requestHomeTabs(homeOrigin, "/api/tabs/close", { key });
  if (!isRecord(data)) return "failed";
  if (data.closed === true) return "closed";
  return data.closed === false && data.cancelled === true ? "cancelled" : "failed";
}
