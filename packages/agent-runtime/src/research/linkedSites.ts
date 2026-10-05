import { MAX_ALLOWED_SITES } from "@hyperframes/agent-protocol";
import { isIP } from "node:net";
import { getDomain } from "tldts";

/**
 * The websites a user has linked in a chat, and whether a URL the agent wants to read belongs to one of them.
 *
 * The agent may read only pages of a site the user themselves named in a chat — a URL, a `www.` address or a bare
 * domain such as `openvids.ai` — in any user message (the first prompt, later messages and steering). A site is its
 * registrable domain: a link to `https://www.linear.app/x` allows
 * `linear.app`, `www.linear.app` and `docs.linear.app`, never `example.com`. Links the assistant writes (its own
 * replies, search results, page contents) never count: this module is fed user text only.
 */

/**
 * Hosting platforms that give every customer a sub-domain but are missing from the Public Suffix List (the list
 * itself comes from `tldts`): linking `mine.tilda.ws` must not allow every other `*.tilda.ws` site.
 */
const EXTRA_SHARED_SUFFIXES = [
  "wordpress.com",
  "tilda.ws",
  "amazonaws.com",
  "ghost.io",
  "glitch.me",
  "github.dev",
  "weebly.com",
  "wpengine.com",
];

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`\])}]+/gi;
/** `www.example.com/path` without a scheme: people write links that way, and `www.` is unmistakable. */
const WWW_IN_TEXT = /(?<![\w./@-])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#][^\s<>"'`\])}]*)?/gi;
/**
 * A bare domain (`openvids.ai`, `linear.app/pricing`): people name their site that way too. Letters-only last label,
 * not part of an address, path or e-mail; file names are told apart by {@link FILE_EXTENSIONS}.
 */
const BARE_DOMAIN_IN_TEXT =
  /(?<![\w./@:-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24})(?![\w@-])(?:[/?#][^\s<>"'`\])}]*)?/gi;
/** Last labels that name a file kind, not a site (`index.html`, `Chrome Bounce.wav`, `README.md`, `Node.js`). */
const FILE_EXTENSIONS = new Set([
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "json",
  "md",
  "txt",
  "csv",
  "xml",
  "yml",
  "yaml",
  "toml",
  "lock",
  "log",
  "py",
  "rs",
  "sh",
  "pdf",
  "doc",
  "docx",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "heic",
  "mp4",
  "mov",
  "mkv",
  "avi",
  "webm",
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "zip",
  "rar",
  "gz",
  "dmg",
  "exe",
  "woff",
  "woff2",
  "ttf",
  "otf",
]);
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
 * The site a host belongs to: its registrable domain under the Public Suffix List (ICANN and private sections, plus
 * {@link EXTRA_SHARED_SUFFIXES}). Null for IP addresses, `localhost`-style names, single labels and bare public
 * suffixes, which can never be a linked site.
 */
export function registrableDomain(host: string): string | null {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(name) !== 0) return null;
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return null;
  const labels = name.split(".");
  if (labels.length < 2 || labels.some((label) => label === "")) return null;
  // ICANN and private (platform) suffixes both count: `a.github.io` and `a.myshopify.com` are separate sites.
  const listed = getDomain(name, { allowPrivateDomains: true });
  const extra = EXTRA_SHARED_SUFFIXES.find(
    (suffix) => name === suffix || name.endsWith(`.${suffix}`),
  );
  if (extra === undefined) return listed;
  const depth = extra.split(".").length + 1;
  const supplemented = labels.length >= depth ? labels.slice(-depth).join(".") : null;
  // The list may know a longer suffix than the supplement does (`s3.amazonaws.com`): the narrower site wins.
  return listed !== null && supplemented !== null && listed.split(".").length > depth
    ? listed
    : supplemented;
}

/** The http(s) URLs written in `text` (`www.`-prefixed words and bare domains count as https). */
export function linksIn(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(URL_IN_TEXT))
    links.push(match[0].replace(TRAILING_PUNCTUATION, ""));
  for (const match of text.matchAll(WWW_IN_TEXT))
    links.push(`https://${match[0].replace(TRAILING_PUNCTUATION, "")}`);
  for (const match of text.matchAll(BARE_DOMAIN_IN_TEXT)) {
    const word = match[0].replace(TRAILING_PUNCTUATION, "");
    if (/^www\./i.test(word) || FILE_EXTENSIONS.has(match[1]?.toLowerCase() ?? "")) continue;
    links.push(`https://${word}`);
  }
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

/**
 * `sites` cut to the most one Studio request may name. Under the cap the list is kept in order, with `required` (the
 * site of the URL being requested, which Studio must be able to open) added when missing. Over it, `required` leads
 * and the earliest linked sites fill the rest, so the request's own site is never the one that is dropped.
 */
export function boundedSites(
  sites: readonly string[],
  required: string | null,
  max: number = MAX_ALLOWED_SITES,
): string[] {
  if (required === null) return sites.slice(0, max);
  const ordered = sites.includes(required) ? [...sites] : [...sites, required];
  if (ordered.length <= max) return ordered;
  return [required, ...sites.filter((site) => site !== required).slice(0, max - 1)];
}
