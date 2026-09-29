import type { RevertMode } from "@hyperframes/agent-protocol";

/** Identifies the project a request is scoped to; set by the gateway, never by the browser. */
export interface ProjectScope {
  projectId: string;
  /** Absolute, existing project directory. */
  projectDir: string;
  /** Origin of the Studio server (e.g. http://127.0.0.1:4173), for host callbacks. */
  studioOrigin: string;
}

export interface CheckpointHandle {
  /** History engine's exact window start time, used to recover this group after a runtime crash. */
  startedAt: number;
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
   * After a runtime restart: the entry ids a previous, interrupted transaction
   * left behind, identified by the label/startedAt the runtime persisted. Empty
   * when none can be found.
   */
  recover(scope: ProjectScope, label: string, startedAt: number): Promise<string[]>;
}
