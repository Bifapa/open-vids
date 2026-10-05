import type { AgentRunStatus } from "@hyperframes/agent-protocol";
import { TurnEventWriter } from "../turnStream.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import type { RunRecord } from "./runRecord.js";
import { DEFAULT_STALL_MS, StallWatchdog } from "./stallWatchdog.js";
import { withQueuedMessages } from "./taskText.js";

/** What a running run needs from the orchestrator that owns it. */
export interface RunHooks {
  deps: OrchestratorDeps;
  finish: (record: RunRecord, status: AgentRunStatus, error: unknown) => Promise<void>;
  syncPlan: () => Promise<void>;
  /** The watchdog fired for this run. */
  stalled: (record: RunRecord) => void;
}

/**
 * Runs one agent's task from its slot to its end: opens the session, prompts it with the task (and the corrections that
 * reached the run while it waited), streams its events into the chat under the watchdog's eye, and settles the run.
 * Ephemeral sessions (Jev's, a specialist's second slot) are disposed when it ends.
 */
export async function executeRun(hooks: RunHooks, record: RunRecord, slot: number): Promise<void> {
  const { deps, finish } = hooks;
  const { run, controller } = record;
  const agent = run.agent;
  let writer: TurnEventWriter | null = null;
  record.slot = slot;
  try {
    if (controller.signal.aborted) {
      await finish(record, "aborted", null);
      return;
    }
    if (run.status === "queued") {
      run.status = "running";
      await deps.chats.emit(deps.chatId, { type: "agent.updated", run: { ...run } });
      await hooks.syncPlan();
    }
    const watchdog = new StallWatchdog(deps.timers, deps.stallMs ?? DEFAULT_STALL_MS, () =>
      hooks.stalled(record),
    );
    record.watchdog = watchdog;
    watchdog.start();
    record.session =
      agent === "jev"
        ? await deps.jevSession(run.id)
        : await deps.specialistSession(agent, slot > 0, run.id);
    writer = new TurnEventWriter({
      chats: deps.chats,
      chatId: deps.chatId,
      messageId: run.assistantMessageId,
      runId: run.id,
      turn: deps.turn,
      now: deps.now,
      ids: deps.ids,
      timers: deps.timers,
      onModel: (event) => {
        run.model = event.model;
        run.thinking = event.thinking;
        void deps.chats
          .emit(deps.chatId, { type: "agent.updated", run: { ...run } })
          .catch(() => undefined);
      },
    });
    const activeWriter = writer;
    record.started = true;
    const outcome = await record.session.prompt({
      text: withQueuedMessages(record.taskText, record.queuedMessages),
      model: run.model,
      thinking: run.thinking,
      signal: controller.signal,
      onEvent: (event) => {
        watchdog.touch();
        activeWriter.accept(event);
      },
    });
    const stopped = outcome === "aborted" || controller.signal.aborted;
    await writer.finish(stopped ? "aborted" : "complete");
    await finish(record, stopped ? "aborted" : "completed", null);
  } catch (error) {
    await writer?.finish("failed").catch(() => undefined);
    if (controller.signal.aborted) await finish(record, "aborted", null);
    else await finish(record, "failed", error);
  } finally {
    record.watchdog?.stop();
    if (agent === "jev" || slot > 0) await record.session?.dispose().catch(() => undefined);
  }
}
