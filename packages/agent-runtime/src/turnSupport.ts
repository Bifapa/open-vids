import type { TurnSummary } from "@hyperframes/agent-protocol";
import type { ProjectScope } from "./checkpointHost.js";
import type { AnalysisHost } from "./analysis/host.js";
import type { EditingHost } from "./editing/host.js";
import type { StreamTimerApi } from "./turnStream.js";

export interface TurnRunnerOptions {
  now?: () => number;
  ids?: () => string;
  sessionIdleMs?: number;
  timers?: StreamTimerApi;
  /** How often a running turn renews its project transaction (default 20 s; must stay well under the host's lease). */
  renewIntervalMs?: number;
  /** How long aborted delegated runs may take to stop before their sessions are force-closed (default 10 s). */
  stopGraceMs?: number;
  /**
   * Opens the editing host of a project. Without it the agents get no editing tools (inspect/edit/render); the
   * production runtime always provides it.
   */
  editing?: (scope: ProjectScope) => EditingHost;
  /**
   * Opens the analysis host (long-form transcription, speakers, shots, take issues, cut plans) of a project. Without
   * it the agents get no analysis tools; the production runtime always provides it.
   */
  analysis?: (scope: ProjectScope) => AnalysisHost;
  /** How often a running analysis job is polled (default 750 ms). */
  analysisPollMs?: number;
}

/** The history label of a turn's transaction; recovery rebuilds it from the persisted prompt, so it must be pure. */
export function checkpointLabel(prompt: string): string {
  return `Director: ${prompt.slice(0, 60)}`;
}

export function cloneTurn(turn: TurnSummary): TurnSummary {
  return {
    ...turn,
    model: turn.model ? { ...turn.model } : null,
    checkpoint: turn.checkpoint
      ? { ...turn.checkpoint, entryIds: [...turn.checkpoint.entryIds] }
      : null,
    ...(turn.error && { error: { ...turn.error } }),
  };
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}
