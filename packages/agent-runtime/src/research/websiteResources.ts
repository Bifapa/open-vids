import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, type ReadWebsiteResult } from "@hyperframes/agent-protocol";

/**
 * Which files of a linked website an agent may fetch with full access, per chat.
 *
 * Full access (the user's Asset Search setting) lets an agent download a file a linked site serves or its pages
 * load. The runtime decides which URLs count as "of a linked site" before Studio is asked: a URL on the site the
 * user named (any page, any subdomain — see `linkedSites.ts`) or an exact URL a `read_website` of such a site listed
 * earlier in the same chat: one of its `resources`, its logo, favicon, og image or font URLs. This log keeps those
 * URLs per chat. With a `fileOf` it is derived data next to the chat (rewritten whole, a damaged file is an empty
 * log): after a restart the agent can still fetch a file an earlier read listed, and entries older than a week are
 * dropped.
 */

/** Strip the fragment, keep everything else (query strings are often part of the file's identity). */
export function normalizeResourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

/** How many URLs one chat remembers (a page can list up to 200 resources; a few reads are plenty). */
const LIMIT_PER_CHAT = 2_000;
/** How long a listed file stays fetchable without being listed again. */
export const RESOURCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESOURCES_SCHEMA = "openvids.website-resources/1";

/** The chat context full website access is scoped to: the chat id and the shared per-chat memory. */
export interface WebsiteAccess {
  chatId: string;
  resources: WebsiteResourceLog;
}

export interface WebsiteResourceLogOptions {
  /** The file a chat's list is kept in (inside the chat's directory); without it the log is in memory only. */
  fileOf?: (chatId: string) => Promise<string>;
  now?: () => number;
}

/** URL → when a read listed it, for one chat. */
type Listed = Map<string, number>;

function listedFrom(contents: string, now: number): Listed {
  const listed: Listed = new Map();
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed) || parsed.schema !== RESOURCES_SCHEMA || !Array.isArray(parsed.entries))
      return listed;
    for (const entry of parsed.entries) {
      if (!Array.isArray(entry)) continue;
      const [url, at] = entry;
      if (typeof url === "string" && typeof at === "number" && at + RESOURCE_TTL_MS >= now)
        listed.set(url, at);
    }
  } catch {
    // Damaged: an empty log.
  }
  return listed;
}

/** The per-chat memory of files the linked sites' reads listed; shared by every turn of the chat. */
export class WebsiteResourceLog {
  private readonly byChat = new Map<string, Promise<Listed>>();
  private readonly fileOf: ((chatId: string) => Promise<string>) | undefined;
  private readonly now: () => number;
  /** Writes of one chat are serialized, so a slow write never lands after a newer one. */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(options: WebsiteResourceLogOptions = {}) {
    this.fileOf = options.fileOf;
    this.now = options.now ?? Date.now;
  }

  private listedOf(chatId: string): Promise<Listed> {
    const existing = this.byChat.get(chatId);
    if (existing) return existing;
    const loaded = this.load(chatId);
    this.byChat.set(chatId, loaded);
    return loaded;
  }

  private async load(chatId: string): Promise<Listed> {
    if (!this.fileOf) return new Map();
    try {
      return listedFrom(await readFile(await this.fileOf(chatId), "utf8"), this.now());
    } catch {
      return new Map();
    }
  }

  private persist(chatId: string, listed: Listed): Promise<void> {
    const fileOf = this.fileOf;
    if (!fileOf) return Promise.resolve();
    const body = JSON.stringify({ schema: RESOURCES_SCHEMA, entries: [...listed] });
    const previous = this.writes.get(chatId) ?? Promise.resolve();
    const write = previous
      .then(async () => {
        const file = await fileOf(chatId);
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, body, "utf8");
        await rename(temporary, file);
      })
      .catch(() => undefined);
    this.writes.set(chatId, write);
    return write;
  }

  /** Records the files a successful `read_website` result listed for the chat. */
  async rememberRead(chatId: string, result: ReadWebsiteResult): Promise<void> {
    const { site } = result;
    const listed = await this.listedOf(chatId);
    const at = this.now();
    for (const [url, seen] of listed) if (seen + RESOURCE_TTL_MS < at) listed.delete(url);
    const add = (url: string | null | undefined): void => {
      const normalized = normalizeResourceUrl(url ?? "");
      if (normalized === null) return;
      // Re-listing a file renews it and moves it to the end, so the oldest entries are the ones dropped at the cap.
      listed.delete(normalized);
      listed.set(normalized, at);
      if (listed.size > LIMIT_PER_CHAT) {
        const oldest = listed.keys().next();
        if (!oldest.done) listed.delete(oldest.value);
      }
    };
    for (const resource of site.resources) add(resource.url);
    for (const logo of site.logos) add(logo.url);
    add(site.favicon);
    add(site.ogImage);
    for (const font of site.fonts) add(font.url);
    await this.persist(chatId, listed);
  }

  /** Whether `url` is exactly a file a read in this chat listed (fragment ignored). */
  async has(chatId: string, url: string): Promise<boolean> {
    const normalized = normalizeResourceUrl(url);
    if (normalized === null) return false;
    const seen = (await this.listedOf(chatId)).get(normalized);
    return seen !== undefined && seen + RESOURCE_TTL_MS >= this.now();
  }
}
