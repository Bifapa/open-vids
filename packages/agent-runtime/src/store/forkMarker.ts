import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent, TurnCheckpoint, TurnSummary } from "@hyperframes/agent-protocol";
import { foldChatEvents } from "@hyperframes/agent-protocol";

/**
 * When the project was copied (Fork or Duplicate), from `<project>/.hyperframes/agent/fork.json`
 * (`{ "forkedAt": <epoch ms> }`, written by the desktop shell); null for a project that was not, or whose marker
 * cannot be read. The copy keeps the chats, but the history entries behind their turns' checkpoints stay in the
 * original's history: the copy has a history of its own, which starts empty.
 */
export function readForkedAt(projectDir: string): number | null {
  try {
    const marker: unknown = JSON.parse(
      readFileSync(join(projectDir, ".hyperframes", "agent", "fork.json"), "utf8"),
    );
    if (typeof marker !== "object" || marker === null || !("forkedAt" in marker)) return null;
    const { forkedAt } = marker;
    return typeof forkedAt === "number" && Number.isFinite(forkedAt) ? forkedAt : null;
  } catch {
    return null;
  }
}

/**
 * What stays of a checkpoint whose entries are not in this project's history: a revert that already happened is
 * still a fact ("Reverted"), but it can no longer be undone; anything else has nothing to revert.
 */
function retiredCheckpoint(checkpoint: TurnCheckpoint | null): TurnCheckpoint | null {
  if (checkpoint?.status !== "reverted") return null;
  return {
    status: "reverted",
    entryIds: [],
    createdAt: checkpoint.createdAt,
    ...(checkpoint.closedAt !== undefined && { closedAt: checkpoint.closedAt }),
    ...(checkpoint.revertedAt !== undefined && { revertedAt: checkpoint.revertedAt }),
    ...(checkpoint.files && { files: checkpoint.files }),
    ...(checkpoint.keptFiles && { keptFiles: checkpoint.keptFiles }),
  };
}

/**
 * The chat's events as a project copied at `forkedAt` shows them: the turns that started before it lose their
 * checkpoints (see {@link retiredCheckpoint}), so the chat offers no "Revert this turn" for work the copy's history
 * does not hold. Turns started later are untouched. The stored log is not changed; this runs whenever it is read.
 */
export function retireCheckpointsBefore(events: ChatEvent[], forkedAt: number): ChatEvent[] {
  const state = foldChatEvents(events);
  if (!state) return events;
  const retired = new Map<string, TurnCheckpoint | null>();
  for (const turn of state.turns) {
    if (turn.startedAt < forkedAt) retired.set(turn.id, retiredCheckpoint(turn.checkpoint));
  }
  if (retired.size === 0) return events;
  const withRetired = (turn: TurnSummary): TurnSummary => {
    const checkpoint = retired.get(turn.id);
    return checkpoint === undefined ? turn : { ...turn, checkpoint };
  };
  const result: ChatEvent[] = [];
  for (const event of events) {
    switch (event.type) {
      case "turn.started":
      case "turn.completed":
      case "turn.failed":
      case "turn.aborted":
        result.push({ ...event, turn: withRetired(event.turn) });
        break;
      case "checkpoint.updated": {
        const checkpoint = retired.get(event.turnId);
        if (checkpoint === undefined) result.push(event);
        else if (checkpoint !== null) result.push({ ...event, checkpoint });
        break;
      }
      default:
        result.push(event);
    }
  }
  return result;
}
