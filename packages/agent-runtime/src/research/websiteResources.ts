import type { ReadWebsiteResult } from "@hyperframes/agent-protocol";

/**
 * Which files of a linked website an agent may fetch with full access, per chat.
 *
 * Full access (the user's Asset Search setting) lets an agent download a file a linked site serves or its pages
 * load. The runtime decides which URLs count as "of a linked site" before Studio is asked: a URL on the site the
 * user named (any page, any subdomain — see `linkedSites.ts`) or an exact URL a `read_website` of such a site listed
 * earlier in the same chat: one of its `resources`, its logo, favicon, og image or font URLs. This log keeps those
 * URLs per chat while the runtime lives; after a restart the agent can read the site again to refill it.
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

/** The chat context full website access is scoped to: the chat id and the shared per-chat memory. */
export interface WebsiteAccess {
  chatId: string;
  resources: WebsiteResourceLog;
}

/** The per-chat memory of files the linked sites' reads listed; shared by every turn of the chat. */
export class WebsiteResourceLog {
  private readonly byChat = new Map<string, Set<string>>();

  /** Records the files a successful `read_website` result listed for the chat. */
  rememberRead(chatId: string, result: ReadWebsiteResult): void {
    const { site } = result;
    const urls = this.byChat.get(chatId) ?? new Set<string>();
    const add = (url: string | null | undefined): void => {
      if (urls.size >= LIMIT_PER_CHAT) return;
      const normalized = normalizeResourceUrl(url ?? "");
      if (normalized !== null) urls.add(normalized);
    };
    for (const resource of site.resources) add(resource.url);
    for (const logo of site.logos) add(logo.url);
    add(site.favicon);
    add(site.ogImage);
    for (const font of site.fonts) add(font.url);
    this.byChat.set(chatId, urls);
  }

  /** Whether `url` is exactly a file a read in this chat listed (fragment ignored). */
  has(chatId: string, url: string): boolean {
    const normalized = normalizeResourceUrl(url);
    return normalized !== null && (this.byChat.get(chatId)?.has(normalized) ?? false);
  }
}
