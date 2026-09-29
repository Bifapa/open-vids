import type { AgentBackend, BackendSession } from "./backend.js";
import { FileChatStore } from "./store/index.js";
import type { StreamTimerApi, StreamTimerHandle } from "./turnStream.js";

interface SessionRecord {
  session: BackendSession;
  timer: StreamTimerHandle | null;
}

/** Reuses backend sessions per chat and disposes them after an idle window. */
export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly opening = new Map<string, Promise<BackendSession>>();

  constructor(
    private readonly backend: AgentBackend,
    private readonly store: FileChatStore,
    private readonly projectDir: string,
    private readonly idleMs: number,
    private readonly timers: StreamTimerApi,
    private readonly isActive: (chatId: string) => boolean,
  ) {}

  async get(chatId: string): Promise<BackendSession> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      if (existing.timer) this.timers.clearTimeout(existing.timer);
      existing.timer = null;
      return existing.session;
    }
    const opening = this.opening.get(chatId);
    if (opening) return opening;
    const promise = (async () => {
      const stateDir = await this.store.stateDir(chatId);
      const session = await this.backend.openSession({
        chatId,
        projectDir: this.projectDir,
        stateDir,
      });
      this.sessions.set(chatId, { session, timer: null });
      return session;
    })();
    this.opening.set(chatId, promise);
    try {
      return await promise;
    } finally {
      if (this.opening.get(chatId) === promise) this.opening.delete(chatId);
    }
  }

  scheduleDisposal(chatId: string): void {
    const record = this.sessions.get(chatId);
    if (!record) return;
    if (record.timer) this.timers.clearTimeout(record.timer);
    record.timer = this.timers.setTimeout(() => {
      if (this.isActive(chatId)) return;
      this.sessions.delete(chatId);
      void record.session.dispose().catch(() => undefined);
    }, this.idleMs);
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
