import {
  urlInAllowedSites,
  type WebsiteGrant,
  type WebsiteGrantAccess,
} from "@hyperframes/agent-protocol";

/**
 * How long a one-time Websites grant survives without a fresh grant. The runtime revokes the turn's grant when the
 * turn ends; the expiry only bounds a grant whose turn never ends (a crash).
 */
export const WEBSITE_GRANT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The one-time Website grants the chat asks for ("Allow once"): per project directory, per turn and per site, the
 * access the user gave so that turn's website requests for that site pass the Websites setting's check as if the
 * switch were on ({@link WebsiteReader}, {@link WebsiteFiles}). A grant with site `null` (the route only creates one for an explicit `allSites`) covers every site of the turn.
 * Re-granting the same site never downgrades (`read` over `full` keeps `full`), every grant pushes its expiry
 * {@link WEBSITE_GRANT_TTL_MS} out, and the whole store is in memory: a restarted server forgets the turn, and its
 * runtime asks again.
 */
export class WebsiteGrantStore {
  private readonly byProject = new Map<string, Map<string, WebsiteGrant[]>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Creates or renews the grant of `turnId` for `site`; `grantedAt` is when the user first allowed it. An expired grant is gone. */
  grant(
    projectDir: string,
    turnId: string,
    access: WebsiteGrantAccess,
    site: string | null = null,
  ): WebsiteGrant {
    const at = this.now();
    let turns = this.byProject.get(projectDir);
    if (!turns) {
      turns = new Map();
      this.byProject.set(projectDir, turns);
    }
    const live = (turns.get(turnId) ?? []).filter((entry) => entry.expiresAt > at);
    const previous = live.find((entry) => entry.site === site);
    const grant: WebsiteGrant = {
      turnId,
      access: previous?.access === "full" ? "full" : access,
      site,
      grantedAt: previous?.grantedAt ?? at,
      expiresAt: at + WEBSITE_GRANT_TTL_MS,
    };
    turns.set(turnId, [...live.filter((entry) => entry.site !== site), grant]);
    return { ...grant };
  }

  /** Drops every grant of `turnId`; `true` when there was one. Idempotent. */
  revoke(projectDir: string, turnId: string): boolean {
    const turns = this.byProject.get(projectDir);
    if (!turns) return false;
    const removed = turns.delete(turnId);
    if (turns.size === 0) this.byProject.delete(projectDir);
    return removed;
  }

  /**
   * Whether `turnId` may act at `needed` level on `url` in this project: a grant of `read` answers a `read` need, a
   * grant of `full` answers both, and a grant for a site only answers a URL of that site (or its sub-domains). A
   * request without a turn, an unknown turn and an expired grant never match.
   */
  allows(
    projectDir: string,
    turnId: string | undefined,
    needed: WebsiteGrantAccess,
    url: string,
  ): boolean {
    if (turnId === undefined) return false;
    const turns = this.byProject.get(projectDir);
    const grants = turns?.get(turnId);
    if (!turns || !grants) return false;
    const at = this.now();
    const live = grants.filter((entry) => entry.expiresAt > at);
    if (live.length === 0) {
      turns.delete(turnId);
      if (turns.size === 0) this.byProject.delete(projectDir);
      return false;
    }
    if (live.length !== grants.length) turns.set(turnId, live);
    return live.some(
      (entry) =>
        (needed === "read" || entry.access === "full") &&
        (entry.site === null || urlInAllowedSites(url, [entry.site])),
    );
  }
}
