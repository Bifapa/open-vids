import { randomUUID } from "node:crypto";
import type {
  AgentId,
  PermissionAction,
  PermissionDecision,
  PermissionKind,
  PermissionRequest,
  WebsiteGrantAccess,
} from "@hyperframes/agent-protocol";
import { RuntimeError, errorMessage } from "./errors.js";
import type { ResearchHost } from "./research/host.js";

/** How long revoking a turn's grant may take; the server also expires grants by itself. */
const REVOKE_TIMEOUT_MS = 10_000;

/** What an agent needs the user to allow; the broker fills id, state and timestamps. */
export interface PermissionAsk {
  kind: PermissionKind;
  action: PermissionAction;
  /** The site the call is about (registrable domain), when there is one. */
  site: string | null;
  /** Who is asking (a specialist inside its run, or the Director). */
  agent: AgentId;
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
  ids?: () => string;
}

interface Entry {
  request: PermissionRequest;
  waiters: Array<(request: PermissionRequest) => void>;
  /** A turn grant was posted for this request ("Allow once"). */
  granted: boolean;
}

/**
 * The permission requests of one running turn: a website tool whose setting is off asks the user from the chat and
 * waits here until they answer. Concurrent asks of the same kind share the one request; an answered kind is not asked
 * again in the turn (allowed calls proceed, a denial refuses every later call of that kind). The broker never times
 * out by itself: the turn's end (Stop, finish, failure) expires what is still pending, so the waiting call returns a
 * refusal instead of hanging.
 *
 * Answers reach Studio through the host: "Turn on" updates the Asset Search policy (`always`; full access also turns
 * reading on), "Allow once" posts a grant for this turn. When Studio cannot apply the answer the request stays
 * pending and the answer route fails, so the user can retry.
 */
export class PermissionBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly byKind = new Map<PermissionKind, string>();
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

  /**
   * The request for `kind`: the pending one when an ask of the same kind is already waiting (they share it), the
   * answered one otherwise (an allowed or denied kind is not asked again). An answered `website_full_access` request
   * covers a later reading ask, because full access includes reading. A new request is published to the chat and
   * resolves once the user answers or the turn expires it.
   */
  async ask(input: PermissionAsk): Promise<PermissionRequest> {
    // Full access includes reading (the server's grants work the same way), so an answered full-access request
    // covers a later reading ask in this turn.
    const coveredId =
      input.kind === "read_linked_pages" ? this.byKind.get("website_full_access") : undefined;
    const existingId = this.byKind.get(input.kind) ?? coveredId;
    const existing = existingId === undefined ? undefined : this.entries.get(existingId);
    if (existing) {
      if (existing.request.state !== "pending") return existing.request;
      return new Promise<PermissionRequest>((resolve) => existing.waiters.push(resolve));
    }
    const request: PermissionRequest = {
      id: this.ids(),
      kind: input.kind,
      action: input.action,
      site: input.site,
      agent: input.agent,
      state: "pending",
      requestedAt: this.now(),
    };
    // The turn is already ending: nothing would expire a new pending request, so it answers as expired at once.
    if (this.closed) return { ...request, state: "expired" };
    const entry: Entry = { request, waiters: [], granted: false };
    this.entries.set(request.id, entry);
    this.byKind.set(request.kind, request.id);
    const waiter = new Promise<PermissionRequest>((resolve) => entry.waiters.push(resolve));
    try {
      await this.options.publish(request);
    } catch (error) {
      this.entries.delete(request.id);
      this.byKind.delete(request.kind);
      this.settle(entry, { ...request, state: "expired" });
      throw new RuntimeError(
        "runtime_unavailable",
        errorMessage(error, "The permission request could not be shown in the chat"),
        503,
      );
    }
    return waiter;
  }

  /**
   * The user's answer. `always` switches the setting on in the Asset Search policy, `once` posts a grant for this
   * turn; when Studio cannot apply it the request stays pending and this throws, so the user can retry. The answer is
   * published and the waiting calls resume.
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
    if (decision === "always") {
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
      await this.apply(
        () => this.options.host.grantWebsite({ turnId: this.options.turnId, access }, this.signal),
        "allow the request for this turn",
      );
      entry.granted = true;
    }
    const state =
      decision === "once" ? "allowed_once" : decision === "always" ? "enabled" : "denied";
    const updated: PermissionRequest = { ...request, state, answeredAt: this.now() };
    entry.request = updated;
    await this.options.publish(updated);
    this.settle(entry, updated);
    return updated;
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

  /**
   * Whether the user allowed something in this turn ("Allow once" or "Turn on"). Such an answer is also their
   * approval for the website tools' downloads in this turn.
   */
  allowsWebsiteDownload(): boolean {
    return [...this.entries.values()].some(
      (entry) => entry.request.state === "allowed_once" || entry.request.state === "enabled",
    );
  }

  private async apply(operation: () => Promise<unknown>, what: string): Promise<void> {
    try {
      await operation();
    } catch (error) {
      throw new RuntimeError(
        "runtime_unavailable",
        errorMessage(error, `Studio could not ${what}; answer the request again`),
        503,
      );
    }
  }

  private settle(entry: Entry, request: PermissionRequest): void {
    for (const resolve of entry.waiters.splice(0)) resolve(request);
  }
}
