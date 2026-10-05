import { hostname, networkInterfaces } from "node:os";

// DNS-rebinding guard for the loopback preview server.
//
// Scope, stated precisely: this is a mitigation for browsers, not access
// control. A browser sets `Host` from the URL it was given, so a page that
// rebinds its own hostname to 127.0.0.1 arrives carrying that hostname and is
// refused. A non-browser client sets `Host` to whatever it likes, so this
// stops nothing there — but on a loopback-bound server such a client is
// already local, and on a LAN-bound one it can read the project files through
// the unauthenticated studio API anyway.

/**
 * Is this request's `Host` a loopback name the studio server could have been
 * reached on directly? The port is irrelevant (any port on loopback is us).
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  // Strip the port. IPv6 literals are bracketed (`[::1]:1234`), so take the
  // bracketed part when present and only split on ":" otherwise.
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  const hostname = (bracketed ? bracketed[1] : host.split(":")[0])?.toLowerCase() ?? "";
  if (hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  // 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** Hostname of a `Host` header, port and IPv6 brackets removed. */
function hostnameOf(host: string | undefined): string {
  if (!host) return "";
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  return (bracketed ? bracketed[1] : host.split(":")[0])?.toLowerCase() ?? "";
}

/**
 * Names this machine legitimately answers to on a wildcard bind: every
 * interface address, plus its own hostname and the `.local` mDNS form people
 * actually type. Fail closed — a throw yields an empty set, which denies.
 */
function localNames(): Set<string> {
  const names = new Set<string>();
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) names.add(entry.address.toLowerCase());
    }
    const self = hostname().toLowerCase();
    if (self !== "") {
      names.add(self);
      // `my-box` is reachable as `my-box.local`, and a `my-box.lan.example`
      // FQDN is reachable by its short form. Register both directions.
      names.add(`${self}.local`);
      const short = self.split(".")[0];
      if (short !== undefined && short !== "") {
        names.add(short);
        names.add(`${short}.local`);
      }
    }
  } catch {
    /* fail closed */
  }
  return names;
}

/**
 * Wildcard binds answer on every local name; a specific bind on itself only.
 */
function hostMatchesBind(host: string | undefined, bind: string): boolean {
  const requested = hostnameOf(host);
  if (requested === "") return false;
  const bound = bind.toLowerCase();
  if (requested === bound) return true;
  return bound === "0.0.0.0" || bound === "::" || bound === "*"
    ? localNames().has(requested)
    : false;
}

/**
 * Is this request's Host one the Studio server may serve trusted content to?
 *
 * The server binds loopback by DEFAULT and exposes the LAN only when an
 * operator sets `HYPERFRAMES_PREVIEW_HOST`. A loopback `Host` is always fine:
 * whatever reached us came via loopback. For anything else the bind decides:
 * unset/loopback bind refuses non-loopback Hosts; a LAN bind accepts only a
 * Host naming an address this machine actually answers on.
 */
export function isTrustedStudioHost(host: string | undefined): boolean {
  if (isLoopbackHost(host)) return true;
  const bind = (process.env["HYPERFRAMES_PREVIEW_HOST"] ?? "").trim();
  if (bind === "" || isLoopbackHost(bind)) return false;
  return hostMatchesBind(host, bind);
}

/**
 * Is `origin` this server's own origin? It must name the very host the request
 * was addressed to (same scheme-less host:port) and that host must be one the
 * Studio trusts. Anything else — a foreign site, a sibling loopback port such as
 * the desktop home server, `null` (sandboxed frame / file:) — is not us.
 */
export function isOwnStudioOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return (
    parsed.host.toLowerCase() === host.trim().toLowerCase() && isTrustedStudioHost(parsed.host)
  );
}

export type StudioRequestVerdict = "ok" | "untrusted_host" | "cross_origin";

/**
 * Gate for every request the Studio server answers.
 *
 * 1. The `Host` must be a trusted one (DNS-rebinding guard). A request with no
 *    `Host` header at all (in-process `app.request()`) falls back to the host of
 *    the request URL, which the node adapter builds from that very header.
 * 2. A state-changing request (anything but GET/HEAD/OPTIONS) that carries an
 *    `Origin` must carry our own; one flagged `Sec-Fetch-Site: cross-site` is
 *    refused outright. No `Origin` means a non-browser caller (CLI, the agent
 *    runtime's loopback HTTP hosts), which a browser-facing CSRF defence does
 *    not target and which can forge headers anyway.
 */
export function checkStudioRequest(request: {
  method: string;
  url: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
}): StudioRequestVerdict {
  let host = request.host;
  if (host === undefined || host.trim() === "") {
    try {
      host = new URL(request.url).host;
    } catch {
      host = undefined;
    }
  }
  if (!isTrustedStudioHost(host)) return "untrusted_host";
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "ok";
  if (request.secFetchSite?.trim().toLowerCase() === "cross-site") return "cross_origin";
  if (request.origin !== undefined && !isOwnStudioOrigin(request.origin, host)) {
    return "cross_origin";
  }
  return "ok";
}
