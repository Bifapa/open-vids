import {
  isAgentRunTerminal,
  type AssistantMessageStatus,
  type ChatSummary,
  type TurnCheckpoint,
  type TurnSummary,
} from "@hyperframes/agent-protocol";
import { errorMessage, failureCode } from "../errors.js";
import type { ActiveRun, TurnContext } from "./context.js";

import { checkpointFiles } from "./reverts.js";

async function bestEffort(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {}
}

const TITLE_LIST = 4;

/** The titles of the delegated runs still open, as one clause ("A", "B" and 2 more). */
function listRuns(titles: readonly string[]): string {
  const shown = titles.slice(0, TITLE_LIST).map((title) => `"${title}"`);
  const rest = titles.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** What a completed turn tells the user when it ended with delegated work still open (the runs are stopped). */
function droppedRunsNote(titles: readonly string[]): string {
  const many =
    titles.length === 1 ? "a delegated task was" : `${titles.length} delegated tasks were`;
  return `\n\nNote: ${many} still working when this turn finished and ${titles.length === 1 ? "was" : "were"} stopped: ${listRuns(titles)}. ${titles.length === 1 ? "Its" : "Their"} results are not part of this reply — ask again to continue.`;
}

/**
 * Ends the turn in a fixed order, so no write can escape Revert: pending permission requests and questions expire,
 * every delegated run is over, QA, research, story, analysis and editing calls end, and only then the checkpoint's
 * transaction closes and the turn's final state is published.
 */
export async function finalizeTurn(
  ctx: TurnContext,
  run: ActiveRun,
  status: TurnSummary["status"],
  error?: unknown,
): Promise<void> {
  if (run.finalizing) return;
  run.finalizing = true;
  run.watchdog?.disarm();
  // A call waiting on the user's answer must return before anything awaits the run: the pending requests become
  // expired (their parts update) and the turn's one-time grant is revoked.
  await run.permissions?.expireAll().catch(() => undefined);
  await run.questions?.expireAll().catch(() => undefined);
  await run.permissions?.revokeGrant().catch(() => undefined);
  // Delegated work still open when a turn completes is stopped by the shutdown below: say so.
  const dropped =
    status === "completed"
      ? (ctx.chats.get(run.chatId)?.runs ?? [])
          .filter((entry) => entry.turnId === run.turn.id && !isAgentRunTerminal(entry.status))
          .map((entry) => entry.title)
      : [];
  if (dropped.length > 0) {
    await bestEffort(() =>
      ctx.chats.emit(run.chatId, {
        type: "assistant.text.delta",
        messageId: run.assistantMessage.id,
        partId: ctx.ids(),
        delta: droppedRunsNote(dropped),
      }),
    );
  }
  // Every delegated run must be over before the checkpoint closes, or its later writes would escape Revert.
  await run.orchestrator?.shutdown(status === "completed").catch(() => undefined);
  // Render QA's checks, frame extractions and report writes end here too (the QA loop itself has already returned).
  await run.qa?.shutdown().catch(() => undefined);
  // Editing calls still running (or a render) end here too: no editing write may land after the checkpoint closes.
  // Analysis jobs are cancelled and a rough cut already sent to the editing service is awaited for the same reason;
  // a story edit or build already sent to the story service is awaited too (it is atomic there).
  const research = await run.research?.shutdown().catch(() => null);
  const crossProject = await run.crossProject?.shutdown().catch(() => null);
  await run.story?.shutdown().catch(() => undefined);
  await run.analysis?.shutdown().catch(() => undefined);
  await run.frames?.shutdown().catch(() => undefined);
  await run.editing?.shutdown().catch(() => undefined);
  ctx.leases.clear();
  if (run.heartbeat) ctx.timers.clearTimeout(run.heartbeat);
  const createdAt = run.turn.checkpoint?.createdAt ?? run.turn.startedAt;
  const closedAt = ctx.now();
  let checkpoint: TurnCheckpoint = { status: "ready", entryIds: [], createdAt, closedAt };
  if (run.checkpoint) {
    try {
      const entryIds = await run.checkpoint.end();
      checkpoint = { ...checkpoint, entryIds, ...(await checkpointFiles(ctx, entryIds)) };
    } catch {
      // Studio could not be reached (shutting down, restarting). The transaction is not lost: it stays "active"
      // with its id, and recoverCheckpoints() closes it and collects its entries on the next turn or project load.
      checkpoint = {
        status: "active",
        entryIds: [],
        createdAt,
        transactionId: run.checkpoint.transactionId,
      };
      ctx.recoverChats.add(run.chatId);
    }
  }
  run.turn.checkpoint = checkpoint;
  run.turn.status = status;
  run.turn.endedAt = closedAt;
  const changes = run.changes.list();
  if (changes.length > 0) run.turn.changes = changes;
  if (status === "failed") {
    run.turn.error = {
      code: failureCode(error),
      message: errorMessage(error, "The agent failed to complete this turn"),
    };
  }
  // A cancelled import Studio never settled may still write after this checkpoint closed: the user must hear it.
  const unsettled = [
    ...(research?.unsettledWrites ?? []),
    ...(crossProject?.unsettledWrites ?? []),
  ];
  if (unsettled.length > 0) {
    await bestEffort(() =>
      ctx.chats.emit(run.chatId, {
        type: "assistant.text.delta",
        messageId: run.assistantMessage.id,
        partId: ctx.ids(),
        delta: `\n\nNote: Studio did not confirm whether ${unsettled.length === 1 ? "an asset import, website save or project copy" : `${unsettled.length} asset imports, website saves or project copies`} stopped with this turn wrote anything (${unsettled.join(", ")}). A file that still appears in assets/research, assets/web or assets/from is not part of this turn's checkpoint; check the Sources panel.`,
      }),
    );
  }
  const assistantStatus: AssistantMessageStatus =
    status === "completed" ? "complete" : status === "failed" ? "failed" : "aborted";
  await bestEffort(() =>
    ctx.chats.emit(run.chatId, {
      type: "message.completed",
      messageId: run.assistantMessage.id,
      status: assistantStatus,
    }),
  );
  await bestEffort(() =>
    ctx.chats.emit(run.chatId, {
      type: "checkpoint.updated",
      turnId: run.turn.id,
      checkpoint,
    }),
  );
  const chatStatus: ChatSummary["status"] =
    status === "completed"
      ? "completed"
      : status === "failed"
        ? "failed"
        : status === "interrupted"
          ? "interrupted"
          : "idle";
  await bestEffort(() => ctx.chats.markStatus(run.chatId, chatStatus).then(() => undefined));
  if (status === "failed") {
    await bestEffort(() =>
      ctx.chats.emit(run.chatId, {
        type: "turn.failed",
        turn: run.turn,
        error: run.turn.error ?? {
          code: "agent_failed",
          message: "The agent failed to complete this turn",
        },
      }),
    );
  } else if (status === "completed") {
    await bestEffort(() => ctx.chats.emit(run.chatId, { type: "turn.completed", turn: run.turn }));
  } else {
    await bestEffort(() => ctx.chats.emit(run.chatId, { type: "turn.aborted", turn: run.turn }));
  }
  ctx.sessions.scheduleDisposal(run.chatId);
  if (ctx.active === run) {
    ctx.chats.publishProject({ type: "project.activeTurn", activeTurn: null });
    ctx.active = null;
  }
}
