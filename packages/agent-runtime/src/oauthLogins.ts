import { randomBytes } from "node:crypto";
import type { OAuthFlow, OAuthLoginState } from "@hyperframes/agent-protocol";
import { RuntimeError } from "./errors.js";

/**
 * In-app OAuth sign-ins as the runtime's HTTP API sees them: start one, poll it, answer its prompt, cancel it. The
 * provider-specific work is a {@link LoginRunner} (the OMP adapter's, in production); this class owns what the API
 * promises around it — one sign-in per provider, a state a UI can poll, a time limit, and a clean stop (the runner's
 * `signal` aborts, and a runner that honours it closes its callback server) on cancel, timeout and shutdown.
 *
 * Secrets stay out: the answer a user submits goes straight to the runner and is never kept in the state, and every
 * message that reaches a state is made a single line with token-like strings removed ({@link sanitizeLoginMessage}).
 */

/** What a runner may tell the user and ask of them; mirrors the SDK's login controller. */
export interface LoginController {
  /** Aborted when the sign-in is cancelled, expires or the runtime shuts down. The runner must stop and clean up. */
  signal: AbortSignal;
  onAuth(info: { url: string; instructions?: string | undefined }): void;
  onProgress(message: string): void;
  /** Asks the user for text; settles with their answer, or rejects when the sign-in ends first. */
  onPrompt(prompt: {
    message: string;
    placeholder?: string | undefined;
    secret?: boolean | undefined;
  }): Promise<string>;
}

/** Runs one sign-in to the end: resolves once the credential is stored, rejects on failure or when aborted. */
export type LoginRunner = (loginId: string, controller: LoginController) => Promise<void>;

export interface OAuthLoginsOptions {
  run: LoginRunner;
  /** Called after a sign-in stored its credential (rebuild the catalog); a failure here is not the sign-in's. */
  onSucceeded?: (provider: string) => Promise<void>;
  now?: () => number;
  ids?: () => string;
  /** How long an unfinished sign-in may take before it is given up. Default 10 minutes. */
  timeoutMs?: number;
  /** How long a finished sign-in stays pollable. Default 10 minutes. */
  retainMs?: number;
  /** How long `start` waits for the first thing to show the user (URL or prompt). Default 8 seconds. */
  firstStateWaitMs?: number;
  /** Most sign-ins in flight at once. Default 8. */
  maxActive?: number;
  /** How long a cancel or shutdown waits for a runner to wind down before it stops waiting. Default 3 seconds. */
  stopGraceMs?: number;
}

export interface StartLogin {
  provider: string;
  /** The runner's own id for the login to run (a provider can offer several). */
  loginId: string;
  flow: OAuthFlow;
}

type StopReason = "cancelled" | "expired" | "shutdown";

interface PendingPrompt {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

interface LoginRecord {
  state: OAuthLoginState;
  controller: AbortController;
  prompt: PendingPrompt | null;
  stop: StopReason | null;
  done: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  retention: ReturnType<typeof setTimeout> | null;
}

const MAX_MESSAGE_CHARS = 300;
const TOKEN_LIKE = /[A-Za-z0-9_\-.~+/=]{32,}/g;

/**
 * One short line for a failure or a progress note: whitespace collapsed, anything shaped like a token, a code or a long
 * URL query removed, bounded in length.
 */
export function sanitizeLoginMessage(text: string): string {
  const flat = text
    .replace(
      /(?:[?&](?:code|state|token|access_token|refresh_token|code_verifier)=)[^\s&"']*/gi,
      "",
    )
    .replace(TOKEN_LIKE, "…")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS - 1)}…` : flat;
}

/** The short code in provider wording such as "Enter code: ABCD-1234", or null when it cannot be told apart. */
export function extractDeviceCode(instructions: string | null): string | null {
  if (!instructions) return null;
  const match =
    /\bcode\s*[:：]\s*([A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})?)/i.exec(instructions) ??
    /\b([A-Z0-9]{4}-[A-Z0-9]{4,})\b/.exec(instructions);
  return match?.[1] ?? null;
}

function failureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = sanitizeLoginMessage(raw);
  return message || "The sign-in failed.";
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);

export class OAuthLogins {
  private readonly records = new Map<string, LoginRecord>();
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly timeoutMs: number;
  private readonly retainMs: number;
  private readonly firstStateWaitMs: number;
  private readonly maxActive: number;
  private readonly stopGraceMs: number;
  private disposed = false;

  constructor(private readonly options: OAuthLoginsOptions) {
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? (() => randomBytes(16).toString("hex"));
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.retainMs = options.retainMs ?? 600_000;
    this.firstStateWaitMs = options.firstStateWaitMs ?? 8_000;
    this.maxActive = options.maxActive ?? 8;
    this.stopGraceMs = options.stopGraceMs ?? 3_000;
  }

  /** Waits for a runner to wind down, but never longer than the grace period (a runner may ignore its signal). */
  private async settled(record: LoginRecord): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      record.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.stopGraceMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Starts a sign-in, or — one per provider at a time — returns the one already running for that provider. Answers
   * once the user has something to act on (the URL or a prompt), the sign-in ended, or the wait ran out (then the
   * state is `pending` without a URL yet and the caller polls).
   */
  async start(request: StartLogin): Promise<OAuthLoginState> {
    if (this.disposed)
      throw new RuntimeError("runtime_unavailable", "The runtime is shutting down", 503);
    const running = this.activeFor(request.provider);
    if (running) return this.snapshot(running);
    if (this.activeCount() >= this.maxActive)
      throw new RuntimeError("invalid_request", "Too many sign-ins are in progress", 409);

    const started = this.now();
    const record: LoginRecord = {
      state: {
        id: this.ids(),
        provider: request.provider,
        status: "pending",
        flow: request.flow,
        authUrl: null,
        instructions: null,
        deviceCode: null,
        progress: null,
        prompt: null,
        error: null,
        startedAt: started,
        expiresAt: started + this.timeoutMs,
      },
      controller: new AbortController(),
      prompt: null,
      stop: null,
      done: Promise.resolve(),
      timer: null,
      retention: null,
    };
    this.records.set(record.state.id, record);
    const changed = Promise.withResolvers<void>();
    const firstState = () => {
      const { state } = record;
      if (state.authUrl !== null || state.prompt !== null || TERMINAL.has(state.status))
        changed.resolve();
    };

    record.timer = setTimeout(() => this.stopRecord(record, "expired"), this.timeoutMs);
    record.timer.unref?.();
    record.done = this.run(record, request, firstState);

    let wait: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        changed.promise,
        new Promise<void>((resolve) => {
          wait = setTimeout(resolve, this.firstStateWaitMs);
          wait.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(wait);
    }
    return this.snapshot(record);
  }

  get(id: string): OAuthLoginState {
    return this.snapshot(this.record(id));
  }

  /** Hands the user's answer to the prompt that is waiting for it. */
  submit(id: string, text: string): OAuthLoginState {
    const record = this.record(id);
    const pending = record.prompt;
    if (!pending || TERMINAL.has(record.state.status))
      throw new RuntimeError("invalid_request", "This sign-in is not waiting for an answer", 409);
    record.prompt = null;
    record.state = { ...record.state, prompt: null, status: "pending" };
    pending.resolve(text);
    return this.snapshot(record);
  }

  /** Stops a sign-in. Safe on a finished one (its final state is returned). */
  async cancel(id: string): Promise<OAuthLoginState> {
    const record = this.record(id);
    this.stopRecord(record, "cancelled");
    await this.settled(record);
    return this.snapshot(record);
  }

  /** Cancels every sign-in and waits for their runners to let go of ports and timers. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const records = [...this.records.values()];
    for (const record of records) this.stopRecord(record, "shutdown");
    await Promise.allSettled(records.map((record) => this.settled(record)));
    for (const record of records) this.forget(record);
  }

  private record(id: string): LoginRecord {
    const record = this.records.get(id);
    if (!record)
      throw new RuntimeError(
        "login_not_found",
        "This sign-in was not found (it may have expired)",
        404,
      );
    return record;
  }

  private snapshot(record: LoginRecord): OAuthLoginState {
    return structuredClone(record.state);
  }

  private activeFor(provider: string): LoginRecord | undefined {
    for (const record of this.records.values()) {
      if (record.state.provider === provider && !TERMINAL.has(record.state.status)) return record;
    }
    return undefined;
  }

  private activeCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (!TERMINAL.has(record.state.status)) count += 1;
    return count;
  }

  private update(record: LoginRecord, patch: Partial<OAuthLoginState>): void {
    if (TERMINAL.has(record.state.status)) return;
    record.state = { ...record.state, ...patch };
  }

  private stopRecord(record: LoginRecord, reason: StopReason): void {
    if (TERMINAL.has(record.state.status) || record.stop) return;
    record.stop = reason;
    // The state is final at once; the runner's own wind-down (closing a callback server) follows its abort.
    record.state = {
      ...record.state,
      status: reason === "expired" ? "expired" : "cancelled",
      prompt: null,
    };
    record.prompt?.reject(new Error("The sign-in ended."));
    record.prompt = null;
    record.controller.abort(reason);
  }

  private async run(record: LoginRecord, request: StartLogin, notify: () => void): Promise<void> {
    const controller: LoginController = {
      signal: record.controller.signal,
      onAuth: (info) => {
        // The provider's own wording (a short code, a hint): kept as is, one line.
        const instructions = info.instructions
          ? info.instructions.replace(/\s+/g, " ").trim().slice(0, 400)
          : null;
        this.update(record, {
          authUrl: info.url,
          instructions,
          deviceCode: request.flow === "device" ? extractDeviceCode(instructions) : null,
        });
        notify();
      },
      onProgress: (message) => {
        this.update(record, { progress: sanitizeLoginMessage(message) });
      },
      onPrompt: (prompt) => {
        if (TERMINAL.has(record.state.status) || record.stop)
          return Promise.reject(new Error("The sign-in ended."));
        return new Promise<string>((resolve, reject) => {
          const optional = record.state.authUrl !== null;
          record.prompt = { resolve, reject };
          this.update(record, {
            status: optional ? "pending" : "needs_input",
            prompt: {
              message: sanitizeLoginMessage(prompt.message),
              placeholder: prompt.placeholder ?? null,
              secret: prompt.secret === true,
              optional,
            },
          });
          notify();
        });
      },
    };
    try {
      await this.options.run(request.loginId, controller);
      if (record.stop === null && !TERMINAL.has(record.state.status)) {
        record.state = { ...record.state, status: "succeeded", prompt: null, error: null };
        await this.options.onSucceeded?.(request.provider).catch(() => undefined);
      }
    } catch (error) {
      if (record.stop === null && !TERMINAL.has(record.state.status)) {
        record.state = {
          ...record.state,
          status: "failed",
          prompt: null,
          error: failureMessage(error),
        };
      }
    } finally {
      record.prompt?.reject(new Error("The sign-in ended."));
      record.prompt = null;
      if (record.timer) clearTimeout(record.timer);
      record.timer = null;
      notify();
      if (!this.disposed) {
        record.retention = setTimeout(() => this.forget(record), this.retainMs);
        record.retention.unref?.();
      }
    }
  }

  private forget(record: LoginRecord): void {
    if (record.timer) clearTimeout(record.timer);
    if (record.retention) clearTimeout(record.retention);
    this.records.delete(record.state.id);
  }
}
