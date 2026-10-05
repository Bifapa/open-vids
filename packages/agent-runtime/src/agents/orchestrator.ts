import {
  AGENT_DISPLAY_NAMES,
  applyThinkingPolicy,
  type AgentId,
  type AgentModelCatalog,
  type AgentRun,
  type AgentRunStatus,
  type EditorContext,
  type ExecutionBudget,
  type ExecutionQualityPreset,
  type ModelSelection,
  type SpecialistConfig,
  type SpecialistId,
  type ThinkingEffort,
  type TurnSummary,
} from "@hyperframes/agent-protocol";
import type { BackendSession, HostToolResult } from "../backend.js";
import type { TurnAutonomy } from "../autonomy.js";
import type { ChatService } from "../chats.js";
import { RuntimeError, errorMessage } from "../errors.js";
import type { ResearchTurnState } from "../research/prompt.js";
import type { StreamTimerApi } from "../turnStream.js";
import type { LeaseWriter, WriteLeases } from "../writeLeases.js";
import { currentRunId } from "./callerRun.js";
import { PlanKeeper } from "./planKeeper.js";
import { parseModelArgument, routeDelegation } from "./routing.js";
import { createRun, type RunInput } from "./runFactory.js";
import { executeRun, type RunHooks } from "./runExecutor.js";
import { clipReport, describeRun, done, refuse, type RunRecord } from "./runRecord.js";
import { settleRun } from "./runSettle.js";
import { RunWaiter } from "./runWaiter.js";
import { messageRun } from "./runMessage.js";
import { SpecialistQueue, type QueueTicket } from "./specialistQueue.js";
import { DEFAULT_STALL_MS } from "./stallWatchdog.js";
import { parseDelegateArgs, parseJevArgs, parseRunArgs, parseWaitArgs } from "./toolArgs.js";
import { LIMITS, TOOL_NAMES } from "./tools.js";

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
  /** False when the model list could not be loaded: the catalog is then empty, which says nothing about credentials. */
  catalogKnown: boolean;
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
  /** The tools the turn gives the Director for the work of a specialist that is off (see `inheritedToolsOf`). */
  inheritedTools: (specialist: SpecialistId) => readonly string[];
  /** The turn's abort signal: aborting the turn aborts every run. */
  signal: AbortSignal;
  now: () => number;
  ids: () => string;
  timers: StreamTimerApi;
  /**
   * The chat's session for a specialist, serving the run `runId`. `parallel` asks for an additional, ephemeral session
   * of the same role (a specialist running two tasks at once); the orchestrator disposes it when the run ends.
   */
  specialistSession: (
    agent: SpecialistId,
    parallel: boolean,
    runId: string,
  ) => Promise<BackendSession>;
  /** A fresh, ephemeral Jev session serving the run `runId`; disposed by the orchestrator after the run. */
  jevSession: (runId: string) => Promise<BackendSession>;
  /** Force-closes a specialist's resumable session that ignored an abort. */
  closeSpecialist: (agent: SpecialistId) => Promise<void>;
  /** How long an aborted run may take to stop before its session is force-closed. */
  stopGraceMs?: number;
  /** How long a run may show no sign of life before it is stopped (default {@link DEFAULT_STALL_MS}). */
  stallMs?: number;
  /** The turn's per-file write leases; a run's leases end with it. */
  leases: WriteLeases;
  /** The project's fingerprint, stamped on a proposed plan so a later "carry out" can tell the project moved. */
  projectFingerprint?: (signal: AbortSignal) => Promise<string | null>;
}

/** How a run the runtime started itself ended: its status, the failure message and the model it ran on. */
export interface RuntimeRunResult {
  status: AgentRunStatus;
  error: string | null;
  /** `provider/modelId`. */
  model: string | null;
}

const DEFAULT_STOP_GRACE_MS = 10_000;
const ORCHESTRATION_TOOLS = new Set<string>(Object.values(TOOL_NAMES));

function formatDuration(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}

/**
 * Runs the delegated work of one Director turn: specialist runs (async; one task at a time per specialist, two for
 * Research and Vision; parallel across specialists) and Jev calls (synchronous for the caller). Every run shares the
 * turn's abort signal and checkpoint; {@link shutdown} guarantees none is still running when the turn closes its
 * checkpoint.
 */
export class Orchestrator {
  private readonly records = new Map<string, RunRecord>();
  private readonly queue = new SpecialistQueue();
  private readonly waiter: RunWaiter;
  private readonly plan: PlanKeeper;
  private closed = false;

  private readonly hooks: RunHooks;

  constructor(private readonly deps: OrchestratorDeps) {
    this.waiter = new RunWaiter(deps.timers);
    this.plan = new PlanKeeper(deps);
    this.hooks = {
      deps,
      finish: (record, status, error) => this.finish(record, status, error),
      syncPlan: () => this.syncPlan(),
      stalled: (record) => this.stall(record),
    };
  }

  /**
   * The model the run behind the current host tool call uses (`provider/modelId`), or null when the call carries no
   * running run of that agent.
   */
  modelOf(agent: SpecialistId): string | null {
    const model = this.callerRecord(agent)?.run.model;
    return model ? `${model.provider}/${model.modelId}` : null;
  }

  /**
   * The run whose write leases the current host tool call works under, for the write leases; null when the call
   * carries no running run of that agent. A Jev run works under the lease of the run that called it.
   */
  runIdOf(agent: AgentId): string | null {
    const record = this.callerRecord(agent);
    return record ? (this.leaseWriterOf(record.run.id)?.runId ?? null) : null;
  }

  /**
   * Who writes for the run `runId`: the run itself, or — for a Jev run a specialist started — that specialist's run, so
   * Jev never blocks the run that asked for its help. Null when the run is not running (it takes no lease then).
   */
  leaseWriterOf(runId: string): LeaseWriter | null {
    const record = this.records.get(runId);
    if (!record || record.finished) return null;
    const parent =
      record.run.parentRunId === null ? undefined : this.records.get(record.run.parentRunId);
    const owner = parent && !parent.finished ? parent : record;
    return { agent: owner.run.agent, runId: owner.run.id };
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
      if (!ORCHESTRATION_TOOLS.has(name)) return refuse(`Unknown tool ${name}.`);
      if (name === TOOL_NAMES.jev) return await this.runJev(caller, args, signal);
      if (caller !== "director") return refuse(`${name} is only available to the Director.`);
      switch (name) {
        case TOOL_NAMES.propose:
          return await this.plan.propose(args);
        case TOOL_NAMES.plan:
          return await this.plan.update(args);
        case TOOL_NAMES.delegate:
          return await this.delegate(args);
        case TOOL_NAMES.wait:
          return await this.waitForAgents(args, signal);
        case TOOL_NAMES.cancel:
          return this.cancel(args);
        case TOOL_NAMES.message:
          return await messageRun(this.deps, this.records, args);
        default:
          return refuse(`Unknown tool ${name}.`);
      }
    } catch (error) {
      return refuse(errorMessage(error, `${name} failed`));
    }
  }

  /**
   * Runs a tool call of `caller` and keeps its run's watchdog quiet while it executes: renders, analyses and questions
   * to the user can be silent for long and carry their own deadlines. A finished call counts as a sign of life.
   */
  async trackToolCall<T>(caller: AgentId, call: () => Promise<T>): Promise<T> {
    const watchdog = this.callerRecord(caller)?.watchdog;
    watchdog?.toolStarted();
    try {
      return await call();
    } finally {
      watchdog?.toolFinished();
    }
  }

  /** The user steered the Director: a pending wait returns so the Director can react. */
  notifySteer(): void {
    this.waiter.steered();
  }

  /** Director-started runs whose results the Director has not received yet. */
  hasUnreported(): boolean {
    return this.unreported().length > 0;
  }

  /**
   * Waits until every Director-started run the Director has not heard back from has finished — or the user steers —
   * and returns their status/reports. Only finished runs count as reported.
   */
  async collectUnreported(signal: AbortSignal): Promise<string> {
    const pending = this.unreported();
    await this.waiter.until(() => pending.every((record) => record.finished), signal, {
      stopOnSteer: true,
    });
    return this.report(pending);
  }

  /**
   * Stops one run on the user's request (the Stop button of its row). A run waiting in line leaves the line at once; a
   * running one is aborted like at the end of a turn. The Director learns of it from the run's result and is told not
   * to start it again unless the user asks.
   */
  async cancelRun(runId: string, reason?: string): Promise<AgentRun> {
    const record = this.records.get(runId);
    if (!record || record.finished || this.closed) {
      throw new RuntimeError(
        "turn_not_active",
        record ? `Run ${runId} has already ended (${record.run.status}).` : `Unknown run ${runId}.`,
        409,
      );
    }
    record.cancelled = true;
    record.cancelledBy = "user";
    record.cancelReason = reason?.trim() || null;
    await this.stopRuns([record]);
    return { ...record.run };
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
    const routing = routeDelegation(
      input.agent,
      setup.specialists[input.agent],
      {},
      setup.catalog,
      setup.catalogKnown,
    );
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
      internal: true,
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
    this.plan.close(completed);
    await this.syncPlan().catch(() => undefined);
  }

  private async stopRuns(open: RunRecord[]): Promise<void> {
    for (const record of open) record.controller.abort();
    const grace = this.deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    if (await this.waiter.settleWithin(open, grace)) return;
    for (const record of open) {
      if (record.finished) continue;
      if (record.run.agent === "jev" || (record.slot ?? 0) > 0)
        await record.session?.dispose().catch(() => undefined);
      else await this.deps.closeSpecialist(record.run.agent);
    }
    if (await this.waiter.settleWithin(open, grace)) return;
    for (const record of open) {
      if (!record.finished) await this.finish(record, "aborted", null);
    }
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  private async delegate(args: unknown): Promise<HostToolResult> {
    const parsed = parseDelegateArgs(args);
    if (!parsed.ok) return refuse(parsed.message);
    const { agent, title, task } = parsed.value;
    const { setup } = this.deps;
    if (!setup.enabled.includes(agent)) {
      const enabled = setup.enabled.map((id) => AGENT_DISPLAY_NAMES[id]).join(", ") || "none";
      const tools = this.deps.inheritedTools(agent);
      const how = tools.length > 0 ? ` with ${tools.join(", ")}` : " with the tools you have";
      return refuse(
        `${AGENT_DISPLAY_NAMES[agent]} is off in this chat; do it yourself${how}. Enabled specialists: ${enabled}.`,
      );
    }
    if (agent === "research" && this.deps.turn.storyAction === "rebuild") {
      return refuse(
        'Research cannot search or import in a Rebuild turn: the only write there is rebuild_story. Material comes from a normal message, "Find missing material" or a full Build.',
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
      setup.catalogKnown,
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
      targets = this.unreported();
    }
    if (targets.length === 0) return done("There are no delegated runs to wait for.");
    const timeoutMs = (parsed.value.timeoutSeconds ?? LIMITS.waitDefaultSeconds) * 1000;
    const outcome = await this.waiter.until(
      () =>
        parsed.value.any
          ? targets.some((record) => record.finished)
          : targets.every((record) => record.finished),
      signal,
      { stopOnSteer: true, timeoutMs },
    );
    const lines = [this.report(targets)];
    if (outcome === "steered") {
      lines.push(
        "The user just sent a new instruction; it follows this result. Adjust the plan and the delegated work (message_agent, cancel_agent, delegate) accordingly.",
      );
    } else if (outcome === "timeout") {
      const going = targets.filter((record) => !record.finished).length;
      lines.push(
        `Waited ${formatDuration(timeoutMs)}; ${going} of these runs ${going === 1 ? "is" : "are"} still going. Call wait_for_agents again, or use the time for other work.`,
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
    record.cancelledBy ??= "director";
    record.cancelReason ??= parsed.value.reason;
    record.controller.abort();
    return done(`Stopping run ${record.run.id}.`);
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
    const parent = caller === "director" ? null : this.callerRecord(caller);
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
    return done(clipReport(record.report));
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  /**
   * The run behind the host tool call being executed: the one the call carries (see `withCallerRun`), else the agent's
   * only running run. Null when the agent has none or — without a carried run — several, which cannot be told apart.
   */
  private callerRecord(agent: AgentId): RunRecord | null {
    const carried = currentRunId();
    const record = carried === undefined ? undefined : this.records.get(carried);
    if (record && record.run.agent === agent && !record.finished) return record;
    const running = [...this.records.values()].filter(
      (candidate) =>
        candidate.run.agent === agent && !candidate.finished && candidate.run.status === "running",
    );
    return running.length === 1 ? (running[0] ?? null) : null;
  }

  /** Director-started runs whose result the Director has not received. */
  private unreported(): RunRecord[] {
    return [...this.records.values()].filter(
      (record) => record.run.parentRunId === null && !record.reported,
    );
  }

  /** The runs as the Director reads them; a finished run counts as reported. */
  private report(records: readonly RunRecord[]): string {
    return records
      .map((record) => {
        if (record.finished) record.reported = true;
        return describeRun(record, this.deps.now());
      })
      .join("\n\n");
  }

  private async startRun(input: RunInput): Promise<RunRecord> {
    const { chats, chatId } = this.deps;
    const busy = input.agent !== "jev" && this.queue.isBusy(input.agent);
    const ticket: QueueTicket | null =
      input.agent === "jev" ? null : this.queue.enqueue(input.agent);
    const { record, taskMessage, assistantMessage } = createRun(this.deps, input, busy);
    const { run, controller } = record;
    this.records.set(run.id, record);
    const onTurnAbort = () => controller.abort();
    if (this.deps.signal.aborted) controller.abort();
    else this.deps.signal.addEventListener("abort", onTurnAbort, { once: true });
    // A run that is stopped while it waits for its turn leaves the line at once, so the ones behind it do not wait.
    if (ticket) {
      const leaveLine = () => this.queue.drop(ticket);
      if (controller.signal.aborted) leaveLine();
      else controller.signal.addEventListener("abort", leaveLine, { once: true });
    }

    // The run is queued before the first await, so concurrent delegations to one specialist line up in call order.
    const announced = Promise.withResolvers<boolean>();
    record.done = this.lifecycle(record, ticket, announced.promise).finally(() =>
      this.deps.signal.removeEventListener("abort", onTurnAbort),
    );

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
    await this.syncPlan();
    return record;
  }

  /** Waits for the run's place, runs it and gives the place back. */
  private async lifecycle(
    record: RunRecord,
    ticket: QueueTicket | null,
    announced: Promise<boolean>,
  ): Promise<void> {
    if (!(await announced)) {
      if (ticket) {
        this.queue.drop(ticket);
        const granted = await ticket.granted;
        if (granted !== null) this.queue.release(ticket.agent, granted);
      }
      return;
    }
    const slot = ticket ? await ticket.granted : 0;
    if (slot === null) {
      await this.finish(record, "aborted", null);
      return;
    }
    try {
      await executeRun(this.hooks, record, slot);
    } finally {
      if (ticket) this.queue.release(ticket.agent, slot);
    }
  }

  /** The watchdog fired: the run showed no sign of life for too long. */
  private stall(record: RunRecord): void {
    if (record.finished) return;
    const limit = this.deps.stallMs ?? DEFAULT_STALL_MS;
    record.stalled = `No progress for ${formatDuration(limit)}: the model provider or a tool stopped answering, so the run was stopped.`;
    void this.stopRuns([record]).catch(() => undefined);
  }

  private async finish(record: RunRecord, status: AgentRunStatus, error: unknown): Promise<void> {
    if (!(await settleRun(this.deps, record, status, error))) return;
    await this.syncPlan().catch(() => undefined);
    this.waiter.wake();
  }

  private syncPlan(): Promise<void> {
    return this.plan.sync(
      [...this.records.values()]
        .filter((record) => record.run.parentRunId === null && !record.internal)
        .map((record) => record.run),
    );
  }
}
