import type { AgentId } from "@hyperframes/agent-protocol";
import type { AgentBackend, BackendSession, OpenBackendSessionInput } from "./backend.js";
import type { StreamTimerApi, StreamTimerHandle } from "./turnStream.js";

interface SessionRecord {
  chatId: string;
  session: BackendSession;
  /** What the session was opened with (instructions + tool schemas); a different one needs a new session. */
  signature: string;
  timer: StreamTimerHandle | null;
}

export interface SessionRequest {
  chatId: string;
  agent: AgentId;
  signature: string;
  open: () => Promise<OpenBackendSessionInput>;
}

/**
 * Reuses one resumable backend session per chat and agent (the Director and each specialist keep their own
 * conversation) and disposes idle ones after a window.
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly opening = new Map<string, Promise<BackendSession>>();

  constructor(
    private readonly backend: AgentBackend,
    private readonly idleMs: number,
    private readonly timers: StreamTimerApi,
    private readonly isActive: (chatId: string) => boolean,
  ) {}

  async get(request: SessionRequest): Promise<BackendSession> {
    const key = `${request.chatId}\u0000${request.agent}`;
    const existing = this.sessions.get(key);
    if (existing?.signature === request.signature) {
      if (existing.timer) this.timers.clearTimeout(existing.timer);
      existing.timer = null;
      return existing.session;
    }
    if (existing) {
      this.sessions.delete(key);
      if (existing.timer) this.timers.clearTimeout(existing.timer);
      await existing.session.dispose().catch(() => undefined);
    }
    const opening = this.opening.get(key);
    if (opening) return opening;
    const promise = (async () => {
      const session = await this.backend.openSession(await request.open());
      this.sessions.set(key, {
        chatId: request.chatId,
        session,
        signature: request.signature,
        timer: null,
      });
      return session;
    })();
    this.opening.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.opening.get(key) === promise) this.opening.delete(key);
    }
  }

  /** Starts the idle countdown of every session of a chat once its turn has ended. */
  scheduleDisposal(chatId: string): void {
    for (const [key, record] of this.sessions) {
      if (record.chatId !== chatId) continue;
      if (record.timer) this.timers.clearTimeout(record.timer);
      record.timer = this.timers.setTimeout(() => {
        if (this.isActive(chatId)) return;
        if (this.sessions.get(key) === record) this.sessions.delete(key);
        void record.session.dispose().catch(() => undefined);
      }, this.idleMs);
    }
  }

  /** Force-closes one agent's session (used when an aborted run does not stop on its own). */
  async disposeAgent(chatId: string, agent: AgentId): Promise<void> {
    const key = `${chatId}\u0000${agent}`;
    const record = this.sessions.get(key);
    if (!record) return;
    this.sessions.delete(key);
    if (record.timer) this.timers.clearTimeout(record.timer);
    await record.session.dispose().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      if (record.timer) this.timers.clearTimeout(record.timer);
      await record.session.dispose().catch(() => undefined);
    }
  }
}
