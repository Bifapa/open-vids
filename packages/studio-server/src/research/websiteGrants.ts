import type { WebsiteGrant, WebsiteGrantAccess } from "@hyperframes/agent-protocol";

/**
 * How long a one-time Websites grant survives without a fresh grant. The runtime revokes the turn's grant when the
 * turn ends; the expiry only bounds a grant whose turn never ends (a crash).
 */
export const WEBSITE_GRANT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The one-time Website grants the chat asks for ("Allow once"): per project directory, per turn, the access the user
 * gave so the turn's website requests pass the Websites setting's check as if the switch were on ({@link WebsiteReader},
 * {@link WebsiteFiles}). Re-granting never downgrades (`read` over `full` keeps `full`), every grant pushes the expiry
 * {@link WEBSITE_GRANT_TTL_MS} out, and the whole store is in memory: a restarted server forgets the turn, and its
 * runtime asks again.
 */
export class WebsiteGrantStore {
  private readonly byProject = new Map<string, Map<string, WebsiteGrant>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Creates or renews the grant of `turnId`; `grantedAt` is when the user first allowed it. An expired grant is gone. */
  grant(projectDir: string, turnId: string, access: WebsiteGrantAccess): WebsiteGrant {
    const at = this.now();
    let grants = this.byProject.get(projectDir);
    if (!grants) {
      grants = new Map();
      this.byProject.set(projectDir, grants);
    }
    const previous = grants.get(turnId);
    const existing = previous !== undefined && previous.expiresAt > at ? previous : undefined;
    const grant: WebsiteGrant = {
      turnId,
      access: existing?.access === "full" ? "full" : access,
      grantedAt: existing?.grantedAt ?? at,
      expiresAt: at + WEBSITE_GRANT_TTL_MS,
    };
    grants.set(turnId, grant);
    return { ...grant };
  }

  /** Drops the grant of `turnId`; `true` when there was one. Idempotent. */
  revoke(projectDir: string, turnId: string): boolean {
    const grants = this.byProject.get(projectDir);
    if (!grants) return false;
    const removed = grants.delete(turnId);
    if (grants.size === 0) this.byProject.delete(projectDir);
    return removed;
  }

  /**
   * Whether `turnId` may act at `needed` level in this project: a grant of `read` answers a `read` need, a grant of
   * `full` answers both. A request without a turn, an unknown turn and an expired grant never match.
   */
  allows(projectDir: string, turnId: string | undefined, needed: WebsiteGrantAccess): boolean {
    if (turnId === undefined) return false;
    const grants = this.byProject.get(projectDir);
    const grant = grants?.get(turnId);
    if (!grant) return false;
    if (grant.expiresAt <= this.now()) {
      grants?.delete(turnId);
      if (grants?.size === 0) this.byProject.delete(projectDir);
      return false;
    }
    return needed === "read" || grant.access === "full";
  }
}
