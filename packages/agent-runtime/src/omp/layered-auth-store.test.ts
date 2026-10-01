import { describe, expect, it } from "vitest";
import type {
  AuthCredential,
  AuthCredentialStore,
  StoredAuthCredential,
} from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
  LayeredAuthCredentialStore,
  OPENVIDS_CREDENTIAL_ID_BASE,
  isOpenVidsCredentialId,
} from "./layered-auth-store.ts";

/** An in-memory credential store that records every write, standing in for one SQLite database. */
class FakeStore implements AuthCredentialStore {
  rows: StoredAuthCredential[] = [];
  disabled: Array<{ id: number; provider: string; cause: string }> = [];
  cache = new Map<string, string>();
  leases = new Map<number, string>();
  blocks: Array<{
    credentialId: number;
    providerKey: string;
    blockScope: string;
    blockedUntilMs: number;
  }> = [];
  writes: string[] = [];
  changed = false;
  closed = false;
  private nextId = 1;

  constructor(readonly label: string) {}

  add(provider: string, credential: AuthCredential): number {
    const id = this.nextId++;
    this.rows.push({ id, provider, credential, disabledCause: null });
    return id;
  }

  close(): void {
    this.closed = true;
  }
  pollExternalChanges(): boolean {
    const was = this.changed;
    this.changed = false;
    return was;
  }
  listAuthCredentials(provider?: string): StoredAuthCredential[] {
    return this.rows.filter((row) => provider === undefined || row.provider === provider);
  }
  async listDisabledCredentials(provider?: string) {
    return this.disabled
      .filter((entry) => provider === undefined || entry.provider === provider)
      .map((entry) => ({
        id: entry.id,
        provider: entry.provider,
        type: "oauth" as const,
        cause: entry.cause,
      }));
  }
  updateAuthCredential(id: number, credential: AuthCredential): void {
    this.writes.push(`update ${id}`);
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) row.credential = credential;
  }
  async deleteAuthCredential(id: number, cause: string): Promise<boolean> {
    this.writes.push(`delete ${id}`);
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return false;
    this.rows = this.rows.filter((candidate) => candidate !== row);
    this.disabled.push({ id, provider: row.provider, cause });
    return true;
  }
  tryDisableAuthCredentialIfMatches(id: number, _expected: string, cause: string): boolean {
    this.writes.push(`disable ${id}`);
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return false;
    this.rows = this.rows.filter((candidate) => candidate !== row);
    this.disabled.push({ id, provider: row.provider, cause });
    return true;
  }
  tryUpdateAuthCredentialIfMatches(
    id: number,
    _expected: string,
    credential: AuthCredential,
  ): boolean {
    this.writes.push(`refresh ${id}`);
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return false;
    row.credential = credential;
    return true;
  }
  async replaceAuthCredentials(provider: string, credentials: AuthCredential[]) {
    this.writes.push(`replace ${provider}`);
    this.rows = this.rows.filter((row) => row.provider !== provider);
    for (const credential of credentials) this.add(provider, credential);
    return this.listAuthCredentials(provider);
  }
  async upsertAuthCredential(provider: string, credential: AuthCredential) {
    this.writes.push(`upsert ${provider}`);
    this.add(provider, credential);
    return this.listAuthCredentials(provider);
  }
  async deleteAuthCredentials(provider: string, cause: string): Promise<void> {
    this.writes.push(`logout ${provider} (${cause})`);
    this.rows = this.rows.filter((row) => row.provider !== provider);
  }
  getCache(key: string): string | null {
    return this.cache.get(key) ?? null;
  }
  setCache(key: string, value: string): void {
    this.writes.push(`cache ${key}`);
    this.cache.set(key, value);
  }
  cleanExpiredCache(): void {}
  tryAcquireCredentialRefreshLease(id: number, owner: string): boolean {
    this.writes.push(`lease ${id}`);
    this.leases.set(id, owner);
    return true;
  }
  getCredentialRefreshLeaseExpiresAt(id: number): number | undefined {
    return this.leases.has(id) ? 1 : undefined;
  }
  releaseCredentialRefreshLease(id: number): void {
    this.leases.delete(id);
  }
  renewCredentialRefreshLease(id: number): boolean {
    return this.leases.has(id);
  }
  upsertCredentialBlock(block: (typeof this.blocks)[number]): void {
    this.writes.push(`block ${block.credentialId}`);
    this.blocks.push(block);
  }
  listCredentialBlocks(ids: readonly number[]) {
    return this.blocks.filter((block) => ids.includes(block.credentialId));
  }
}

const oauth = (access: string, refresh: string): AuthCredential => ({
  type: "oauth",
  access,
  refresh,
  expires: 9_999_999_999_999,
});

function layers() {
  const omp = new FakeStore("omp");
  const own = new FakeStore("openvids");
  return { omp, own, store: new LayeredAuthCredentialStore(omp, own) };
}

describe("the layered credential store", () => {
  it("shows OMP's credentials and OpenVids' own side by side with ids that cannot collide", () => {
    const { omp, own, store } = layers();
    const ompId = omp.add("google-gemini-cli", oauth("omp-access", "omp-refresh"));
    const ownId = own.add("kimi-code", oauth("ov-access", "ov-refresh"));
    expect(ompId).toBe(ownId); // both stores number their rows from 1

    const rows = store.listAuthCredentials();
    expect(rows.map((row) => [row.provider, isOpenVidsCredentialId(row.id)])).toEqual([
      ["google-gemini-cli", false],
      ["kimi-code", true],
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows[1]?.id).toBe(OPENVIDS_CREDENTIAL_ID_BASE + ownId);
    expect(store.listAuthCredentials("kimi-code")).toHaveLength(1);
    expect(store.listAuthCredentials("nothing")).toEqual([]);
  });

  it("shows a provider signed in with OpenVids by its own credentials only, and OMP's again after sign-out", async () => {
    const { omp, own, store } = layers();
    omp.add("anthropic", oauth("omp-access", "omp-refresh"));
    expect(
      store.listAuthCredentials("anthropic").map((row) => isOpenVidsCredentialId(row.id)),
    ).toEqual([false]);

    await store.upsertAuthCredential("anthropic", oauth("ov-access", "ov-refresh"));
    const shown = store.listAuthCredentials("anthropic");
    expect(shown.map((row) => [isOpenVidsCredentialId(row.id), row.credential.type])).toEqual([
      [true, "oauth"],
    ]);
    expect(store.listAuthCredentials().filter((row) => row.provider === "anthropic")).toHaveLength(
      1,
    );

    await store.deleteAuthCredentials("anthropic", "deleted by user");
    expect(own.writes.slice(-2)).toEqual(["update 1", "logout anthropic (deleted by user)"]);
    expect(
      store.listAuthCredentials("anthropic").map((row) => isOpenVidsCredentialId(row.id)),
    ).toEqual([false]);
    // OMP's database was never written.
    expect(omp.writes).toEqual([]);
    expect(omp.rows).toHaveLength(1);
  });

  it("blanks the tokens of a signed-out credential before retiring it, so none stay in the file", async () => {
    const { own, store } = layers();
    own.add("kimi-code", {
      type: "oauth",
      access: "ov-access",
      refresh: "ov-refresh",
      expires: 9,
      email: "me@example.test",
    });
    own.add("openrouter", { type: "api_key", key: "sk-or-secret" });
    const retired: AuthCredential[] = [];
    const original = own.deleteAuthCredentials.bind(own);
    own.deleteAuthCredentials = async (provider, cause) => {
      retired.push(
        ...own.rows.filter((row) => row.provider === provider).map((row) => row.credential),
      );
      await original(provider, cause);
    };
    await store.deleteAuthCredentials("kimi-code", "deleted by user");
    await store.deleteAuthCredentials("openrouter", "deleted by user");
    expect(retired).toEqual([
      { type: "oauth", access: "", refresh: "", expires: 9, email: "me@example.test" },
      { type: "api_key", key: "" },
    ]);
  });

  it("stores a new sign-in and a replaced key in OpenVids' store only", async () => {
    const { omp, own, store } = layers();
    const rows = await store.upsertAuthCredential("kimi-code", oauth("a", "r"));
    expect(rows.map((row) => isOpenVidsCredentialId(row.id))).toEqual([true]);
    await store.replaceAuthCredentials("openrouter", [{ type: "api_key", key: "k" }]);
    expect(own.writes).toEqual(["upsert kimi-code", "replace openrouter"]);
    expect(omp.writes).toEqual([]);
    expect(omp.rows).toEqual([]);
  });

  it("persists a token refresh into the store that owns the row, with the id that store knows", () => {
    const { omp, own, store } = layers();
    omp.add("google-gemini-cli", oauth("omp-access", "omp-refresh"));
    own.add("kimi-code", oauth("ov-access-1", "ov-refresh-1"));
    const [ompRow, ownRow] = store.listAuthCredentials();
    if (!ompRow || !ownRow) throw new Error("rows missing");

    expect(
      store.tryUpdateAuthCredentialIfMatches(
        ownRow.id,
        "expected",
        oauth("ov-access-2", "ov-refresh-2"),
      ),
    ).toBe(true);
    expect(own.rows[0]?.credential).toMatchObject({
      access: "ov-access-2",
      refresh: "ov-refresh-2",
    });
    expect(own.writes).toEqual(["refresh 1"]);
    expect(omp.writes).toEqual([]);

    // A credential OMP owns is refreshed in OMP's store: its rotating refresh token must stay valid for OMP.
    expect(
      store.tryUpdateAuthCredentialIfMatches(
        ompRow.id,
        "expected",
        oauth("omp-access-2", "omp-refresh-2"),
      ),
    ).toBe(true);
    expect(omp.rows[0]?.credential).toMatchObject({ access: "omp-access-2" });
    expect(omp.writes).toEqual(["refresh 1"]);
    expect(own.rows[0]?.credential).toMatchObject({ access: "ov-access-2" });
  });

  it("routes disables, leases and rate-limit blocks by the id of the row", async () => {
    const { omp, own, store } = layers();
    omp.add("a", oauth("x", "y"));
    own.add("b", oauth("x", "y"));
    const [ompRow, ownRow] = store.listAuthCredentials();
    if (!ompRow || !ownRow) throw new Error("rows missing");

    expect(
      store.tryDisableAuthCredentialIfMatches(
        ownRow.id,
        "d",
        "oauth refresh failed: invalid_grant",
      ),
    ).toBe(true);
    expect(own.disabled).toEqual([
      { id: 1, provider: "b", cause: "oauth refresh failed: invalid_grant" },
    ]);
    expect(omp.disabled).toEqual([]);
    // The tombstone is listed with the layered id.
    const tombstones = await store.listDisabledCredentials();
    expect(tombstones.map((entry) => [entry.provider, isOpenVidsCredentialId(entry.id)])).toEqual([
      ["b", true],
    ]);

    expect(store.tryAcquireCredentialRefreshLease(ownRow.id, "me", 5)).toBe(true);
    expect(store.getCredentialRefreshLeaseExpiresAt(ownRow.id)).toBe(1);
    expect(own.leases.get(1)).toBe("me");
    expect(omp.leases.size).toBe(0);
    store.releaseCredentialRefreshLease(ownRow.id, "me");
    expect(own.leases.size).toBe(0);

    store.upsertCredentialBlock({
      credentialId: ompRow.id,
      providerKey: "a:oauth",
      blockScope: "",
      blockedUntilMs: 9,
    });
    store.upsertCredentialBlock({
      credentialId: ownRow.id,
      providerKey: "b:oauth",
      blockScope: "",
      blockedUntilMs: 9,
    });
    expect(omp.blocks.map((block) => block.credentialId)).toEqual([ompRow.id]);
    expect(own.blocks.map((block) => block.credentialId)).toEqual([1]);
    const listed = store.listCredentialBlocks([ompRow.id, ownRow.id]);
    expect(listed.map((block) => block.credentialId).sort()).toEqual([ompRow.id, ownRow.id].sort());
  });

  it("keeps the SDK's cache in OpenVids' store and reports a change in either database", () => {
    const { omp, own, store } = layers();
    store.setCache("usage:x", "v", 1);
    expect(own.cache.get("usage:x")).toBe("v");
    expect(omp.cache.size).toBe(0);
    expect(store.getCache("usage:x")).toBe("v");

    expect(store.pollExternalChanges()).toBe(false);
    own.changed = true;
    expect(store.pollExternalChanges()).toBe(true);
    expect(store.pollExternalChanges()).toBe(false);
    omp.changed = true;
    expect(store.pollExternalChanges()).toBe(true);
  });

  it("closes both databases", () => {
    const { omp, own, store } = layers();
    store.close();
    expect([omp.closed, own.closed]).toEqual([true, true]);
  });
});
