import type { RevertMode } from "@hyperframes/agent-protocol";

/** Identifies the project a request is scoped to; set by the gateway, never by the browser. */
export interface ProjectScope {
  projectId: string;
  /** Absolute, existing project directory. */
  projectDir: string;
  /** Origin of the Studio server (e.g. http://127.0.0.1:4173), for host callbacks. */
  studioOrigin: string;
}

/**
 * One open project transaction. It lives for the whole turn: it does not end on its own while its owner keeps
 * renewing it, however long the pauses between project writes, and ends only through {@link end}.
 */
export interface CheckpointHandle {
  /** History engine's exact window start time, used to recover this group after a runtime crash. */
  startedAt: number;
  /** The engine's id for the open transaction; persisted so a restarted runtime can close it. */
  transactionId: string;
  /**
   * Heartbeat: keeps the transaction open. Resolves false once it has ended on the host side (its later writes would
   * no longer belong to the turn); rejects on a transport failure, which the caller may retry.
   */
  renew(): Promise<boolean>;
  /**
   * Closes the transaction. Returns the project-history entry ids the turn
   * produced, oldest first; empty when nothing changed.
   */
  end(): Promise<string[]>;
}

export type RevertOutcome =
  | { ok: true }
  | { ok: false; conflict: { files: string[] }; remainingEntryIds?: string[] };

/**
 * The project's transaction/history engine as seen from the runtime. The
 * production implementation drives Studio's project-history routes, so a turn
 * is one history entry group attributed to the Director and revertable with the
 * same engine that powers Undo. Tests use an in-memory fake.
 */
export interface CheckpointHost {
  /** Opens the transaction before any project-changing work. Rejects if no checkpoint can be taken. */
  begin(scope: ProjectScope, label: string): Promise<CheckpointHandle>;
  /** Reverts entries newest-first. */
  revert(
    scope: ProjectScope,
    entryIds: readonly string[],
    mode: RevertMode,
  ): Promise<RevertOutcome>;
  /**
   * After a runtime restart or a failed close: closes the transaction if it is still open, then returns the entry ids
   * it left behind, identified by the label/startedAt the runtime persisted. Empty when none can be found.
   */
  recover(
    scope: ProjectScope,
    checkpoint: { label: string; startedAt: number; transactionId?: string },
  ): Promise<string[]>;
}
