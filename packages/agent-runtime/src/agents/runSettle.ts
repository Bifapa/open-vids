import type { AgentRunStatus, AssistantMessageStatus } from "@hyperframes/agent-protocol";
import { RuntimeError, errorMessage } from "../errors.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { summarizeReport, type RunRecord } from "./runRecord.js";

/** A run's replies: all its text, and the last segment (the report; earlier ones narrate between tool calls). */
function replyText(
  deps: OrchestratorDeps,
  messageId: string,
): { all: string | null; last: string | null } {
  const message = deps.chats
    .get(deps.chatId)
    ?.messages.find((candidate) => candidate.id === messageId);
  if (!message || message.role !== "assistant") return { all: null, last: null };
  const texts = message.parts.flatMap((part) =>
    part.type === "text" && part.text.trim() ? [part.text.trim()] : [],
  );
  return { all: texts.join("\n\n") || null, last: texts.at(-1) ?? null };
}

/**
 * Records how a run ended and tells the chat. A run the watchdog stopped failed (with its reason); one the user or the
 * Director stopped on purpose is cancelled, not aborted. Returns false when the run had already ended.
 */
export async function settleRun(
  deps: OrchestratorDeps,
  record: RunRecord,
  requested: AgentRunStatus,
  requestedError: unknown,
): Promise<boolean> {
  if (record.finished) return false;
  record.finished = true;
  record.watchdog?.stop();
  const { run } = record;
  let status = requested;
  let error = requestedError;
  if (status === "aborted" && record.stalled) {
    status = "failed";
    error = new Error(record.stalled);
  } else if (status === "aborted" && record.cancelled) {
    status = "cancelled";
  }
  deps.leases.release(run.id);
  const reply = replyText(deps, run.assistantMessageId);
  record.report = reply.all;
  run.status = status;
  run.endedAt = deps.now();
  run.summary = summarizeReport(reply.last);
  if (status === "failed") {
    run.error = {
      code: error instanceof RuntimeError ? error.code : "agent_failed",
      message: errorMessage(error, "The agent failed"),
    };
  }
  const messageStatus: AssistantMessageStatus =
    status === "completed" ? "complete" : status === "failed" ? "failed" : "aborted";
  try {
    await deps.chats.emit(deps.chatId, {
      type: "message.completed",
      messageId: run.assistantMessageId,
      status: messageStatus,
    });
    await deps.chats.emit(deps.chatId, { type: "agent.completed", run: { ...run } });
  } catch {
    // Persistence failed (disk gone); the in-memory record is still final and the turn will close.
  }
  return true;
}
