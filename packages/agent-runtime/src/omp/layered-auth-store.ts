import type {
  AuthCredential,
  AuthCredentialStore,
  StoredAuthCredential,
} from "@oh-my-pi/pi-coding-agent/session/auth-storage";

/**
 * Credential ids of the OpenVids store are shifted by this much so the two stores' ids never collide inside one
 * `AuthStorage` (blocks, refresh leases and sessions are keyed by id). SQLite row ids are small integers, far below it.
 */
export const OPENVIDS_CREDENTIAL_ID_BASE = 1_000_000_000_000;

export function isOpenVidsCredentialId(id: number): boolean {
  return id >= OPENVIDS_CREDENTIAL_ID_BASE;
}

type DisabledCredentialSummary = Awaited<
  ReturnType<NonNullable<AuthCredentialStore["listDisabledCredentials"]>>
>[number];
type CredentialBlock = Parameters<NonNullable<AuthCredentialStore["upsertCredentialBlock"]>>[0];
type RefreshLeaseFence = Parameters<AuthCredentialStore["tryDisableAuthCredentialIfMatches"]>[3];

/** The same credential without anything that could be used: tokens and keys emptied, identity kept. */
function scrubbed(credential: AuthCredential): AuthCredential {
  return credential.type === "oauth"
    ? { ...credential, access: "", refresh: "" }
    : { ...credential, key: "" };
}

const toOpenVids = (id: number): number => id + OPENVIDS_CREDENTIAL_ID_BASE;
const fromOpenVids = (id: number): number => id - OPENVIDS_CREDENTIAL_ID_BASE;

/**
 * One credential store for the SDK made of two: the user's OMP store (`~/.omp/agent/agent.db`) and OpenVids' own
 * (`~/.openvids/agent/auth.db`). The SDK's `AuthStorage` takes a single store, so this is how a sign-in made inside
 * OpenVids can sit beside what OMP already holds without ever being written into OMP's database.
 *
 * - **Reads** show both. A provider that has a credential in the OpenVids store is shown with those credentials only:
 *   a sign-in made in OpenVids replaces OMP's login for that provider (as an OpenVids API key does) until it is signed
 *   out, and the OMP rows stay untouched underneath.
 * - **New credentials** (a sign-in, a login-stored key) and a **sign-out** go to the OpenVids store only.
 * - **Updates by id** — a token refresh, a disable after a definitive refresh failure, refresh leases, rate-limit
 *   blocks — go to the store that owns the row (`isOpenVidsCredentialId`). So an OpenVids credential's refresh is
 *   persisted in the OpenVids store; a credential OMP owns is still refreshed in OMP's store, exactly as the SDK did
 *   before OpenVids layered anything: OAuth refresh tokens rotate, and a refresh that OMP's database never saw would
 *   invalidate the user's OMP login.
 * - The SDK's cache rows (usage reports and the like) live in the OpenVids store.
 * - Another process's commit to either database is reported by `pollExternalChanges`.
 */
export class LayeredAuthCredentialStore implements AuthCredentialStore {
  constructor(
    private readonly omp: AuthCredentialStore,
    private readonly openvids: AuthCredentialStore,
  ) {}

  private owner(id: number): AuthCredentialStore {
    return isOpenVidsCredentialId(id) ? this.openvids : this.omp;
  }

  private local(id: number): number {
    return isOpenVidsCredentialId(id) ? fromOpenVids(id) : id;
  }

  close(): void {
    try {
      this.openvids.close();
    } finally {
      this.omp.close();
    }
  }

  pollExternalChanges(): boolean {
    const own = this.openvids.pollExternalChanges?.() ?? false;
    const theirs = this.omp.pollExternalChanges?.() ?? false;
    return own || theirs;
  }

  acknowledgeLocalChanges(): void {
    this.openvids.acknowledgeLocalChanges?.();
    this.omp.acknowledgeLocalChanges?.();
  }

  listAuthCredentials(provider?: string): StoredAuthCredential[] {
    const mine = this.openvids
      .listAuthCredentials(provider)
      .map((row) => ({ ...row, id: toOpenVids(row.id) }));
    const owned = new Set(mine.map((row) => row.provider));
    const others = this.omp.listAuthCredentials(provider).filter((row) => !owned.has(row.provider));
    return [...others, ...mine];
  }

  async listDisabledCredentials(provider?: string): Promise<DisabledCredentialSummary[]> {
    const [theirs, mine] = await Promise.all([
      this.omp.listDisabledCredentials?.(provider) ?? [],
      this.openvids.listDisabledCredentials?.(provider) ?? [],
    ]);
    return [...theirs, ...mine.map((entry) => ({ ...entry, id: toOpenVids(entry.id) }))];
  }

  updateAuthCredential(id: number, credential: AuthCredential): void {
    this.owner(id).updateAuthCredential(this.local(id), credential);
  }

  deleteAuthCredential(id: number, disabledCause: string): Promise<boolean> {
    return this.owner(id).deleteAuthCredential(this.local(id), disabledCause);
  }

  tryDisableAuthCredentialIfMatches(
    id: number,
    expectedData: string,
    disabledCause: string,
    lease?: RefreshLeaseFence,
  ): boolean {
    return this.owner(id).tryDisableAuthCredentialIfMatches(
      this.local(id),
      expectedData,
      disabledCause,
      lease,
    );
  }

  tryUpdateAuthCredentialIfMatches(
    id: number,
    expectedData: string,
    credential: AuthCredential,
    lease?: RefreshLeaseFence,
  ): boolean {
    const store = this.owner(id);
    if (!store.tryUpdateAuthCredentialIfMatches) {
      throw new Error("The credential store cannot update a credential conditionally");
    }
    return store.tryUpdateAuthCredentialIfMatches(this.local(id), expectedData, credential, lease);
  }

  async replaceAuthCredentials(
    provider: string,
    credentials: AuthCredential[],
  ): Promise<StoredAuthCredential[]> {
    await this.openvids.replaceAuthCredentials(provider, credentials);
    return this.listAuthCredentials(provider);
  }

  async upsertAuthCredential(
    provider: string,
    credential: AuthCredential,
  ): Promise<StoredAuthCredential[]> {
    await this.openvids.upsertAuthCredential(provider, credential);
    return this.listAuthCredentials(provider);
  }

  /**
   * Sign-out: removes OpenVids' own credentials of the provider; whatever OMP holds is never touched. The SDK retires a
   * row by marking it disabled and keeps its data, so the tokens are blanked first: nothing usable stays in the file.
   * (The provider is not told: a grant is revoked at the provider's own account page.)
   */
  async deleteAuthCredentials(provider: string, disabledCause: string): Promise<void> {
    for (const row of this.openvids.listAuthCredentials(provider)) {
      try {
        this.openvids.updateAuthCredential(row.id, scrubbed(row.credential));
      } catch {
        // The row is retired below either way.
      }
    }
    await this.openvids.deleteAuthCredentials(provider, disabledCause);
  }

  getCache(key: string, options?: { includeExpired?: boolean }): string | null {
    return this.openvids.getCache(key, options);
  }

  setCache(key: string, value: string, expiresAtSec: number): void {
    this.openvids.setCache(key, value, expiresAtSec);
  }

  deleteCachePrefix(prefix: string): void {
    this.openvids.deleteCachePrefix?.(prefix);
  }

  cleanExpiredCache(): void {
    this.openvids.cleanExpiredCache();
  }

  // ── Rate-limit blocks: by the id of the credential they belong to ──────────

  getCredentialBlock(
    credentialId: number,
    providerKey: string,
    blockScope: string,
  ): number | undefined {
    return this.owner(credentialId).getCredentialBlock?.(
      this.local(credentialId),
      providerKey,
      blockScope,
    );
  }

  getCredentialBlockReconcileAfter(
    credentialId: number,
    providerKey: string,
    blockScope: string,
  ): number | undefined {
    return this.owner(credentialId).getCredentialBlockReconcileAfter?.(
      this.local(credentialId),
      providerKey,
      blockScope,
    );
  }

  upsertCredentialBlock(block: CredentialBlock): void {
    this.owner(block.credentialId).upsertCredentialBlock?.({
      ...block,
      credentialId: this.local(block.credentialId),
    });
  }

  deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void {
    this.owner(credentialId).deleteCredentialBlock?.(
      this.local(credentialId),
      providerKey,
      blockScope,
    );
  }

  deleteCredentialBlocks(credentialId: number): void {
    this.owner(credentialId).deleteCredentialBlocks?.(this.local(credentialId));
  }

  cleanExpiredCredentialBlocks(nowMs: number): void {
    this.omp.cleanExpiredCredentialBlocks?.(nowMs);
    this.openvids.cleanExpiredCredentialBlocks?.(nowMs);
  }

  listCredentialBlocks(credentialIds: readonly number[]): CredentialBlock[] {
    const mine = credentialIds.filter(isOpenVidsCredentialId).map(fromOpenVids);
    const theirs = credentialIds.filter((id) => !isOpenVidsCredentialId(id));
    return [
      ...(theirs.length > 0 ? (this.omp.listCredentialBlocks?.(theirs) ?? []) : []),
      ...(mine.length > 0 ? (this.openvids.listCredentialBlocks?.(mine) ?? []) : []).map(
        (block) => ({ ...block, credentialId: toOpenVids(block.credentialId) }),
      ),
    ];
  }

  // ── Refresh leases: they fence a refresh of one row, so they live beside it ──

  tryAcquireCredentialRefreshLease(
    credentialId: number,
    owner: string,
    expiresAtMs: number,
  ): boolean {
    return (
      this.owner(credentialId).tryAcquireCredentialRefreshLease?.(
        this.local(credentialId),
        owner,
        expiresAtMs,
      ) ?? false
    );
  }

  getCredentialRefreshLeaseExpiresAt(credentialId: number): number | undefined {
    return this.owner(credentialId).getCredentialRefreshLeaseExpiresAt?.(this.local(credentialId));
  }

  releaseCredentialRefreshLease(credentialId: number, owner: string): void {
    this.owner(credentialId).releaseCredentialRefreshLease?.(this.local(credentialId), owner);
  }

  renewCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean {
    return (
      this.owner(credentialId).renewCredentialRefreshLease?.(
        this.local(credentialId),
        owner,
        expiresAtMs,
      ) ?? false
    );
  }
}
