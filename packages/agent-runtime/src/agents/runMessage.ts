import { AGENT_DISPLAY_NAMES, type TaskMessage } from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { errorMessage } from "../errors.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { done, refuse, type RunRecord } from "./runRecord.js";
import { parseRunArgs } from "./toolArgs.js";

/**
 * `message_agent`: a correction from the Director to a specialist run. A running run is steered; one that has not
 * begun (queued, or still opening its session) sees the correction in front of its task.
 */
export async function messageRun(
  deps: OrchestratorDeps,
  records: ReadonlyMap<string, RunRecord>,
  args: unknown,
): Promise<HostToolResult> {
  const parsed = parseRunArgs(args, true);
  if (!parsed.ok || parsed.value.text === null)
    return refuse(parsed.ok ? "text is required" : parsed.message);
  const record = records.get(parsed.value.runId);
  if (!record || record.run.parentRunId !== null)
    return refuse(`Unknown run ${parsed.value.runId}.`);
  const { run } = record;
  if (record.finished || run.agent === "jev")
    return refuse(`Run ${run.id} is not running (${run.status}); delegate a new task instead.`);
  const text = parsed.value.text;
  const message: TaskMessage = {
    id: deps.ids(),
    chatId: deps.chatId,
    turnId: deps.turn.id,
    createdAt: deps.now(),
    role: "task",
    runId: run.id,
    agent: run.agent,
    from: "director",
    parts: [{ type: "text", id: deps.ids(), text }],
    steering: true,
  };
  if (record.started && record.session) {
    // A run that cannot take the message yet (its prompt is still starting) refuses it; nothing is announced then.
    try {
      await record.session.steer(text);
    } catch (error) {
      return refuse(
        `${AGENT_DISPLAY_NAMES[run.agent]} could not take the message right now (${errorMessage(error, "steering failed")}). Send it again in a moment.`,
      );
    }
    await deps.chats.emit(deps.chatId, { type: "message.appended", message });
    return done(`Sent to ${AGENT_DISPLAY_NAMES[run.agent]}.`);
  }
  await deps.chats.emit(deps.chatId, { type: "message.appended", message });
  record.queuedMessages.push(text);
  return done(
    `Run ${run.id} has not started yet (${run.status}); ${AGENT_DISPLAY_NAMES[run.agent]} will see your message before its task.`,
  );
}
