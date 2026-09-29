import type { TurnSummary } from "@hyperframes/agent-protocol";
import type { StreamTimerApi } from "./turnStream.js";

export interface TurnRunnerOptions {
  now?: () => number;
  ids?: () => string;
  sessionIdleMs?: number;
  timers?: StreamTimerApi;
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
