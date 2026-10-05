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
  | {
      ok: true;
      /** The history entries the revert wrote (one undo per reverted entry), oldest first. */
      undoEntryIds?: string[];
    }
  | {
      ok: false;
      conflict: { files: string[] };
      remainingEntryIds?: string[];
      /** Undo entries already written for the newer entries before the conflict stopped the revert. */
      undoEntryIds?: string[];
    }
  | {
      ok: false;
      /** An undo request failed (transport, or Studio refused one entry) after newer entries were already undone. */
      failure: string;
      remainingEntryIds: string[];
      /** Undo entries written for the newer entries before the failure. */
      undoEntryIds: string[];
    };

/**
 * The project's transaction/history engine as seen from the runtime. The
 * production implementation drives Studio's project-history routes, so a turn
 * is one history entry group attributed to the Director and revertable with the
 * same engine that powers Undo. Tests use an in-memory fake.
 */
export interface CheckpointHost {
  /** Opens the transaction before any project-changing work. Rejects if no checkpoint can be taken. */
  begin(scope: ProjectScope, label: string): Promise<CheckpointHandle>;
  /**
   * Undoes entries newest-first. Without a mode, an entry whose files changed afterwards stops the revert with a
   * conflict; with one, the engine resolves it (`keep-later-edits` skips those files, `just-this` overwrites them).
   */
  revert(
    scope: ProjectScope,
    entryIds: readonly string[],
    mode: RevertMode | undefined,
  ): Promise<RevertOutcome>;
  /** The project-relative files the given entries changed, sorted and unique. */
  files(scope: ProjectScope, entryIds: readonly string[]): Promise<string[]>;
  /**
   * After a runtime restart or a failed close: closes the transaction if it is still open, then returns the entry ids
   * it left behind, identified by the label/startedAt the runtime persisted. Empty when none can be found.
   */
  recover(
    scope: ProjectScope,
    checkpoint: { label: string; startedAt: number; transactionId?: string },
  ): Promise<string[]>;
}
