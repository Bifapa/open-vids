/**
 * Project tabs: the desktop shell keeps several projects open in one window,
 * each its own webview, and draws no chrome of its own. The pages draw the tab strip from what the shell's
 * home server answers, and ask it to switch, close or fork a tab. Studio is a different loopback origin than the
 * home server and holds no home token, so it talks to the four `/api/tabs*` endpoints with a plain
 * `fetch` to the validated home origin, exactly like `invokeHomeMenuAction`: the home server grants its CORS
 * to the live Studio origin for these endpoints. Nothing here throws; an unreachable or confused home
 * server resolves `null` / `false` / `"failed"` and the strip keeps what it last knew.
 */
import { isRecord } from "@hyperframes/agent-protocol";
import { isValidOpenvidsHomeOrigin } from "./openvidsHost";

/** URL parameter the shell sets on a project webview: this page's own tab key. */
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
  /** `"home"` or a project key. */
  active: string;
  /** Soft memory limit of open projects; the shell itself asks the user beyond it. */
  limit: number;
  /** Project tabs in tab order, without the Projects tab. */
  tabs: ProjectTab[];
}

export type CloseTabResult = "closed" | "cancelled" | "failed";

/** How a fork request ended: started (the shell shows the Projects page with its progress), or refused. */
export type ForkTabResult =
  | { ok: true }
  | { ok: false; code: string | null; params: Record<string, string | number>; message: string };

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
 * Read the answer of `GET /api/tabs`: it needs every field, with every tab well-formed and no key repeated.
 * Anything else is null, never a half-trusted snapshot.
 */
export function parseTabsSnapshot(value: unknown): TabsSnapshot | null {
  if (!isRecord(value)) return null;
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
  return { active, limit, tabs };
}

/** Whether two answers describe the same strip, so a poll that changed nothing does not re-render it. */
export function sameTabsSnapshot(a: TabsSnapshot, b: TabsSnapshot): boolean {
  return (
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

/** One request to the home server's tab endpoints: whether it answered 2xx and its JSON body (null when none). */
async function sendHomeTabs(
  homeOrigin: string,
  path: string,
  body?: { key: string },
): Promise<{ ok: boolean; data: unknown } | null> {
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
    const data: unknown = await response.json().catch(() => null);
    return { ok: response.ok, data };
  } catch {
    return null;
  }
}

/** One request to the home server's tab endpoints: the parsed JSON body, or null on any failure. */
async function requestHomeTabs(
  homeOrigin: string,
  path: string,
  body?: { key: string },
): Promise<unknown> {
  const answer = await sendHomeTabs(homeOrigin, path, body);
  return answer?.ok ? answer.data : null;
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

function errorParams(value: unknown): Record<string, string | number> {
  if (!isRecord(value)) return {};
  const params: Record<string, string | number> = {};
  for (const [name, param] of Object.entries(value)) {
    if (typeof param === "string" || typeof param === "number") params[name] = param;
  }
  return params;
}

/**
 * Fork an open project tab. The shell starts the copy and shows the Projects page, which follows its progress
 * (with Cancel) and opens the fork as a new tab. A refusal carries the server's code, its params and its
 * English sentence (`{ error, code, params }`); an unreachable server is a refusal without a code.
 */
export async function forkTab(homeOrigin: string, key: string): Promise<ForkTabResult> {
  const answer = await sendHomeTabs(homeOrigin, "/api/tabs/fork", { key });
  if (answer?.ok && isRecord(answer.data) && answer.data.ok === true) return { ok: true };
  const data = isRecord(answer?.data) ? answer.data : {};
  return {
    ok: false,
    code: typeof data.code === "string" && data.code ? data.code : null,
    params: errorParams(data.params),
    message: typeof data.error === "string" ? data.error : "",
  };
}
