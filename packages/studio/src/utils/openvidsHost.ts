/**
 * OpenVids host detection.
 *
 * When Studio runs inside the OpenVids desktop shell, Rust appends an
 * `openvidsHome` query parameter to the Studio URL before navigating the
 * window to a project (see `open_project` in `apps/desktop/src-tauri`).
 * The header then swaps the Hyperframes logo for a "back to projects"
 * button that navigates to that origin.
 *
 * Outside OpenVids (plain `hyperframes preview`, the CLI, hosted Studio)
 * the parameter is absent and the logo renders exactly as before.
 *
 * Security: the value comes from a query string, so it is never trusted
 * blindly. Only an `http://127.0.0.1:<port>` or `http://localhost:<port>`
 * origin is accepted — anything else (remote hosts, `file:`,
 * `javascript:`, garbage) is rejected and the logo stays.
 */

export const OPENVIDS_HOME_PARAM = "openvidsHome";

/** Loopback hosts the OpenVids home server can bind. */
const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
};

/**
 * Validate a candidate home origin. Accepts only `http://` loopback
 * origins with an explicit port — never arbitrary URLs from a query string.
 */
export function isValidOpenvidsHomeOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS[parsed.hostname]) return false;
  if (!parsed.port) return false;
  // An origin is scheme + host + port only: no path, query, fragment,
  // credentials, or extra encoding to smuggle a redirect through.
  if (parsed.username || parsed.password) return false;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
  return parsed.origin === value;
}

/**
 * Read the OpenVids home origin from the current location's query string,
 * or null when Studio is not embedded (or the value fails validation).
 */
export function readOpenvidsHomeOrigin(search?: string): string | null {
  let raw: string | null = null;
  try {
    const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
    raw = new URLSearchParams(query).get(OPENVIDS_HOME_PARAM);
  } catch {
    return null;
  }
  if (!raw) return null;
  return isValidOpenvidsHomeOrigin(raw) ? raw : null;
}

export const OPENVIDS_WORKSPACE_PARAM = "openvidsWorkspace";

/**
 * Take the workspace the desktop asked Studio to open on (`openvidsWorkspace`, set for a new
 * project or a start-from-chat), and drop it from the address so a reload opens the layout the
 * user left rather than forcing the workspace again. Null when absent.
 */
export function takeOpenvidsWorkspaceParam(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const value = url.searchParams.get(OPENVIDS_WORKSPACE_PARAM);
  if (value === null) return null;
  url.searchParams.delete(OPENVIDS_WORKSPACE_PARAM);
  window.history.replaceState(window.history.state, "", url);
  return value;
}

export const OPENVIDS_FRAME_PARAM = "openvidsFrame";

/** Which titlebar chrome the desktop shell draws around Studio. */
export type OpenvidsFrame = "overlay" | "custom" | "system";

/**
 * Read the desktop's frame hint (`openvidsFrame`, appended to the Studio URL
 * by Rust's `studio_url`). `overlay` is the default — macOS traffic lights,
 * and any page without the parameter (plain `hyperframes preview`, hosted
 * Studio, the CLI) keeps the traffic-light inset exactly as before. `custom`
 * is the Windows frameless frame (the header draws caption buttons);
 * `system` is the Windows fallback (the OS draws its frame; no buttons).
 * Unknown values fall back to `overlay`, never to buttons.
 */
export function readOpenvidsFrame(search?: string): OpenvidsFrame {
  let raw: string | null = null;
  try {
    const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
    raw = new URLSearchParams(query).get(OPENVIDS_FRAME_PARAM);
  } catch {
    return "overlay";
  }
  return raw === "custom" || raw === "system" ? raw : "overlay";
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

/**
 * The only Tauri IPC Studio may use: `window.__TAURI_INTERNALS__.invoke`
 * (`plugin:window|…`), injected in every webview — remote loopback origins
 * included — for exactly the commands `capabilities/main.json` and (Windows
 * only) `capabilities/windows-frame.json` grant.
 * Returns null outside the desktop shell (or when the channel is absent),
 * so callers degrade to a no-op instead of throwing.
 */
export function invokeWindowCommand(
  cmd: "minimize" | "toggle_maximize" | "close" | "is_maximized",
): Promise<unknown> | null {
  try {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") return null;
    return invoke(`plugin:window|${cmd}`, { label: "main" });
  } catch {
    return null;
  }
}

/**
 * Ask the home server for one title-bar app menu action
 * (`POST /api/menu/:action` → the shared `menu_action` in Rust, the same
 * handler the hidden native menu runs). The webview has no Tauri IPC beyond
 * the window commands `capabilities/windows-frame.json` grants, so a loopback
 * `fetch` to the validated home origin is the channel; the home server answers
 * its CORS preflight for exactly `open_project`, `welcome` and `check_updates`
 * (and the About read) from this Studio origin, on the custom frame only.
 * Never throws: a refused request resolves false so the menu just closes.
 */
export async function invokeHomeMenuAction(homeOrigin: string, action: string): Promise<boolean> {
  try {
    if (!isValidOpenvidsHomeOrigin(homeOrigin)) return false;
    const response = await fetch(`${homeOrigin}/api/menu/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The About sheet strings (`GET /api/menu/about`: the native dialog's own values). */
export interface HomeAboutInfo {
  name?: string;
  version?: string;
  website?: string;
  websiteLabel?: string;
  comment?: string;
  credits?: string;
}

const ABOUT_FIELDS = ["name", "version", "website", "websiteLabel", "comment", "credits"] as const;

/** A JSON object whose About fields, where present, are strings (absent ones are fine). */
export function isHomeAboutInfo(value: unknown): value is HomeAboutInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return ABOUT_FIELDS.every((key) => fields[key] === undefined || typeof fields[key] === "string");
}

/**
 * Read the About strings for the title-bar app menu's About sheet. Null when
 * the home server cannot be reached (dev servers without the route) or answers
 * something that is not an About object: callers fall back to the app name,
 * never to a thrown error.
 */
export async function readHomeAbout(homeOrigin: string): Promise<HomeAboutInfo | null> {
  try {
    if (!isValidOpenvidsHomeOrigin(homeOrigin)) return null;
    const response = await fetch(`${homeOrigin}/api/menu/about`);
    if (!response.ok) return null;
    const data: unknown = await response.json().catch(() => null);
    return isHomeAboutInfo(data) ? data : null;
  } catch {
    return null;
  }
}
