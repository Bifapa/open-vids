import {
  AGENT_DISPLAY_NAMES,
  applyThinkingPolicy,
  isAgentRunTerminal,
  type AgentId,
  type AgentModelCatalog,
  type AgentRun,
  type AgentRunStatus,
  type AssistantMessage,
  type AssistantMessageStatus,
  type EditorContext,
  type ExecutionBudget,
  type ExecutionPlan,
  type ExecutionQualityPreset,
  type ModelSelection,
  type PlanStepStatus,
  type SpecialistConfig,
  type SpecialistId,
  type TaskMessage,
  type ThinkingEffort,
  type TurnSummary,
  type WorkerAgentId,
} from "@hyperframes/agent-protocol";
import type { BackendSession, HostToolResult } from "../backend.js";
import { renderAutonomyBlock, type TurnAutonomy } from "../autonomy.js";
import type { ChatService } from "../chats.js";
import { errorMessage } from "../errors.js";
import { renderPromptContext } from "../promptContext.js";
import { renderResearchBlock, type ResearchTurnState } from "../research/prompt.js";
import { TurnEventWriter, type StreamTimerApi, type StreamTimerHandle } from "../turnStream.js";
import { parseModelArgument, routeDelegation } from "./routing.js";
import {
  TOOL_NAMES,
  parseDelegateArgs,
  parseJevArgs,
  parsePlanArgs,
  parseRunArgs,
  parseWaitArgs,
} from "./tools.js";

/** Jev as a turn may use it: resolved model plus, in API-key mode, its private credentials. */
export interface JevRuntime {
  model: ModelSelection;
  thinking: ThinkingEffort | null;
  credentials?: { provider: string; apiKey: string };
}

/** Everything a turn knows about its team, fixed when the turn starts. */
export interface TurnAgentSetup {
  enabled: SpecialistId[];
  specialists: Record<SpecialistId, SpecialistConfig>;
  jev: JevRuntime | null;
  catalog: AgentModelCatalog;
  editorContext?: EditorContext;
  /** The user's UI language (BCP-47): every specialist task carries the reply-language block. */
  userLanguage?: string;
  /** The user's Asset Search policy as the turn started (see research/prompt.ts); unset without a research host. */
  research?: ResearchTurnState;
  /** The Execution Quality the turn runs with: the preset and the budget it resolved to (fixed for the turn). */
  execution: { preset: ExecutionQualityPreset; budget: ExecutionBudget };
  /** The runtime can run Render QA this turn (it has editing and QA hosts). */
  qaAvailable: boolean;
  /** The user's Autonomy settings as the turn started (see autonomy.ts). */
  autonomy: TurnAutonomy;
}

export interface OrchestratorDeps {
  chats: ChatService;
  chatId: string;
  /** The live turn record; the plan is kept on it so terminal turn events carry it. */
  turn: TurnSummary;
  directorMessageId: string;
  setup: TurnAgentSetup;
  /** The turn's abort signal: aborting the turn aborts every run. */
  signal: AbortSignal;
  now: () => number;
  ids: () => string;
  timers: StreamTimerApi;
  /** The chat's resumable session for a specialist. */
  specialistSession: (agent: SpecialistId) => Promise<BackendSession>;
  /** A fresh, ephemeral Jev session; disposed by the orchestrator after the run. */
  jevSession: () => Promise<BackendSession>;
  /** Force-closes a specialist session that ignored an abort. */
  closeSpecialist: (agent: SpecialistId) => Promise<void>;
  /** How long an aborted run may take to stop before its session is force-closed. */
  stopGraceMs?: number;
}

/** How a run the runtime started itself ended: its status, the failure message and the model it ran on. */
export interface RuntimeRunResult {
  status: AgentRunStatus;
  error: string | null;
  /** `provider/modelId`. */
  model: string | null;
}

interface RunRecord {
  run: AgentRun;
  controller: AbortController;
  session: BackendSession | null;
  done: Promise<void>;
  report: string | null;
  /** The Director has received this run's result (through wait_for_agents or a synchronous Jev call). */
  reported: boolean;
  cancelled: boolean;
  finished: boolean;
}

const REPORT_CHARS = 8_000;
const SUMMARY_CHARS = 280;
const DEFAULT_STOP_GRACE_MS = 10_000;

const done = (text: string): HostToolResult => ({ text });
const refuse = (text: string): HostToolResult => ({ text, isError: true });

/**
 * A one-line outcome for the main chat, from the run's final text segment (the report; earlier segments are
 * narration between tool calls). Markdown markers and label-only lines ("Report:") are dropped.
 */
export function summarizeReport(finalText: string | null): string | null {
  const lines = (finalText ?? "")
    .split("\n")
    .map((line) =>
      line
        .replace(/\*\*|__|`/g, "")
        .replace(/^\s*(?:[#>]+|[-*•]|\d+[.)])\s+/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line && !/^[\p{L}\p{N} ]{1,30}:$/u.test(line));
  const summary = lines.slice(0, 2).join(" ");
  if (!summary) return null;
  return summary.length > SUMMARY_CHARS
    ? `${summary.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`
    : summary;
}

/**
 * Runs the delegated work of one Director turn: specialist runs (async, one at a time per specialist, parallel across
 * specialists) and Jev calls (synchronous for the caller). Every run shares the turn's abort signal and checkpoint;
 * {@link shutdown} guarantees none is still running when the turn closes its checkpoint.
 */
export class Orchestrator {
  private readonly records = new Map<string, RunRecord>();
  private readonly specialistTails = new Map<SpecialistId, Promise<void>>();
  private readonly currentRun = new Map<SpecialistId, RunRecord>();
  private readonly wakers = new Set<() => void>();
  private steerCount = 0;
  private closed = false;
  /** The Director published its own plan; the automatic run-based plan stops. */
  private directorPlanned = false;
  /** The automatic plan's final step once the turn has ended. */
  private assembled: PlanStepStatus | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  /** The model a specialist's current run actually uses (`provider/modelId`), or null when it is not running. */
  modelOf(agent: SpecialistId): string | null {
    const model = this.currentRun.get(agent)?.run.model;
    return model ? `${model.provider}/${model.modelId}` : null;
  }

  /** Dispatches a host tool call made by `caller` (the Director or a specialist). */
  async execute(
    caller: AgentId,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<HostToolResult> {
    if (this.closed) return refuse("This turn has ended; no new work can start.");
    try {
      if (name === TOOL_NAMES.jev) return await this.runJev(caller, args, signal);
      if (caller !== "director") return refuse(`${name} is only available to the Director.`);
      switch (name) {
        case TOOL_NAMES.plan:
          return await this.updatePlan(args);
        case TOOL_NAMES.delegate:
          return await this.delegate(args);
        case TOOL_NAMES.wait:
          return await this.waitForAgents(args, signal);
        case TOOL_NAMES.cancel:
          return this.cancel(args);
        case TOOL_NAMES.message:
          return await this.message(args);
        default:
          return refuse(`Unknown tool ${name}.`);
      }
    } catch (error) {
      return refuse(errorMessage(error, `${name} failed`));
    }
  }

  /** The user steered the Director: a pending wait returns so the Director can react. */
  notifySteer(): void {
    this.steerCount += 1;
    this.wake();
  }

  /** Director-started runs whose results the Director has not received yet. */
  hasUnreported(): boolean {
    return [...this.records.values()].some(
      (record) => record.run.parentRunId === null && !record.reported,
    );
  }

  /**
   * Waits until every Director-started run the Director has not heard back from has finished — or the user steers —
   * and returns their status/reports. Only finished runs count as reported.
   */
  async collectUnreported(signal: AbortSignal): Promise<string> {
    const pending = [...this.records.values()].filter(
      (record) => record.run.parentRunId === null && !record.reported,
    );
    await this.until(() => pending.every((record) => record.finished), signal, true);
    return pending
      .map((record) => {
        if (record.finished) record.reported = true;
        return this.describe(record);
      })
      .join("\n\n");
  }

  /**
   * Runs a specialist task the runtime itself starts (the Vision review of a QA pass) to its end and returns how it
   * ended. It is an ordinary run in the chat — its own thread, model and plan step — but the Director never has to
   * collect it, so it cannot cause a follow-up prompt. The specialist's model and thinking follow the user's
   * configuration and the turn's Execution Quality, like any delegated run.
   */
  async runInternal(input: {
    agent: SpecialistId;
    title: string;
    titleCode?: string;
    titleParams?: Record<string, string | number>;
    task: string;
  }): Promise<RuntimeRunResult> {
    if (this.closed) throw new Error("This turn has ended; no new work can start.");
    const { setup } = this.deps;
    const routing = routeDelegation(input.agent, setup.specialists[input.agent], {}, setup.catalog);
    if (!routing.ok) throw new Error(routing.message);
    const record = await this.startRun({
      agent: input.agent,
      title: input.title,
      titleCode: input.titleCode,
      titleParams: input.titleParams,
      task: input.task,
      from: "director",
      parentRunId: null,
      parentMessageId: this.deps.directorMessageId,
      model: routing.model,
      thinking: applyThinkingPolicy(routing.thinking, setup.execution.budget.specialistThinking),
      routed: false,
      reported: true,
    });
    await record.done;
    const { run } = record;
    return {
      status: run.status,
      error: run.error?.message ?? null,
      model: run.model ? `${run.model.provider}/${run.model.modelId}` : null,
    };
  }

  /**
   * Ends all work of the turn before its checkpoint closes: unfinished runs are aborted, and a run that does not stop
   * within the grace period has its session force-closed and is recorded as aborted. `completed` says whether the
   * turn itself succeeded, which closes the automatic plan's final step.
   */
  async shutdown(completed: boolean): Promise<void> {
    this.closed = true;
    const open = [...this.records.values()].filter((record) => !record.finished);
    if (open.length > 0) await this.stopRuns(open);
    this.assembled = completed ? "done" : "skipped";
    await this.syncAutoPlan().catch(() => undefined);
  }

  private async stopRuns(open: RunRecord[]): Promise<void> {
    for (const record of open) record.controller.abort();
    const grace = this.deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    if (await this.settleWithin(open, grace)) return;
    for (const record of open) {
      if (record.finished) continue;
      if (record.run.agent === "jev") await record.session?.dispose().catch(() => undefined);
      else await this.deps.closeSpecialist(record.run.agent);
    }
    if (await this.settleWithin(open, grace)) return;
    for (const record of open) {
      if (!record.finished) await this.finish(record, "aborted", null);
    }
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  private async updatePlan(args: unknown): Promise<HostToolResult> {
    const parsed = parsePlanArgs(args);
    if (!parsed.ok) return refuse(parsed.message);
    const plan: ExecutionPlan = {
      steps: parsed.value.steps.map((step, index) => ({ id: `step-${index + 1}`, ...step })),
      updatedAt: this.deps.now(),
    };
    this.directorPlanned = true;
    this.deps.turn.plan = plan;
    await this.deps.chats.emit(this.deps.chatId, {
      type: "plan.updated",
      turnId: this.deps.turn.id,
      plan,
    });
    return done("Plan updated.");
  }

  private async delegate(args: unknown): Promise<HostToolResult> {
    const parsed = parseDelegateArgs(args);
    if (!parsed.ok) return refuse(parsed.message);
    const { agent, title, task } = parsed.value;
    const { setup } = this.deps;
    if (!setup.enabled.includes(agent)) {
      const enabled = setup.enabled.map((id) => AGENT_DISPLAY_NAMES[id]).join(", ") || "none";
      return refuse(
        `${AGENT_DISPLAY_NAMES[agent]} is not enabled in this chat, so it cannot be used. Enabled specialists: ${enabled}.`,
      );
    }
    let requestedModel: ModelSelection | undefined;
    if (parsed.value.model) {
      const model = parseModelArgument(parsed.value.model);
      if (!model) return refuse("model must be written as 'provider/modelId'.");
      requestedModel = model;
    }
    const routing = routeDelegation(
      agent,
      setup.specialists[agent],
      {
        ...(requestedModel && { model: requestedModel }),
        ...(parsed.value.thinking && { thinking: parsed.value.thinking }),
      },
      setup.catalog,
    );
    if (!routing.ok) return refuse(routing.message);
    const record = await this.startRun({
      agent,
      title,
      task,
      from: "director",
      parentRunId: null,
      parentMessageId: this.deps.directorMessageId,
      model: routing.model,
      thinking: applyThinkingPolicy(routing.thinking, setup.execution.budget.specialistThinking),
      routed: routing.routed,
    });
    const queued =
      record.run.status === "queued" ? " It is queued behind that specialist's current task." : "";
    return done(
      `Started ${AGENT_DISPLAY_NAMES[agent]} on "${title}" (run ${record.run.id}).${queued} Call wait_for_agents to get its report.`,
    );
  }

  private async waitForAgents(args: unknown, signal: AbortSignal): Promise<HostToolResult> {
    const parsed = parseWaitArgs(args);
    if (!parsed.ok) return refuse(parsed.message);
    let targets: RunRecord[];
    if (parsed.value.runIds) {
      targets = [];
      for (const id of parsed.value.runIds) {
        const record = this.records.get(id);
        if (!record || record.run.parentRunId !== null) return refuse(`Unknown run ${id}.`);
        targets.push(record);
      }
    } else {
      targets = [...this.records.values()].filter(
        (record) => record.run.parentRunId === null && !record.reported,
      );
    }
    if (targets.length === 0) return done("There are no delegated runs to wait for.");
    const steered = await this.until(
      () => targets.every((record) => record.finished),
      signal,
      true,
    );
    const lines = targets.map((record) => {
      if (record.finished) record.reported = true;
      return this.describe(record);
    });
    if (steered) {
      lines.push(
        "The user just sent a new instruction; it follows this result. Adjust the plan and the delegated work (message_agent, cancel_agent, delegate) accordingly.",
      );
    }
    return done(lines.join("\n\n"));
  }

  private cancel(args: unknown): HostToolResult {
    const parsed = parseRunArgs(args, false);
    if (!parsed.ok) return refuse(parsed.message);
    const record = this.records.get(parsed.value.runId);
    if (!record || record.run.parentRunId !== null)
      return refuse(`Unknown run ${parsed.value.runId}.`);
    if (record.finished) return done(`Run ${record.run.id} already ended (${record.run.status}).`);
    record.cancelled = true;
    record.controller.abort();
    return done(`Stopping run ${record.run.id}.`);
  }

  private async message(args: unknown): Promise<HostToolResult> {
    const parsed = parseRunArgs(args, true);
    if (!parsed.ok || parsed.value.text === null)
      return refuse(parsed.ok ? "text is required" : parsed.message);
    const record = this.records.get(parsed.value.runId);
    if (!record || record.run.parentRunId !== null)
      return refuse(`Unknown run ${parsed.value.runId}.`);
    if (record.finished || record.run.status !== "running" || !record.session)
      return refuse(
        `Run ${record.run.id} is not running (${record.run.status}); delegate a new task instead.`,
      );
    const message: TaskMessage = {
      id: this.deps.ids(),
      chatId: this.deps.chatId,
      turnId: this.deps.turn.id,
      createdAt: this.deps.now(),
      role: "task",
      runId: record.run.id,
      agent: record.run.agent,
      from: "director",
      parts: [{ type: "text", id: this.deps.ids(), text: parsed.value.text }],
      steering: true,
    };
    await this.deps.chats.emit(this.deps.chatId, { type: "message.appended", message });
    await record.session.steer(parsed.value.text);
    return done(`Sent to ${AGENT_DISPLAY_NAMES[record.run.agent]}.`);
  }

  private async runJev(
    caller: AgentId,
    args: unknown,
    signal: AbortSignal,
  ): Promise<HostToolResult> {
    const jev = this.deps.setup.jev;
    if (!jev) return refuse("Jev is not available.");
    if (caller === "jev") return refuse("Jev cannot call itself.");
    const parsed = parseJevArgs(args);
    if (!parsed.ok) return refuse(parsed.message);
    const parent = caller === "director" ? null : this.currentRun.get(caller);
    if (caller !== "director" && !parent) return refuse("Jev can only be used during a task.");
    const record = await this.startRun({
      agent: "jev",
      title: parsed.value.title,
      task: parsed.value.task,
      from: caller,
      parentRunId: parent?.run.id ?? null,
      parentMessageId: parent?.run.assistantMessageId ?? this.deps.directorMessageId,
      model: jev.model,
      thinking: jev.thinking,
      routed: false,
    });
    const abortJev = () => record.controller.abort();
    signal.addEventListener("abort", abortJev, { once: true });
    try {
      await record.done;
    } finally {
      signal.removeEventListener("abort", abortJev);
    }
    record.reported = true;
    if (record.run.status !== "completed")
      return refuse(
        `Jev did not finish (${record.run.status})${record.run.error ? `: ${record.run.error.message}` : ""}.`,
      );
    return done(record.report?.slice(0, REPORT_CHARS) || "Jev finished without a reply.");
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  private async startRun(input: {
    agent: WorkerAgentId;
    title: string;
    titleCode?: string;
    titleParams?: Record<string, string | number>;
    task: string;
    from: AgentId;
    parentRunId: string | null;
    parentMessageId: string;
    model: ModelSelection | null;
    thinking: ThinkingEffort | null;
    routed: boolean;
    /** The Director never has to collect this run (a run the runtime started itself). */
    reported?: boolean;
  }): Promise<RunRecord> {
    const { chats, chatId, turn, now, ids } = this.deps;
    const startedAt = now();
    const busy = input.agent !== "jev" && this.specialistTails.has(input.agent);
    const run: AgentRun = {
      id: ids(),
      turnId: turn.id,
      agent: input.agent,
      parentRunId: input.parentRunId,
      title: input.title,
      ...(input.titleCode !== undefined && { titleCode: input.titleCode }),
      ...(input.titleParams !== undefined && { titleParams: input.titleParams }),
      status: busy ? "queued" : "running",
      model: input.model,
      thinking: input.thinking,
      routedByDirector: input.routed,
      taskMessageId: ids(),
      assistantMessageId: ids(),
      startedAt,
      summary: null,
    };
    const taskMessage: TaskMessage = {
      id: run.taskMessageId,
      chatId,
      turnId: turn.id,
      createdAt: startedAt,
      role: "task",
      runId: run.id,
      agent: input.agent,
      from: input.from,
      parts: [{ type: "text", id: ids(), text: input.task }],
      steering: false,
    };
    const assistantMessage: AssistantMessage = {
      id: run.assistantMessageId,
      chatId,
      turnId: turn.id,
      createdAt: startedAt,
      role: "assistant",
      parts: [],
      status: "streaming",
      model: input.model,
      runId: run.id,
      agent: input.agent,
    };
    const controller = new AbortController();
    const record: RunRecord = {
      run,
      controller,
      session: null,
      done: Promise.resolve(),
      report: null,
      reported: input.reported ?? false,
      cancelled: false,
      finished: false,
    };
    this.records.set(run.id, record);
    const onTurnAbort = () => controller.abort();
    if (this.deps.signal.aborted) controller.abort();
    else this.deps.signal.addEventListener("abort", onTurnAbort, { once: true });
    const taskText = renderPromptContext(
      `<task title=${JSON.stringify(input.title)} from=${JSON.stringify(AGENT_DISPLAY_NAMES[input.from])}>\n${input.task}\n</task>`,
      this.deps.setup.editorContext,
      [],
      this.deps.setup.userLanguage,
    );
    // Research works under the user's Asset Search policy; it is stated with every task it gets. Every specialist is
    // told what the user's Autonomy settings mean for locked material (and Research for downloads).
    const autonomy =
      input.agent === "jev" ? null : renderAutonomyBlock(this.deps.setup.autonomy, input.agent);
    const research =
      input.agent === "research"
        ? renderResearchBlock(
            this.deps.setup.research,
            this.deps.setup.execution.budget.researchCandidates,
          )
        : null;
    const text = [taskText, research, autonomy].filter(Boolean).join("\n\n");

    // Queue the run before the first await, so concurrent delegations to one specialist line up in call order.
    const announced = Promise.withResolvers<boolean>();
    const execute = () =>
      announced.promise.then((ok) => (ok ? this.runAgent(record, text) : undefined));
    const cleanup = () => this.deps.signal.removeEventListener("abort", onTurnAbort);
    if (input.agent === "jev") {
      record.done = execute().finally(cleanup);
    } else {
      const agent = input.agent;
      const previous = this.specialistTails.get(agent) ?? Promise.resolve();
      const tail = previous.then(execute).finally(() => {
        cleanup();
        if (this.specialistTails.get(agent) === tail) this.specialistTails.delete(agent);
      });
      this.specialistTails.set(agent, tail);
      record.done = tail;
    }

    try {
      await chats.emit(chatId, {
        type: "agent.started",
        run: { ...run },
        parentMessageId: input.parentMessageId,
        taskMessage,
        assistantMessage,
      });
    } catch (error) {
      record.finished = true;
      this.records.delete(run.id);
      announced.resolve(false);
      throw error;
    }
    announced.resolve(true);
    await this.syncAutoPlan();
    return record;
  }

  private async runAgent(record: RunRecord, text: string): Promise<void> {
    const { run, controller } = record;
    const agent = run.agent;
    let writer: TurnEventWriter | null = null;
    try {
      if (controller.signal.aborted) {
        await this.finish(record, record.cancelled ? "cancelled" : "aborted", null);
        return;
      }
      if (run.status === "queued") {
        run.status = "running";
        await this.deps.chats.emit(this.deps.chatId, { type: "agent.updated", run: { ...run } });
        await this.syncAutoPlan();
      }
      if (agent !== "jev") this.currentRun.set(agent, record);
      record.session =
        agent === "jev" ? await this.deps.jevSession() : await this.deps.specialistSession(agent);
      writer = new TurnEventWriter({
        chats: this.deps.chats,
        chatId: this.deps.chatId,
        messageId: run.assistantMessageId,
        turn: this.deps.turn,
        now: this.deps.now,
        ids: this.deps.ids,
        timers: this.deps.timers,
        onModel: (event) => {
          run.model = event.model;
          run.thinking = event.thinking;
          void this.deps.chats
            .emit(this.deps.chatId, { type: "agent.updated", run: { ...run } })
            .catch(() => undefined);
        },
      });
      const activeWriter = writer;
      const outcome = await record.session.prompt({
        text,
        model: run.model,
        thinking: run.thinking,
        signal: controller.signal,
        onEvent: (event) => activeWriter.accept(event),
      });
      const stopped = outcome === "aborted" || controller.signal.aborted;
      await writer.finish(stopped ? "aborted" : "complete");
      const status: AgentRunStatus = stopped
        ? record.cancelled
          ? "cancelled"
          : "aborted"
        : "completed";
      await this.finish(record, status, null);
    } catch (error) {
      await writer?.finish("failed").catch(() => undefined);
      if (controller.signal.aborted)
        await this.finish(record, record.cancelled ? "cancelled" : "aborted", null);
      else await this.finish(record, "failed", error);
    } finally {
      if (agent !== "jev" && this.currentRun.get(agent) === record) this.currentRun.delete(agent);
      if (agent === "jev") await record.session?.dispose().catch(() => undefined);
    }
  }

  private async finish(record: RunRecord, status: AgentRunStatus, error: unknown): Promise<void> {
    if (record.finished) return;
    record.finished = true;
    const { run } = record;
    const reply = this.replyText(run.assistantMessageId);
    record.report = reply.all;
    run.status = status;
    run.endedAt = this.deps.now();
    run.summary = summarizeReport(reply.last);
    if (status === "failed") {
      run.error = { code: "agent_failed", message: errorMessage(error, "The agent failed") };
    }
    const messageStatus: AssistantMessageStatus =
      status === "completed" ? "complete" : status === "failed" ? "failed" : "aborted";
    try {
      await this.deps.chats.emit(this.deps.chatId, {
        type: "message.completed",
        messageId: run.assistantMessageId,
        status: messageStatus,
      });
      await this.deps.chats.emit(this.deps.chatId, { type: "agent.completed", run: { ...run } });
      await this.syncAutoPlan();
    } catch {
      // Persistence failed (disk gone); the in-memory record is still final and the turn will close.
    }
    this.wake();
  }

  /**
   * Normal mode always shows a compact plan once work is delegated. Until the Director publishes its own, the plan
   * is derived from the runs it started (one step per run) plus the final assembly step.
   */
  private async syncAutoPlan(): Promise<void> {
    if (this.directorPlanned) return;
    const runs = [...this.records.values()]
      .map((record) => record.run)
      .filter((run) => run.parentRunId === null);
    if (runs.length === 0) return;
    const stepStatus = (status: AgentRunStatus): PlanStepStatus => {
      if (status === "queued") return "pending";
      if (status === "running") return "running";
      if (status === "completed") return "done";
      return status === "failed" ? "failed" : "skipped";
    };
    const plan: ExecutionPlan = {
      steps: [
        ...runs.map((run) => ({
          id: `run-${run.id}`,
          title: run.title,
          status: stepStatus(run.status),
          agent: run.agent,
        })),
        {
          id: "assemble",
          title: "Review and assemble the result",
          status:
            this.assembled ??
            (runs.every((run) => isAgentRunTerminal(run.status)) ? "running" : "pending"),
          agent: "director",
        },
      ],
      updatedAt: this.deps.now(),
    };
    this.deps.turn.plan = plan;
    await this.deps.chats.emit(this.deps.chatId, {
      type: "plan.updated",
      turnId: this.deps.turn.id,
      plan,
    });
  }

  private replyText(messageId: string): { all: string | null; last: string | null } {
    const message = this.deps.chats
      .get(this.deps.chatId)
      ?.messages.find((candidate) => candidate.id === messageId);
    if (!message || message.role !== "assistant") return { all: null, last: null };
    const texts = message.parts.flatMap((part) =>
      part.type === "text" && part.text.trim() ? [part.text.trim()] : [],
    );
    return { all: texts.join("\n\n") || null, last: texts.at(-1) ?? null };
  }

  private describe(record: RunRecord): string {
    const { run } = record;
    const header = `${AGENT_DISPLAY_NAMES[run.agent]} — "${run.title}" (run ${run.id}): ${run.status}`;
    if (!isAgentRunTerminal(run.status)) return `${header}, still working.`;
    const detail = run.error
      ? `Error: ${run.error.message}`
      : `Report:\n${record.report?.slice(0, REPORT_CHARS) ?? "(no reply)"}`;
    return `${header}\n${detail}`;
  }

  // ── Waiting ────────────────────────────────────────────────────────────────

  private wake(): void {
    for (const waker of [...this.wakers]) waker();
  }

  /**
   * Resolves when `ready()` holds, the signal aborts, or (with `stopOnSteer`) the user steers. Returns true when it
   * returned because of steering.
   */
  private until(ready: () => boolean, signal: AbortSignal, stopOnSteer: boolean): Promise<boolean> {
    const steerMark = this.steerCount;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const check = () => {
      const steered = stopOnSteer && this.steerCount !== steerMark;
      if (!ready() && !steered && !signal.aborted) return;
      this.wakers.delete(check);
      signal.removeEventListener("abort", check);
      resolve(steered);
    };
    this.wakers.add(check);
    signal.addEventListener("abort", check, { once: true });
    check();
    return promise;
  }

  private async settleWithin(records: RunRecord[], ms: number): Promise<boolean> {
    const timeout = Promise.withResolvers<boolean>();
    const timer: StreamTimerHandle = this.deps.timers.setTimeout(() => timeout.resolve(false), ms);
    const settled = Promise.all(records.map((record) => record.done.catch(() => undefined))).then(
      () => true,
    );
    const result = await Promise.race([settled, timeout.promise]);
    this.deps.timers.clearTimeout(timer);
    return result;
  }
}
