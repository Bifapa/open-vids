import { isWebsiteGrant } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { WEBSITE_GRANT_TTL_MS, WebsiteGrantStore } from "./websiteGrants.js";

const PROJECT = "/tmp/openvids-grant-project";
const OTHER = "/tmp/openvids-grant-other";

function clock(start = 1_000_000) {
  const state = { at: start };
  const store = new WebsiteGrantStore(() => state.at);
  return { state, store };
}

describe("the website grant store", () => {
  it("grants a turn read for its project and answers as a grant", () => {
    const { state, store } = clock();
    const grant = store.grant(PROJECT, "turn-a", "read");
    expect(isWebsiteGrant(grant)).toBe(true);
    expect(grant).toEqual({
      turnId: "turn-a",
      access: "read",
      grantedAt: state.at,
      expiresAt: state.at + WEBSITE_GRANT_TTL_MS,
    });

    expect(store.allows(PROJECT, "turn-a", "read")).toBe(true);
    expect(store.allows(PROJECT, "turn-a", "full")).toBe(false);
    // A request without a turn, an unknown turn and another project never match.
    expect(store.allows(PROJECT, undefined, "read")).toBe(false);
    expect(store.allows(PROJECT, "turn-b", "read")).toBe(false);
    expect(store.allows(OTHER, "turn-a", "read")).toBe(false);
  });

  it("upgrades a turn from read to full but never downgrades it", () => {
    const { store } = clock();
    store.grant(PROJECT, "turn-a", "read");
    const upgraded = store.grant(PROJECT, "turn-a", "full");
    expect(upgraded.access).toBe("full");
    expect(store.allows(PROJECT, "turn-a", "full")).toBe(true);

    const downgraded = store.grant(PROJECT, "turn-a", "read");
    expect(downgraded.access).toBe("full");
    expect(store.allows(PROJECT, "turn-a", "full")).toBe(true);
  });

  it("expires a grant after the TTL from the last grant, and a fresh grant renews it", () => {
    const { store, state } = clock();
    const first = store.grant(PROJECT, "turn-a", "read");
    state.at = first.grantedAt + WEBSITE_GRANT_TTL_MS - 1;
    expect(store.allows(PROJECT, "turn-a", "read")).toBe(true);

    // A re-grant before the expiry keeps the turn's `grantedAt` and pushes the expiry out.
    const again = store.grant(PROJECT, "turn-a", "full");
    expect(again.grantedAt).toBe(first.grantedAt);
    expect(again.expiresAt).toBe(state.at + WEBSITE_GRANT_TTL_MS);

    // Past the new expiry the grant is gone; granting again starts a fresh grant.
    state.at = again.expiresAt;
    expect(store.allows(PROJECT, "turn-a", "full")).toBe(false);
    state.at = again.expiresAt + 999;
    const renewed = store.grant(PROJECT, "turn-a", "read");
    expect(renewed.grantedAt).toBe(state.at);
    expect(store.allows(PROJECT, "turn-a", "read")).toBe(true);
  });

  it("treats an expired grant as gone even when nothing swept it yet", () => {
    const { store, state } = clock();
    const first = store.grant(PROJECT, "turn-a", "full");
    state.at = first.expiresAt + 1;
    // No `allows` call in between: the next grant still starts fresh (the old `full` is not revived).
    const fresh = store.grant(PROJECT, "turn-a", "read");
    expect(fresh.grantedAt).toBe(state.at);
    expect(store.allows(PROJECT, "turn-a", "full")).toBe(false);
    expect(store.allows(PROJECT, "turn-a", "read")).toBe(true);
  });

  it("revokes a turn's grant and stays idempotent", () => {
    const { store } = clock();
    store.grant(PROJECT, "turn-a", "read");
    store.grant(PROJECT, "turn-b", "full");
    expect(store.revoke(PROJECT, "turn-a")).toBe(true);
    expect(store.revoke(PROJECT, "turn-a")).toBe(false);
    expect(store.revoke(OTHER, "turn-a")).toBe(false);
    expect(store.allows(PROJECT, "turn-a", "read")).toBe(false);
    // Revoking one turn leaves the other turn's grant alone.
    expect(store.allows(PROJECT, "turn-b", "full")).toBe(true);
  });

  it("answers a copy of the grant, so a caller cannot change the store", () => {
    const { store } = clock();
    const grant = store.grant(PROJECT, "turn-a", "read");
    grant.access = "full";
    expect(store.allows(PROJECT, "turn-a", "full")).toBe(false);
  });
});
