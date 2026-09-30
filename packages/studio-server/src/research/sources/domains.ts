import { isIP } from "node:net";
import { ResearchFailure } from "../errors.js";

/** Multi-label public suffixes a user must not trust as a whole ("co.uk" covers every British company site). */
const SHARED_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.cn",
  "com.mx",
  "com.ar",
  "com.tr",
  "co.in",
  "co.za",
  "co.kr",
  "github.io",
  "gitlab.io",
  "pages.dev",
  "vercel.app",
  "netlify.app",
  "blogspot.com",
  "herokuapp.com",
  "wordpress.com",
  "web.app",
  "firebaseapp.com",
]);

/** Lower-case host of an http(s) URL; null when the text is not one. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return stripBrackets(parsed.hostname.toLowerCase());
  } catch {
    return null;
  }
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Whether `host` is one of `domains` or a subdomain of one (suffix match on whole labels). */
export function hostMatchesDomains(host: string, domains: readonly string[]): boolean {
  const name = host.toLowerCase();
  return domains.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/**
 * A trusted domain from what the user typed (a host, `www.example.org/path`, or a full URL): lower-case host without
 * scheme, path, port and `www.`. IP addresses, `localhost`, single-label names and public suffixes are refused: a
 * trusted source must name one organization's site.
 */
export function normalizeDomain(input: string): string {
  const raw = input.trim().toLowerCase();
  if (raw === "") throw new ResearchFailure("invalid_request", "A domain must not be empty");
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    throw new ResearchFailure("invalid_request", `"${input}" is not a domain`);
  }
  host = stripBrackets(host)
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (isIP(host) !== 0) {
    throw new ResearchFailure("invalid_request", `"${input}" is an IP address, not a website`);
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new ResearchFailure("invalid_request", `"${input}" is a local address, not a website`);
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.split(".").some((label) => label === "")) {
    throw new ResearchFailure(
      "invalid_request",
      `"${input}" is not a website domain (expected something like example.org)`,
    );
  }
  if (SHARED_SUFFIXES.has(host)) {
    throw new ResearchFailure(
      "invalid_request",
      `"${host}" is shared by many unrelated sites; name the specific site instead`,
    );
  }
  return host;
}
