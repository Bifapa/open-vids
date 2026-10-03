import { isIP } from "node:net";

/**
 * The websites a user has linked in a chat, and whether a URL the agent wants to read belongs to one of them.
 *
 * The agent may read only pages of a site the user themselves named in a chat — a URL, a `www.` address or a bare
 * domain such as `openvids.ai` — in any user message (the first prompt, later messages and steering). A site is its
 * registrable domain: a link to `https://www.linear.app/x` allows
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
