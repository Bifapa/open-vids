import {
  isAgentRunTerminal,
  type RevertMode,
  type RevertTurnResponse,
  type TurnCheckpoint,
  type TurnSummary,
} from "@hyperframes/agent-protocol";
import type { RevertOutcome } from "../checkpointHost.js";
import { RuntimeError, errorMessage } from "../errors.js";
import { checkpointLabel as labelFor, sameIds } from "../turnSupport.js";
import { busyError, type ChatTurnTarget, type TurnContext } from "./context.js";

/** The turn a revert (or undo of one) targets; refused while any turn or revert of the project runs. */
function revertTarget(ctx: TurnContext, chatId: string, turnId: string): ChatTurnTarget {
  const busy = busyError(ctx, chatId);
  if (busy) throw busy;
  const state = ctx.chats.get(chatId);
  if (!state) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
  const turn = state.turns.find((entry) => entry.id === turnId);
  if (!turn) throw new RuntimeError("turn_not_found", "Turn was not found", 404);
  if (state.chat.status === "working")
    throw new RuntimeError("chat_busy", "This chat has a running turn", 409);
  return { turn, checkpoint: turn.checkpoint };
}

async function whileReverting<T>(
  ctx: TurnContext,
  chatId: string,
  work: () => Promise<T>,
): Promise<T> {
  ctx.revertingChatId = chatId;
  try {
    return await work();
  } finally {
    ctx.revertingChatId = null;
  }
}

function undoFailure(message: string): RuntimeError {
  return new RuntimeError("runtime_unavailable", message, 503);
}

async function undoEntries(
  ctx: TurnContext,
  entryIds: readonly string[],
  mode: RevertMode | undefined,
  failure: string,
): Promise<RevertOutcome> {
  try {
    return await ctx.checkpoints.revert(ctx.chats.scope, entryIds, mode);
  } catch (error) {
    throw undoFailure(errorMessage(error, failure));
  }
}

async function emitCheckpoint(
  ctx: TurnContext,
  chatId: string,
  turnId: string,
  checkpoint: TurnCheckpoint,
): Promise<void> {
  await ctx.chats.emit(chatId, { type: "checkpoint.updated", turnId, checkpoint });
}

/** The files a closed checkpoint's entries changed; nothing when Studio cannot say (the footer then omits them). */
export async function checkpointFiles(
  ctx: TurnContext,
  entryIds: readonly string[],
): Promise<{ files?: string[] }> {
  try {
    return { files: await ctx.checkpoints.files(ctx.chats.scope, entryIds) };
  } catch {
    return {};
  }
}

/**
 * Reverts a finished turn's checkpoint. Without a mode, files changed after the turn stop it with a conflict (the
 * user then chooses `keep-later-edits` or `just-this`).
 */
export async function revertTurn(
  ctx: TurnContext,
  chatId: string,
  turnId: string,
  mode?: RevertMode,
): Promise<RevertTurnResponse> {
  const { turn, checkpoint } = revertTarget(ctx, chatId, turnId);
  if (checkpoint?.status !== "ready" || checkpoint.entryIds.length === 0) {
    throw new RuntimeError("revert_unavailable", "This turn has no reversible checkpoint", 409);
  }
  return whileReverting(ctx, chatId, async () => {
    const outcome = await undoEntries(ctx, checkpoint.entryIds, mode, "Could not revert this turn");
    const undoEntryIds = [...(checkpoint.revertEntryIds ?? []), ...(outcome.undoEntryIds ?? [])];
    if (!outcome.ok) {
      const remaining = outcome.remainingEntryIds;
      if (remaining && !sameIds(checkpoint.entryIds, remaining)) {
        // The newer entries were reverted before the conflict: only the older ones remain to revert.
        await emitCheckpoint(ctx, chatId, turnId, {
          ...checkpoint,
          entryIds: remaining,
          revertedEntryIds: [
            ...checkpoint.entryIds.slice(remaining.length),
            ...(checkpoint.revertedEntryIds ?? []),
          ],
          revertEntryIds: undoEntryIds,
        });
      }
      if ("failure" in outcome) throw undoFailure(outcome.failure);
      return { ok: false, conflict: outcome.conflict };
    }
    // Revert untouched files leaves the files that changed later as they are: the turn's files no undo touched.
    let keptFiles: string[] = [];
    if (mode === "keep-later-edits" && checkpoint.files) {
      const undone = await ctx.checkpoints
        .files(ctx.chats.scope, undoEntryIds)
        .catch((): string[] | null => null);
      if (undone) keptFiles = checkpoint.files.filter((file) => !undone.includes(file));
    }
    const updated: TurnCheckpoint = {
      ...checkpoint,
      status: "reverted",
      revertedAt: ctx.now(),
      revertedEntryIds: [...checkpoint.entryIds, ...(checkpoint.revertedEntryIds ?? [])],
      revertEntryIds: undoEntryIds,
      ...(keptFiles.length > 0 && { keptFiles }),
    };
    await emitCheckpoint(ctx, chatId, turnId, updated);
    return { ok: true, turn: { ...turn, checkpoint: updated } };
  });
}

/** Undo revert: undoes the entries the revert wrote, so the turn's changes are back and revertable again. */
export async function unrevertTurn(
  ctx: TurnContext,
  chatId: string,
  turnId: string,
  mode?: RevertMode,
): Promise<RevertTurnResponse> {
  const { turn, checkpoint } = revertTarget(ctx, chatId, turnId);
  const undoEntryIds = checkpoint?.revertEntryIds ?? [];
  if (checkpoint?.status !== "reverted" || undoEntryIds.length === 0) {
    throw new RuntimeError("revert_unavailable", "This revert cannot be undone", 409);
  }
  return whileReverting(ctx, chatId, async () => {
    const outcome = await undoEntries(ctx, undoEntryIds, mode, "Could not undo the revert");
    if (!outcome.ok) {
      const remaining = outcome.remainingEntryIds;
      if (remaining && !sameIds(undoEntryIds, remaining)) {
        await emitCheckpoint(ctx, chatId, turnId, { ...checkpoint, revertEntryIds: remaining });
      }
      if ("failure" in outcome) throw undoFailure(outcome.failure);
      return { ok: false, conflict: outcome.conflict };
    }
    const restored: TurnCheckpoint = {
      status: "ready",
      entryIds: checkpoint.revertedEntryIds ?? checkpoint.entryIds,
      createdAt: checkpoint.createdAt,
      ...(checkpoint.closedAt !== undefined && { closedAt: checkpoint.closedAt }),
      ...(checkpoint.files && { files: checkpoint.files }),
    };
    await emitCheckpoint(ctx, chatId, turnId, restored);
    return { ok: true, turn: { ...turn, checkpoint: restored } };
  });
}

/**
 * Closes every transaction a previous run could not: turns still "running" in the log (the runtime died mid-turn)
 * become "interrupted", and checkpoints still "active" (a turn ended while Studio was unreachable) are closed and
 * given their entries. Delegated runs left open by a dead runtime are closed as "interrupted" first, so no run
 * outlives its turn. Runs on project load and before each new turn.
 *
 * A turn is only written off once Studio's history answers for it. Another runtime (a second Studio server on the
 * same project) may still be running that turn: its history is then busy and the lookup fails, so the turn and its
 * delegated runs stay as they are until a later attempt can tell a dead turn from a live one.
 */
export async function recoverCheckpoints(ctx: TurnContext, chatId?: string): Promise<void> {
  // Reading a chat's log loads it: only chats that can have something to recover are opened — those whose stored
  // summary says a turn is running or a checkpoint unclosed, a turn this process could not close, and the chat
  // about to start a turn.
  const recoverable = new Set(ctx.chats.recoverableChatIds());
  const candidates = ctx.chats
    .list()
    .filter(
      (chat) =>
        recoverable.has(chat.id) ||
        chat.status === "working" ||
        chat.id === chatId ||
        ctx.recoverChats.has(chat.id),
    );
  for (const chat of candidates) {
    const state = ctx.chats.get(chat.id);
    if (!state) continue;
    const recovered = new Map<
      string,
      { entryIds: string[]; createdAt: number; crashed: boolean }
    >();
    const deferred = new Set<string>();
    for (const previous of state.turns) {
      if (ctx.active?.turn.id === previous.id) continue;
      const crashed = previous.status === "running";
      if (!crashed && previous.checkpoint?.status !== "active") continue;
      const promptMessage = state.messages.find(
        (message) => message.role === "user" && message.turnId === previous.id && !message.steering,
      );
      const prompt = promptMessage?.parts.find((part) => part.type === "text")?.text ?? "";
      const createdAt = previous.checkpoint?.createdAt ?? previous.startedAt;
      try {
        const entryIds = await ctx.checkpoints.recover(ctx.chats.scope, {
          label: labelFor(prompt),
          startedAt: createdAt,
          ...(previous.checkpoint?.transactionId && {
            transactionId: previous.checkpoint.transactionId,
          }),
        });
        recovered.set(previous.id, { entryIds, createdAt, crashed });
      } catch {
        // Studio is unreachable or busy: leave the turn pending for the next attempt rather than record "no
        // changes" for work that may be running right now.
        deferred.add(previous.id);
      }
    }

    const orphans = ctx.chats
      .get(chat.id)
      ?.runs.filter(
        (run) =>
          !isAgentRunTerminal(run.status) &&
          run.turnId !== ctx.active?.turn.id &&
          !deferred.has(run.turnId),
      );
    for (const orphan of orphans ?? []) {
      await ctx.chats.emit(chat.id, {
        type: "agent.completed",
        run: { ...orphan, status: "interrupted", endedAt: ctx.now() },
      });
    }
    for (const previous of state.turns) {
      const found = recovered.get(previous.id);
      if (!found) continue;
      const checkpoint: TurnCheckpoint = {
        status: "ready",
        entryIds: found.entryIds,
        ...(await checkpointFiles(ctx, found.entryIds)),
        createdAt: found.createdAt,
        closedAt: ctx.now(),
      };
      await ctx.chats.emit(chat.id, {
        type: "checkpoint.updated",
        turnId: previous.id,
        checkpoint,
      });
      if (!found.crashed) continue;
      const turn: TurnSummary = {
        ...previous,
        status: "interrupted",
        endedAt: ctx.now(),
        checkpoint,
      };
      await ctx.chats.markStatus(chat.id, "interrupted");
      await ctx.chats.emit(chat.id, { type: "turn.aborted", turn });
    }
    if (deferred.size === 0) ctx.recoverChats.delete(chat.id);
  }
}
