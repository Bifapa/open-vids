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
