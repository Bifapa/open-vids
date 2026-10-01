import { isIP } from "node:net";

/**
 * The websites a user has linked in a chat, and whether a URL the agent wants to read belongs to one of them.
 *
 * The agent may read only pages of a site the user themselves sent a link to (any user message of the chat: the first
 * prompt, later messages and steering). A site is its registrable domain: a link to `https://www.linear.app/x` allows
 * `linear.app`, `www.linear.app` and `docs.linear.app`, never `example.com`. Links the assistant writes (its own
 * replies, search results, page contents) never count: this module is fed user text only.
 */

/** Multi-label public suffixes: the registrable domain of `a.example.co.uk` is `example.co.uk`, of `x.github.io` is `x.github.io`. */
const SHARED_SUFFIXES: Readonly<Record<string, true>> = {
  "co.uk": true,
  "org.uk": true,
  "ac.uk": true,
  "gov.uk": true,
  "com.au": true,
  "net.au": true,
  "org.au": true,
  "co.nz": true,
  "co.jp": true,
  "ne.jp": true,
  "or.jp": true,
  "com.br": true,
  "com.cn": true,
  "com.mx": true,
  "com.ar": true,
  "com.tr": true,
  "co.in": true,
  "co.za": true,
  "co.kr": true,
  "github.io": true,
  "gitlab.io": true,
  "pages.dev": true,
  "vercel.app": true,
  "netlify.app": true,
  "blogspot.com": true,
  "herokuapp.com": true,
  "wordpress.com": true,
  "web.app": true,
  "firebaseapp.com": true,
};

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`\])}]+/gi;
/** `www.example.com/path` without a scheme: people write links that way, and `www.` is unmistakable. */
const WWW_IN_TEXT = /(?<![\w./@-])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#][^\s<>"'`\])}]*)?/gi;
const TRAILING_PUNCTUATION = /[.,;:!?»”’…]+$/;

/** Lower-case host of an http(s) URL; null when the text is not one. */
export function websiteHostOf(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/**
 * The site a host belongs to: its registrable domain. Null for IP addresses, `localhost`-style names and single labels,
 * which can never be a linked site.
 */
export function registrableDomain(host: string): string | null {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(name) !== 0) return null;
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return null;
  const labels = name.split(".");
  if (labels.length < 2 || labels.some((label) => label === "")) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (Object.hasOwn(SHARED_SUFFIXES, lastTwo))
    return labels.length >= 3 ? labels.slice(-3).join(".") : null;
  return lastTwo;
}

/** The http(s) URLs written in `text` (`www.`-prefixed words count as https). */
export function linksIn(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(URL_IN_TEXT))
    links.push(match[0].replace(TRAILING_PUNCTUATION, ""));
  for (const match of text.matchAll(WWW_IN_TEXT))
    links.push(`https://${match[0].replace(TRAILING_PUNCTUATION, "")}`);
  return links;
}

/** The registrable domains the user linked in `userTexts`, in order of first appearance. */
export function linkedSites(userTexts: readonly string[]): string[] {
  const sites = new Set<string>();
  for (const text of userTexts) {
    for (const link of linksIn(text)) {
      const host = websiteHostOf(link);
      const site = host ? registrableDomain(host) : null;
      if (site) sites.add(site);
    }
  }
  return [...sites];
}

/** Whether `url` is an http(s) page of a site the user linked. */
export function isLinkedSite(url: string, sites: readonly string[]): boolean {
  const host = websiteHostOf(url);
  const site = host ? registrableDomain(host) : null;
  return site !== null && sites.includes(site);
}
