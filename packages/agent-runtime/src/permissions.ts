import { randomUUID } from "node:crypto";
import type {
  AgentId,
  PermissionAction,
  PermissionAsset,
  PermissionDecision,
  PermissionKind,
  PermissionRender,
  PermissionRequest,
  WebsiteGrantAccess,
} from "@hyperframes/agent-protocol";
import { RuntimeError, errorMessage } from "./errors.js";
import type { ResearchHost } from "./research/host.js";

/** How long revoking a turn's grant may take; the server also expires grants by itself. */
const REVOKE_TIMEOUT_MS = 10_000;

/** Kinds whose card offers only "Allow once" and "Don't allow": no setting stands behind them. */
const ONCE_ONLY_KINDS: readonly PermissionKind[] = ["long_render", "restricted_asset"];

/** Kinds that ask for one of the user's Websites settings and are answered per site. */
const WEBSITE_KINDS: readonly PermissionKind[] = ["read_linked_pages", "website_full_access"];

/** What an agent needs the user to allow; the broker fills id, state and timestamps. */
export interface PermissionAsk {
  kind: PermissionKind;
  action: PermissionAction;
  /** The site the call is about (registrable domain), when there is one. */
  site: string | null;
  /** Who is asking (a specialist inside its run, or the Director). */
  agent: AgentId;
  /** `asset_download` and `restricted_asset`: the material the request is about (from the runtime's memory or the server's refusal). */
  asset?: PermissionAsset;
  /** `long_render` only: the composition and its length. */
  render?: PermissionRender;
  /** `restricted_asset` only: which asset this is (its candidate id or URL); each asset is asked on its own. */
  key?: string;
}

export interface PermissionBrokerOptions {
  /** The running turn these requests belong to; its grant is revoked when the turn ends. */
  turnId: string;
  /** The user's answer reaches Studio through the research host (policy update, turn grant). */
  host: ResearchHost;
  /** Appends or updates the request's part in the main conversation's message and streams it to the chat. */
  publish: (permission: PermissionRequest) => Promise<void>;
  /** The turn's signal: aborting the turn expires pending requests, so their waiting calls return. */
  signal?: AbortSignal;
  now?: () => number;
  /**
   * Switches the global agent setting "ask before downloading" off ("Don't ask again" on an `asset_download` card).
   * When it throws the request stays pending and the answer route fails, so the user can retry.
   */
  disableDownloadAsk?: (signal: AbortSignal) => Promise<void>;
  ids?: () => string;
}

interface Entry {
  request: PermissionRequest;
  key: string;
  waiters: Array<(request: PermissionRequest) => void>;
  /** A turn grant was posted for this request ("Allow once"). */
  granted: boolean;
}

const allowed = (request: PermissionRequest): boolean =>
  request.state === "allowed_once" || request.state === "enabled";

/**
 * The permission requests of one running turn: a website tool whose setting is off asks the user from the chat and
 * waits here until they answer. Website requests are answered per site — "Allow once" covers the site on the card
 * only, a later ask for another site shows its own card — while "Turn on" switches the global setting on and so
 * covers every site. Concurrent asks for the same thing share the one request; an answered one is not asked again in
 * the turn (allowed calls proceed, a denial refuses every later call of it). A download approval is turn-wide, a
 * restricted-license approval is per asset, a long-render approval is per turn. The broker never times out by itself:
 * the turn's end (Stop, finish, failure) expires what is still pending, so the waiting call returns a refusal instead
 * of hanging.
 *
 * Answers reach Studio through the host: "Turn on" updates the Asset Search policy (`always`; full access also turns
 * reading on), "Allow once" posts a grant for this turn and site. `asset_download`, `restricted_asset` and
 * `long_render` cards need no Studio grant: "Allow once" only approves in this turn here, "Don't ask again" on a
 * download card switches the agent setting off through `disableDownloadAsk`, and the other two accept no "always".
 * When Studio (or the settings store) cannot apply the answer the request stays pending and the answer route fails,
 * so the user can retry.
 */
export class PermissionBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly byKey = new Map<string, string>();
  private readonly now: () => number;
  private readonly ids: () => string;
  /** Aborts when the turn is stopped; a host call of an answer is then cancelled with it. */
  private readonly signal: AbortSignal;
  private closed = false;

  constructor(private readonly options: PermissionBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;
    this.signal = options.signal ?? new AbortController().signal;
    options.signal?.addEventListener("abort", () => void this.expireAll(), { once: true });
  }

  private static keyOf(kind: PermissionKind, site: string | null, key: string | undefined): string {
    if (WEBSITE_KINDS.includes(kind)) return `${kind}|${site ?? ""}`;
    if (kind === "restricted_asset") return `${kind}|${key ?? ""}`;
    return kind;
  }

  /**
   * The entry that already answers an ask: its own, or — for the website kinds — a "Turn on" of the same kind (every
   * site), or a full-access request that covers a reading ask for the same site (full access includes reading, the
   * server's grants work the same way).
   */
  private find(
    kind: PermissionKind,
    site: string | null,
    key: string | undefined,
  ): Entry | undefined {
    const direct = this.entry(PermissionBroker.keyOf(kind, site, key));
    if (direct) return direct;
    if (!WEBSITE_KINDS.includes(kind)) return undefined;
    const covering: PermissionKind[] =
      kind === "read_linked_pages" ? ["read_linked_pages", "website_full_access"] : [kind];
    for (const entry of this.entries.values()) {
      if (!covering.includes(entry.request.kind)) continue;
      if (entry.request.state === "enabled") return entry;
      if (
        entry.request.kind !== kind &&
        entry.request.site === site &&
        entry.request.state !== "denied" &&
        entry.request.state !== "expired"
      )
        return entry;
    }
    return undefined;
  }

  private entry(key: string): Entry | undefined {
    const id = this.byKey.get(key);
    return id === undefined ? undefined : this.entries.get(id);
  }

  /**
   * The request that already answers an ask of this kind (and site / asset), without asking: null when the next ask
   * would show a new card.
   */
  peek(kind: PermissionKind, site: string | null, key?: string): PermissionRequest | null {
    return this.find(kind, site, key)?.request ?? null;
  }

  /**
   * The request for `kind`: the pending one when an ask for the same thing is already waiting (they share it), the
   * answered one otherwise. A new request is published to the chat and resolves once the user answers or the turn
   * expires it. `signal` is the asking call's own: when it aborts (the run that asked was cancelled) that call gets an
   * expired answer at once, and a request nobody else waits for is expired in the chat; the turn goes on.
   */
  async ask(input: PermissionAsk, signal?: AbortSignal): Promise<PermissionRequest> {
    signal?.throwIfAborted();
    const existing = this.find(input.kind, input.site, input.key);
    if (existing) {
      if (existing.request.state !== "pending") return existing.request;
      return this.wait(existing, signal);
    }
    const request: PermissionRequest = {
      id: this.ids(),
      kind: input.kind,
      action: input.action,
      site: input.site,
      agent: input.agent,
      state: "pending",
      requestedAt: this.now(),
      ...((input.kind === "asset_download" || input.kind === "restricted_asset") &&
        input.asset !== undefined && { asset: input.asset }),
      ...(input.kind === "long_render" && input.render !== undefined && { render: input.render }),
    };
    // The turn is already ending: nothing would expire a new pending request, so it answers as expired at once.
    if (this.closed) return { ...request, state: "expired" };
    const key = PermissionBroker.keyOf(input.kind, input.site, input.key);
    const entry: Entry = { request, key, waiters: [], granted: false };
    this.entries.set(request.id, entry);
    this.byKey.set(key, request.id);
    const waiter = this.wait(entry, signal);
    try {
      await this.options.publish(request);
    } catch (error) {
      this.entries.delete(request.id);
      if (this.byKey.get(key) === request.id) this.byKey.delete(key);
      this.settle(entry, { ...request, state: "expired" });
      throw new RuntimeError(
        "runtime_unavailable",
        errorMessage(error, "The permission request could not be shown in the chat"),
        503,
      );
    }
    return waiter;
  }

  /** Waits for the entry's answer; the call's own `signal` ends this wait alone (see {@link ask}). */
  private wait(entry: Entry, signal: AbortSignal | undefined): Promise<PermissionRequest> {
    return new Promise<PermissionRequest>((resolve) => {
      if (!signal) {
        entry.waiters.push(resolve);
        return;
      }
      const settled = (request: PermissionRequest): void => {
        signal.removeEventListener("abort", abandon);
        resolve(request);
      };
      const abandon = (): void => {
        const index = entry.waiters.indexOf(settled);
        if (index >= 0) entry.waiters.splice(index, 1);
        settled({ ...entry.request, state: "expired" });
        // Nobody else waits for this card: take it down, and a later ask shows a new one.
        if (entry.waiters.length === 0) void this.expireEntry(entry);
      };
      entry.waiters.push(settled);
      signal.addEventListener("abort", abandon, { once: true });
    });
  }

  /** Expires one request that is still pending and forgets it, so the next ask of its kind shows a new card. */
  private async expireEntry(entry: Entry): Promise<void> {
    if (entry.request.state !== "pending") return;
    const updated: PermissionRequest = {
      ...entry.request,
      state: "expired",
      answeredAt: this.now(),
    };
    entry.request = updated;
    this.entries.delete(updated.id);
    if (this.byKey.get(entry.key) === updated.id) this.byKey.delete(entry.key);
    await this.options.publish(updated).catch(() => undefined);
  }

  /**
   * The user's answer. `always` switches the setting on in the Asset Search policy, `once` posts a grant for this
   * turn and the card's site; when Studio cannot apply it the request stays pending and this throws, so the user can
   * retry. The answer is published and the waiting calls resume.
   */
  async answer(permissionId: string, decision: PermissionDecision): Promise<PermissionRequest> {
    const entry = this.entries.get(permissionId);
    if (!entry || entry.request.state !== "pending")
      throw new RuntimeError(
        "turn_not_active",
        "This permission request is no longer pending",
        409,
      );
    const { request } = entry;
    if (decision === "always" && ONCE_ONLY_KINDS.includes(request.kind))
      throw new RuntimeError(
        "invalid_request",
        "This request can only be allowed once or denied",
        400,
      );
    if (request.kind === "asset_download") {
      // No Studio grant: "once" only lets this turn's downloads through (see allowsDownload); "always" switches the
      // agents' "ask before downloading" setting off for good.
      if (decision === "always") {
        const disable = this.options.disableDownloadAsk;
        await this.apply(
          () =>
            disable
              ? disable(this.signal)
              : Promise.reject(new Error("This runtime cannot change the download setting")),
          "switch asking before downloads off",
        );
      }
    } else if (ONCE_ONLY_KINDS.includes(request.kind)) {
      // Nothing to apply: the waiting call goes on (or is refused) with the answer.
    } else if (decision === "always") {
      // Full access needs reading too, so "Turn on" switches both on for it.
      const websites =
        request.kind === "website_full_access"
          ? { readLinkedPages: true, fullAccess: true }
          : { readLinkedPages: true };
      await this.apply(
        () => this.options.host.updateWebsitePolicy({ websites }, this.signal),
        "switch the setting on",
      );
    } else if (decision === "once") {
      const access: WebsiteGrantAccess = request.kind === "website_full_access" ? "full" : "read";
      const { site } = request;
      // A grant covers one site; a request that names none is never read as every site (the server refuses it too).
      if (site === null)
        throw new RuntimeError(
          "invalid_request",
          "This request names no site, so it cannot be allowed once: turn the setting on or deny it",
          400,
        );
      await this.apply(
        () =>
          this.options.host.grantWebsite(
            { turnId: this.options.turnId, access, site },
            this.signal,
          ),
        "allow the request for this turn",
      );
      entry.granted = true;
    }
    const state =
      decision === "once" ? "allowed_once" : decision === "always" ? "enabled" : "denied";
    const updated: PermissionRequest = { ...request, state, answeredAt: this.now() };
    entry.request = updated;
    try {
      await this.options.publish(updated);
    } finally {
      // The answer is applied whether or not the chat could show it: the waiting call must not hang on a failed append.
      this.settle(entry, updated);
    }
    return updated;
  }

  /**
   * Forgets an allowed answer of `kind` (for `site`) that the server turned out not to honour — it restarted and lost
   * the turn's grant, or the setting was switched off again — so the next ask shows a new card instead of repeating the
   * stale "allowed". Returns whether an answer was dropped. A pending request, a denial and other sites are kept.
   */
  reset(kind: PermissionKind, site: string | null): boolean {
    let dropped = false;
    for (const [id, entry] of this.entries) {
      const { request } = entry;
      const sameSite = request.site === site || request.state === "enabled";
      const covers =
        request.kind === kind ||
        (kind === "read_linked_pages" && request.kind === "website_full_access");
      if (!allowed(request) || !covers || !sameSite) continue;
      this.entries.delete(id);
      if (this.byKey.get(entry.key) === id) this.byKey.delete(entry.key);
      dropped = true;
    }
    return dropped;
  }

  /**
   * The sites the user allowed once in this turn for `kind` (a full-access answer also allows reading); null when
   * they turned the setting on, because every site passes then.
   */
  grantedSites(kind: PermissionKind): string[] | null {
    const sites = new Set<string>();
    for (const { request } of this.entries.values()) {
      const covers =
        request.kind === kind ||
        (kind === "read_linked_pages" && request.kind === "website_full_access");
      if (!covers) continue;
      if (request.state === "enabled") return null;
      if (request.state === "allowed_once" && request.site !== null) sites.add(request.site);
    }
    return [...sites];
  }

  /**
   * The turn ended (finished, stopped or failed): every pending request becomes expired and its waiting call returns.
   * Safe to call more than once; a new ask after this answers as expired at once.
   */
  async expireAll(): Promise<void> {
    this.closed = true;
    for (const entry of [...this.entries.values()]) {
      if (entry.request.state !== "pending") continue;
      const updated: PermissionRequest = {
        ...entry.request,
        state: "expired",
        answeredAt: this.now(),
      };
      entry.request = updated;
      await this.options.publish(updated).catch(() => undefined);
      this.settle(entry, updated);
    }
  }

  /** Revokes this turn's grant at the turn's end (best effort; the server also expires it by itself). */
  async revokeGrant(): Promise<void> {
    if (![...this.entries.values()].some((entry) => entry.granted)) return;
    await this.options.host
      .revokeWebsiteGrant(this.options.turnId, AbortSignal.timeout(REVOKE_TIMEOUT_MS))
      .catch(() => undefined);
  }

  /** Whether a request of `kind` was answered "Allow once" or "Turn on" in this turn (any site or asset). */
  allowsKind(kind: PermissionKind): boolean {
    return [...this.entries.values()].some(
      (entry) => entry.request.kind === kind && allowed(entry.request),
    );
  }

  /**
   * Whether the user approved downloads in this turn from a card: "Allow once" or "Turn on" on an `asset_download`
   * card, or on a website card that was about saving something (a download or a recording). An answer to a card that
   * only asked to open or read a page is not: it never told the user a file would be saved.
   */
  allowsDownload(): boolean {
    return [...this.entries.values()].some(
      ({ request }) =>
        allowed(request) &&
        (request.kind === "asset_download" ||
          (WEBSITE_KINDS.includes(request.kind) &&
            (request.action === "download" || request.action === "record"))),
    );
  }

  private async apply(operation: () => Promise<unknown>, what: string): Promise<void> {
    try {
      await operation();
    } catch (error) {
      throw new RuntimeError(
        "runtime_unavailable",
        errorMessage(error, `Could not ${what}; answer the request again`),
        503,
      );
    }
  }

  private settle(entry: Entry, request: PermissionRequest): void {
    for (const resolve of entry.waiters.splice(0)) resolve(request);
  }
}
