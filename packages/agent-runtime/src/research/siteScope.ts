import type { PermissionKind } from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import type { PermissionBroker } from "../permissions.js";
import { refuse } from "./args.js";
import {
  boundedSites,
  chatLinkedSites,
  isLinkedSite,
  registrableDomain,
  websiteHostOf,
} from "./linkedSites.js";
import type { WebsiteAccess } from "./websiteResources.js";

export interface SiteScopeOptions {
  /** Every message the user wrote in this chat (never assistant text, search results or page contents). */
  userTexts: () => readonly string[];
  /** The messages of the running turn only. */
  turnUserTexts: () => readonly string[];
  /** Sites the user removed from the chat's list. */
  excludedSites?: () => readonly string[];
  websites: WebsiteAccess;
  permissions: PermissionBroker | null;
}

/**
 * Which websites a turn's website calls may touch: the sites the user linked in this chat (see `chatLinkedSites`),
 * and the exact files an earlier read of such a site listed. Decided here, before Studio is asked; Studio then
 * enforces the user's switch and the public-address rules.
 */
export class SiteScope {
  constructor(private readonly options: SiteScopeOptions) {}

  /** The registrable domains the user has linked in this chat right now. */
  linked(): string[] {
    const { userTexts, turnUserTexts, excludedSites } = this.options;
    return chatLinkedSites({
      chatTexts: userTexts(),
      turnTexts: turnUserTexts(),
      excluded: excludedSites?.() ?? [],
    });
  }

  /** "The user has linked: a.com, b.com." / "…has not linked any website in this chat." */
  linkedNote(): string {
    const sites = this.linked();
    return sites.length > 0
      ? `The user has linked: ${sites.join(", ")}.`
      : "The user has not linked any website in this chat.";
  }

  isLinked(url: string): boolean {
    return isLinkedSite(url, this.linked());
  }

  /** Whether `url` is on a site the user removed from the chat's list: no file of it is fetched, listed earlier or not. */
  private isExcluded(url: string): boolean {
    const host = websiteHostOf(url);
    const site = host === null ? null : registrableDomain(host);
    if (site === null) return false;
    return (this.options.excludedSites?.() ?? []).some((removed) => removed.toLowerCase() === site);
  }

  /**
   * Full access may fetch only a page of a site the user linked in this chat, or an exact file a `read_website` of
   * such a site listed earlier (its resources, logo, favicon, og image or fonts — CDN hosts included). Null when the
   * URL is allowed.
   */
  async fileScope(url: string): Promise<HostToolResult | null> {
    if (this.isLinked(url)) return null;
    const host = websiteHostOf(url);
    // An address without a domain name (a bare IP, localhost) never counts as a site, even when a page listed it.
    if (host !== null && registrableDomain(host) === null) {
      return refuse(
        `blocked_by_policy: ${url} is on an address without a domain name (${host}), and such addresses never count as a linked site, so nothing is fetched from it and the user is not asked. Ask the user for the site's own domain name (for example example.com) and read that site instead.`,
      );
    }
    if (this.isExcluded(url)) {
      return refuse(
        `blocked_by_policy: ${url} is on a website the user removed from the linked sites of this chat, so nothing is fetched from it, even a file an earlier read listed. ${this.linkedNote()} Do not try another address of that site; tell the user if you need it and they can link it again.`,
      );
    }
    if (await this.options.websites.resources.has(this.options.websites.chatId, url)) return null;
    return refuse(
      `blocked_by_policy: ${url} is not a file of a website the user linked in this chat. ${this.linkedNote()} Full access covers the linked site itself and the exact files an earlier read_website of it listed (its resources, logo, favicon, og image or fonts, CDN hosts included). Call read_website on the site first and take the URL from its resource list; do not guess, search for or try another address.`,
    );
  }

  /**
   * The sites Studio may open for a call of `kind`, and every redirect hop of it: the linked sites, plus the site of
   * `url` itself when it is a file an earlier read listed (a CDN host the user never named). When the setting is off
   * and the call runs on "Allow once" answers, only the sites the user allowed qualify (plus the URL's own), so a
   * redirect cannot lead a granted call onto a linked site nobody allowed. Studio takes a bounded number of sites, so
   * a chat that linked more sends a bounded list that always holds the site of `url`.
   */
  allowedSitesFor(url: string, kind: PermissionKind, settingOn: boolean): string[] {
    const linked = this.linked();
    const granted = settingOn ? null : (this.options.permissions?.grantedSites(kind) ?? null);
    const sites = granted === null ? linked : linked.filter((site) => granted.includes(site));
    const host = websiteHostOf(url);
    const own = host === null ? null : registrableDomain(host);
    const required =
      linked.find((site) => isLinkedSite(url, [site])) ?? (this.isExcluded(url) ? null : own);
    return boundedSites(sites, required);
  }

  /**
   * Studio checks every redirect hop against the `allowedSites` of the request, and a file is written before the answer
   * comes back. The check here uses that same list, so a redirect Studio let through (within the request's own site) is
   * never reported as blocked after the file is already in the project, and a hop it would refuse is refused here too.
   * Null when the final URL is in scope.
   */
  redirectedAway(
    requested: string,
    finalUrl: string,
    allowedSites: readonly string[],
  ): HostToolResult | null {
    if (isLinkedSite(finalUrl, allowedSites)) return null;
    return refuse(
      `blocked_by_policy: ${requested} redirected to ${finalUrl}, which is not a website this call may open, so nothing it returned is shown. ${this.linkedNote()} You may read only the linked sites themselves (and the file hosts their pages listed); do not follow redirects off them or try another address. Tell the user if the link they sent no longer leads to their site.`,
    );
  }
}
