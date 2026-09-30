import { randomUUID } from "node:crypto";
import {
  isAgentRunTerminal,
  type ActiveTurnInfo,
  type AgentId,
  type AgentModelCatalog,
  type AssistantMessage,
  type AssistantMessageStatus,
  type ChatMode,
  type StoryAction,
  type StoryActionOptions,
  type UserPart,
  type UserMessage,
  type ChatSummary,
  type RevertMode,
  type RevertTurnResponse,
  type SpecialistId,
  type StartTurnRequest,
  type SteerTurnRequest,
  type TurnCheckpoint,
  type TurnSummary,
} from "@hyperframes/agent-protocol";
import type { AgentBackend, BackendSession, HostToolResult } from "./backend.js";
import { Orchestrator, type TurnAgentSetup } from "./agents/orchestrator.js";
import { directorInstructions, jevInstructions, specialistInstructions } from "./agents/roles.js";
import { renderTeam, resolveTurnSetup } from "./agents/setup.js";
import { buildHostTools, type ToolAvailability } from "./agents/tools.js";
import { TurnEditing } from "./editing/executor.js";
import { isEditingToolName } from "./editing/tools.js";
import { TurnAnalysis } from "./analysis/executor.js";
import { isAnalysisToolName } from "./analysis/tools.js";
import { TurnStory } from "./story/executor.js";
import { renderStoryBlocks } from "./story/prompt.js";
import { isStoryToolName, storyToolsFor, timelineWritesAllowed } from "./story/tools.js";
import { RuntimeError, errorMessage } from "./errors.js";
import type { CheckpointHandle, CheckpointHost } from "./checkpointHost.js";
import { ChatService } from "./chats.js";
import { renderPromptContext } from "./promptContext.js";
import { SessionManager } from "./sessionManager.js";
import type { AgentSettingsStore } from "./settings.js";
import { FileChatStore } from "./store/index.js";
import { TurnEventWriter, type StreamTimerApi, type StreamTimerHandle } from "./turnStream.js";
import {
  STORY_TURN_TIMELINE_REFUSAL,
  checkpointLabel as labelFor,
  cloneTurn,
  createDeferredVoid,
  sameIds,
  writesTimeline,
  type TurnRunnerOptions,
} from "./turnSupport.js";
export type { TurnRunnerOptions } from "./turnSupport.js";

const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_RENEW_MS = 20_000;
/** How many times the Director is re-prompted with results of runs it finished without collecting. */
const MAX_FOLLOW_UPS = 3;

interface ActiveRun {
  chatId: string;
  turn: TurnSummary;
  assistantMessage: AssistantMessage;
  controller: AbortController;
  checkpoint: CheckpointHandle | null;
  session: BackendSession | null;
  setup: TurnAgentSetup | null;
  orchestrator: Orchestrator | null;
  /** The turn's editing tools; closed and awaited before the checkpoint ends. */
  editing: TurnEditing | null;
  /** The turn's analysis tools; closed (jobs cancelled, calls awaited) before the checkpoint ends. */
  analysis: TurnAnalysis | null;
  /** The turn's story tools; closed (in-flight edits/builds awaited) before the checkpoint ends. */
  story: TurnStory | null;
  /** The mode the turn runs in (a story action implies `story`). */
  mode: ChatMode;
  /** The Story workspace action the turn runs, if any. */
  storyAction: StoryAction | null;
  /** The user's choices for a build/rebuild action (scope, manual-edit policy, locked chapters), if any. */
  storyOptions: StoryActionOptions | null;
  /** The Director's prompt has ended but the turn is still collecting delegated work. */
  directorIdle: boolean;
  /** Steering received while the Director was idle; it opens the next Director prompt. */
  pendingSteering: string[];
  promptStarted: Promise<void>;
  markPromptStarted: () => void;
  task: Promise<void> | null;
  forcedError: unknown | null;
  finalizing: boolean;
  heartbeat: StreamTimerHandle | null;
}

/** Serializes all project mutations: one Director turn at a time, with its delegated runs, per project. */
export class TurnRunner {
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly idleMs: number;
  private readonly renewIntervalMs: number;
  private readonly stopGraceMs: number | undefined;
  private readonly editingFactory: TurnRunnerOptions["editing"];
  private readonly analysisFactory: TurnRunnerOptions["analysis"];
  private readonly storyFactory: TurnRunnerOptions["story"];
  private readonly analysisPollMs: number | undefined;
  private readonly timers: StreamTimerApi;
  private readonly sessionManager: SessionManager;
  private active: ActiveRun | null = null;
  private revertingChatId: string | null = null;

  constructor(
    private readonly chats: ChatService,
    private readonly backend: AgentBackend,
    private readonly checkpoints: CheckpointHost,
    private readonly store: FileChatStore,
    private readonly settings: AgentSettingsStore,
    options: TurnRunnerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;
    this.idleMs = options.sessionIdleMs ?? DEFAULT_IDLE_MS;
    this.renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_MS;
    this.stopGraceMs = options.stopGraceMs;
    this.editingFactory = options.editing;
    this.analysisFactory = options.analysis;
    this.storyFactory = options.story;
    this.analysisPollMs = options.analysisPollMs;
    this.timers = options.timers ?? {
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
    };
    this.sessionManager = new SessionManager(
      backend,
      this.idleMs,
      this.timers,
      (chatId) => this.active?.chatId === chatId,
    );
  }

  get activeTurn(): ActiveTurnInfo | null {
    return this.active ? this.info(this.active) : null;
  }

  async start(chatId: string, input: StartTurnRequest): Promise<TurnSummary> {
    if (!input.prompt.trim())
      throw new RuntimeError("invalid_request", "prompt must not be empty", 400);
    if (input.storyAction && !this.storyFactory)
      throw new RuntimeError("invalid_request", "Story Mode is not available in this runtime", 400);
    const chatState = this.chats.get(chatId);
    if (!chatState) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    if (this.active) {
      if (this.active.chatId === chatId)
        throw new RuntimeError("chat_busy", "This chat already has a running turn", 409);
      throw new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
        activeTurn: this.info(this.active),
      });
    }

    if (this.revertingChatId) {
      if (this.revertingChatId === chatId)
        throw new RuntimeError("chat_busy", "This chat is being reverted", 409);
      throw new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
        activeTurn: null,
      });
    }
    // A Story workspace action is always a story-mode turn; otherwise the request's mode, else the chat's.
    const mode: ChatMode = input.storyAction ? "story" : (input.mode ?? chatState.chat.activeMode);
    const startedAt = this.now();
    const turnId = this.ids();
    const promptMessageId = this.ids();
    const assistantMessageId = this.ids();
    const turn: TurnSummary = {
      id: turnId,
      chatId,
      status: "running",
      startedAt,
      promptMessageId,
      assistantMessageId,
      model: chatState.chat.mainAgentModel,
      thinking: chatState.chat.thinking,
      checkpoint: { status: "active", entryIds: [], createdAt: startedAt },
      mode,
      ...(input.storyAction && { storyAction: input.storyAction }),
      ...(input.storyOptions && { storyOptions: input.storyOptions }),
    };
    const referenceParts = (input.references ?? []).map(
      (reference): UserPart => ({
        type: "reference",
        id: this.ids(),
        reference,
      }),
    );
    const promptMessage: UserMessage = {
      id: promptMessageId,
      chatId,
      turnId,
      createdAt: startedAt,
      role: "user",
      steering: false,
      parts: [{ type: "text", id: this.ids(), text: input.prompt }, ...referenceParts],
    };
    const assistantMessage: AssistantMessage = {
      id: assistantMessageId,
      chatId,
      turnId,
      createdAt: startedAt,
      role: "assistant",
      parts: [],
      status: "streaming",
      model: turn.model,
    };
    const checkpointLabel = labelFor(input.prompt);
    const started = createDeferredVoid();
    const reservation: ActiveRun = {
      chatId,
      turn: cloneTurn(turn),
      assistantMessage,
      controller: new AbortController(),
      checkpoint: null,
      session: null,
      setup: null,
      orchestrator: null,
      editing: null,
      analysis: null,
      story: null,
      mode,
      storyAction: input.storyAction ?? null,
      storyOptions: input.storyOptions ?? null,
      directorIdle: false,
      pendingSteering: [],
      promptStarted: started.promise,
      markPromptStarted: () => started.resolve(),
      task: null,
      forcedError: null,
      finalizing: false,
      heartbeat: null,
    };
    this.active = reservation;

    // The team and the Director's model are fixed for the whole turn, from the chat and the global defaults.
    const prepared = await this.prepareTurn(chatState.chat, input);
    reservation.setup = prepared.setup;
    turn.model = prepared.model;
    turn.thinking = prepared.thinking;
    reservation.turn.model = prepared.model;
    reservation.turn.thinking = prepared.thinking;
    assistantMessage.model = prepared.model;

    try {
      await this.recoverCheckpoints();
      reservation.checkpoint = await this.checkpoints.begin(this.chats.scope, checkpointLabel);
      const checkpoint: TurnCheckpoint = {
        status: "active",
        entryIds: [],
        createdAt: reservation.checkpoint.startedAt,
        transactionId: reservation.checkpoint.transactionId,
      };
      turn.checkpoint = checkpoint;
      reservation.turn.checkpoint = { ...checkpoint, entryIds: [] };
      this.scheduleRenew(reservation);
    } catch (error) {
      if (this.active === reservation) this.active = null;
      throw new RuntimeError(
        "checkpoint_unavailable",
        errorMessage(error, "Could not open a project checkpoint"),
        409,
      );
    }

    try {
      await this.chats.emit(chatId, {
        type: "turn.started",
        turn,
        promptMessage,
        assistantMessage,
      });
      await this.chats.markWorking(chatId, input.prompt);
      this.chats.publishProject({ type: "project.activeTurn", activeTurn: this.info(reservation) });
      reservation.task = this.runTurn(reservation, input);
      return turn;
    } catch (error) {
      await this.finalize(reservation, "failed", error);
      throw error;
    }
  }

  async steer(chatId: string, turnId: string, input: SteerTurnRequest): Promise<string> {
    const run = this.active;
    if (!run || run.chatId !== chatId || run.turn.id !== turnId || run.finalizing) {
      throw new RuntimeError("turn_not_active", "Turn is not active", 409);
    }
    const messageId = this.ids();
    const message: UserMessage = {
      id: messageId,
      chatId,
      turnId,
      createdAt: this.now(),
      role: "user",
      steering: true,
      parts: [{ type: "text", id: this.ids(), text: input.text }],
    };
    await this.chats.emit(chatId, { type: "message.appended", message });
    await run.promptStarted;
    run.editing?.noteUserRequest(input.text);
    if (this.active !== run || run.finalizing || !run.session) {
      throw new RuntimeError("turn_not_active", "Turn is no longer active", 409);
    }
    const text = renderPromptContext(input.text, input.editorContext);
    if (run.directorIdle) {
      // The Director is between prompts, waiting for delegated runs: the instruction opens its next prompt.
      run.pendingSteering.push(text);
      run.orchestrator?.notifySteer();
      return messageId;
    }
    try {
      await run.session.steer(text);
      // A Director blocked in wait_for_agents returns now, so the instruction reaches it promptly.
      run.orchestrator?.notifySteer();
      return messageId;
    } catch (error) {
      run.forcedError = error;
      run.controller.abort();
      throw new RuntimeError(
        "agent_failed",
        errorMessage(error, "The agent could not apply the steering instruction"),
        502,
      );
    }
  }

  abort(chatId: string, turnId: string): void {
    const run = this.active;
    if (run && run.chatId === chatId && run.turn.id === turnId && !run.finalizing)
      run.controller.abort();
  }

  async revert(
    chatId: string,
    turnId: string,
    mode: RevertMode = "keep-later-edits",
  ): Promise<RevertTurnResponse> {
    if (this.active) {
      if (this.active.chatId === chatId)
        throw new RuntimeError("chat_busy", "This chat has a running turn", 409);
      throw new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
        activeTurn: this.info(this.active),
      });
    }
    if (this.revertingChatId) {
      if (this.revertingChatId === chatId)
        throw new RuntimeError("chat_busy", "This chat is being reverted", 409);
      throw new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
        activeTurn: null,
      });
    }
    const state = this.chats.get(chatId);
    if (!state) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    const turn = state.turns.find((entry) => entry.id === turnId);
    if (!turn) throw new RuntimeError("turn_not_found", "Turn was not found", 404);
    if (state.chat.status === "working")
      throw new RuntimeError("chat_busy", "This chat has a running turn", 409);
    const checkpoint = turn.checkpoint;
    if (!checkpoint || checkpoint.status !== "ready" || checkpoint.entryIds.length === 0) {
      throw new RuntimeError("revert_unavailable", "This turn has no reversible checkpoint", 409);
    }

    this.revertingChatId = chatId;
    try {
      let outcome;
      try {
        outcome = await this.checkpoints.revert(this.chats.scope, checkpoint.entryIds, mode);
      } catch (error) {
        throw new RuntimeError(
          "runtime_unavailable",
          errorMessage(error, "Could not revert this turn"),
          503,
        );
      }
      if (!outcome.ok) {
        if (outcome.remainingEntryIds && !sameIds(checkpoint.entryIds, outcome.remainingEntryIds)) {
          const updatedCheckpoint: TurnCheckpoint = {
            ...checkpoint,
            entryIds: outcome.remainingEntryIds,
          };
          await this.chats.emit(chatId, {
            type: "checkpoint.updated",
            turnId,
            checkpoint: updatedCheckpoint,
          });
        }
        return { ok: false, conflict: outcome.conflict };
      }
      const updatedCheckpoint: TurnCheckpoint = {
        ...checkpoint,
        status: "reverted",
        revertedAt: this.now(),
      };
      const updatedTurn: TurnSummary = { ...turn, checkpoint: updatedCheckpoint };
      await this.chats.emit(chatId, {
        type: "checkpoint.updated",
        turnId,
        checkpoint: updatedCheckpoint,
      });
      return { ok: true, turn: updatedTurn };
    } finally {
      this.revertingChatId = null;
    }
  }

  /**
   * Closes every transaction a previous run could not: turns still "running" in the log (the runtime died mid-turn)
   * become "interrupted", and checkpoints still "active" (a turn ended while Studio was unreachable) are closed and
   * given their entries. Delegated runs left open by a dead runtime are closed as "interrupted" first, so no run
   * outlives its turn. Runs on project load and before each new turn.
   */
  async recoverCheckpoints(): Promise<void> {
    for (const chat of this.chats.list()) {
      const orphans = this.chats
        .get(chat.id)
        ?.runs.filter(
          (run) => !isAgentRunTerminal(run.status) && run.turnId !== this.active?.turn.id,
        );
      for (const orphan of orphans ?? []) {
        await this.chats.emit(chat.id, {
          type: "agent.completed",
          run: { ...orphan, status: "interrupted", endedAt: this.now() },
        });
      }
      const state = this.chats.get(chat.id);
      if (!state) continue;
      for (const previous of state.turns) {
        if (this.active?.turn.id === previous.id) continue;
        const crashed = previous.status === "running";
        if (!crashed && previous.checkpoint?.status !== "active") continue;
        const promptMessage = state.messages.find(
          (message) =>
            message.role === "user" && message.turnId === previous.id && !message.steering,
        );
        const prompt = promptMessage?.parts.find((part) => part.type === "text")?.text ?? "";
        const createdAt = previous.checkpoint?.createdAt ?? previous.startedAt;
        let entryIds: string[];
        try {
          entryIds = await this.checkpoints.recover(this.chats.scope, {
            label: labelFor(prompt),
            startedAt: createdAt,
            ...(previous.checkpoint?.transactionId && {
              transactionId: previous.checkpoint.transactionId,
            }),
          });
        } catch {
          // Studio is unreachable: leave it pending for the next attempt rather than record "no changes".
          if (!crashed) continue;
          entryIds = [];
        }
        const checkpoint: TurnCheckpoint = {
          status: "ready",
          entryIds,
          createdAt,
          closedAt: this.now(),
        };
        await this.chats.emit(chat.id, {
          type: "checkpoint.updated",
          turnId: previous.id,
          checkpoint,
        });
        if (!crashed) continue;
        const turn: TurnSummary = {
          ...previous,
          status: "interrupted",
          endedAt: this.now(),
          checkpoint,
        };
        await this.chats.markStatus(chat.id, "interrupted");
        await this.chats.emit(chat.id, { type: "turn.aborted", turn });
      }
    }
  }

  async dispose(): Promise<void> {
    const active = this.active;
    if (active) {
      active.controller.abort();
      await active.task?.catch(() => undefined);
    }
    await this.sessionManager.dispose();
  }

  /** Heartbeat: keeps the turn's transaction open for the whole turn, however long it pauses between writes. */
  private scheduleRenew(run: ActiveRun): void {
    run.heartbeat = this.timers.setTimeout(() => void this.renew(run), this.renewIntervalMs);
  }

  private async renew(run: ActiveRun): Promise<void> {
    if (!run.checkpoint || run.finalizing) return;
    let open = true;
    try {
      open = await run.checkpoint.renew();
    } catch {
      // Studio did not answer this beat; the next one retries well within the host's lease.
    }
    if (run.finalizing) return;
    if (!open) {
      // Its later writes would no longer be this turn's, so Revert this turn could not undo them: stop here.
      run.forcedError ??= new Error(
        "The project checkpoint for this turn ended unexpectedly, so the agent was stopped to keep every change of this turn revertable.",
      );
      run.controller.abort();
      return;
    }
    this.scheduleRenew(run);
  }

  private async runTurn(run: ActiveRun, input: StartTurnRequest): Promise<void> {
    let writer: TurnEventWriter | null = null;
    try {
      const setup = run.setup;
      if (!setup) throw new Error("The turn has no agent setup.");
      const editingFactory = this.editingFactory;
      const editingHost = editingFactory ? editingFactory(this.chats.scope) : null;
      run.editing =
        editingFactory && editingHost
          ? new TurnEditing({
              host: editingHost,
              editorContext: setup.editorContext,
              turnSignal: run.controller.signal,
              userRequests: [input.prompt],
              turnId: run.turn.id,
            })
          : null;
      const analysisFactory = this.analysisFactory;
      run.analysis = analysisFactory
        ? new TurnAnalysis({
            host: analysisFactory(this.chats.scope),
            editing: editingHost,
            turnSignal: run.controller.signal,
            turnId: run.turn.id,
            ...(this.analysisPollMs !== undefined && { pollMs: this.analysisPollMs }),
          })
        : null;
      const storyFactory = this.storyFactory;
      run.story = storyFactory
        ? new TurnStory({
            host: storyFactory(this.chats.scope),
            turnId: run.turn.id,
            turnSignal: run.controller.signal,
            storyOptions: run.storyOptions,
          })
        : null;
      const availability: ToolAvailability = {
        enabled: setup.enabled,
        jev: setup.jev !== null,
        editing: run.editing !== null,
        analysis: run.analysis !== null,
        story: run.story !== null,
        mode: run.mode,
        storyAction: run.storyAction,
        planClips: (plan) => this.active?.analysis?.planClips(plan),
      };
      const session = await this.agentSession(run.chatId, "director", availability);
      if (run.finalizing) return;
      run.session = session;
      run.orchestrator = new Orchestrator({
        chats: this.chats,
        chatId: run.chatId,
        turn: run.turn,
        directorMessageId: run.assistantMessage.id,
        setup,
        signal: run.controller.signal,
        now: this.now,
        ids: this.ids,
        timers: this.timers,
        ...(this.stopGraceMs !== undefined && { stopGraceMs: this.stopGraceMs }),
        specialistSession: (agent) => this.agentSession(run.chatId, agent, availability),
        jevSession: () => this.jevSession(run.chatId, setup),
        closeSpecialist: (agent) => this.sessionManager.disposeAgent(run.chatId, agent),
      });
      const activeWriter = new TurnEventWriter({
        chats: this.chats,
        chatId: run.chatId,
        messageId: run.assistantMessage.id,
        turn: run.turn,
        now: this.now,
        ids: this.ids,
        timers: this.timers,
        onModel: (event) => {
          run.turn.model = event.model;
          run.turn.thinking = event.thinking;
        },
      });
      writer = activeWriter;
      const promptDirector = (text: string) =>
        session.prompt({
          text,
          model: run.turn.model,
          thinking: run.turn.thinking,
          signal: run.controller.signal,
          onEvent: (event) => activeWriter.accept(event),
        });
      const storyBlocks =
        run.mode === "story" && run.story
          ? `\n\n${renderStoryBlocks({
              action: run.storyAction,
              editorEnabled: setup.enabled.includes("editor"),
              storyOptions: run.storyOptions,
              graph: await run.story.snapshot(run.controller.signal),
            })}`
          : "";
      const promptPromise = promptDirector(
        `${renderTeam(setup)}\n\n${renderPromptContext(input.prompt, input.editorContext, input.references)}${storyBlocks}`,
      );
      run.markPromptStarted();
      let outcome = await promptPromise;
      run.directorIdle = true;

      // The Director must hear back from every run it started, and from steering sent while it was idle.
      let followUps = 0;
      while (
        outcome === "completed" &&
        !run.forcedError &&
        !run.controller.signal.aborted &&
        followUps < MAX_FOLLOW_UPS &&
        (run.pendingSteering.length > 0 || run.orchestrator.hasUnreported())
      ) {
        const results =
          run.pendingSteering.length > 0
            ? ""
            : await run.orchestrator.collectUnreported(run.controller.signal);
        if (run.controller.signal.aborted) break;
        const steering = run.pendingSteering.splice(0);
        if (steering.length === 0) followUps += 1;
        const blocks = [
          results &&
            `<delegated-results>\n${results}\n</delegated-results>\nThese delegated runs reported after your last reply.`,
          ...steering.map((text) => `<user-steering>\n${text}\n</user-steering>`),
          "Continue: adjust the plan and delegated work if needed, wait for any runs still working, then finish the user's request with a short reply.",
        ].filter(Boolean);
        run.directorIdle = false;
        activeWriter.startPrompt();
        outcome = await promptDirector(blocks.join("\n\n"));
        run.directorIdle = true;
      }

      if (run.forcedError) {
        await activeWriter.finish("failed");
        await this.finalize(run, "failed", run.forcedError);
      } else if (outcome === "aborted" || run.controller.signal.aborted) {
        await activeWriter.finish("aborted");
        await this.finalize(run, "aborted");
      } else {
        await activeWriter.finish("complete");
        await this.finalize(run, "completed");
      }
    } catch (error) {
      run.markPromptStarted();
      await writer?.finish("failed").catch(() => undefined);
      if (run.controller.signal.aborted && !run.forcedError) await this.finalize(run, "aborted");
      else await this.finalize(run, "failed", run.forcedError ?? error);
    }
  }

  /** Resolves the Director's model and the team for a new turn. Never throws: missing data means defaults. */
  private async prepareTurn(
    chat: ChatSummary,
    input: StartTurnRequest,
  ): Promise<{
    setup: TurnAgentSetup;
    model: TurnSummary["model"];
    thinking: TurnSummary["thinking"];
  }> {
    const settings = await this.settings.get();
    const jevApiKey = await this.settings.jevApiKey();
    let catalog: AgentModelCatalog = { models: [], defaultModel: null, defaultThinking: null };
    try {
      catalog = await this.backend.listModels();
    } catch {
      // No catalog: routing to other models and provider-login Jev are unavailable this turn; defaults still run.
    }
    return {
      setup: resolveTurnSetup({
        chat,
        settings,
        jevApiKey,
        catalog,
        ...(input.editorContext && { editorContext: input.editorContext }),
      }),
      model: chat.mainAgentModel ?? settings.director.model,
      thinking: chat.thinking ?? settings.director.thinking,
    };
  }

  /** The chat's resumable session for the Director or a specialist, with the tools this turn allows it. */
  private agentSession(
    chatId: string,
    agent: "director" | SpecialistId,
    availability: ToolAvailability,
  ): Promise<BackendSession> {
    const hostTools = buildHostTools(agent, availability, (name, args, signal) =>
      this.dispatchTool(chatId, agent, name, args, signal),
    );
    const instructions =
      agent === "director" ? directorInstructions() : specialistInstructions(agent);
    return this.sessionManager.get({
      chatId,
      agent,
      signature: JSON.stringify([
        instructions,
        hostTools.map((tool) => [tool.name, tool.description, tool.parameters]),
      ]),
      open: async () => ({
        chatId,
        agent,
        projectDir: this.chats.scope.projectDir,
        stateDir:
          agent === "director"
            ? await this.store.stateDir(chatId)
            : await this.store.agentStateDir(chatId, agent),
        instructions,
        hostTools,
      }),
    });
  }

  private jevSession(chatId: string, setup: TurnAgentSetup): Promise<BackendSession> {
    const credentials = setup.jev?.credentials;
    return this.backend.openSession({
      chatId,
      agent: "jev",
      projectDir: this.chats.scope.projectDir,
      stateDir: null,
      instructions: jevInstructions(),
      hostTools: [],
      ...(credentials && { credentials }),
    });
  }

  /** Host tools are bound to a session for many turns; each call goes to the orchestrator of the running turn. */
  private async dispatchTool(
    chatId: string,
    caller: AgentId,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<HostToolResult> {
    const run = this.active;
    if (!run || run.chatId !== chatId || run.finalizing)
      return { text: "There is no running turn for this tool call.", isError: true };
    if (isStoryToolName(name)) {
      if (!run.story)
        return { text: "Story Mode is not available in this runtime.", isError: true };
      const allowed = storyToolsFor(caller, run.setup?.enabled ?? [], {
        mode: run.mode,
        action: run.storyAction,
      });
      if (!allowed.some((tool) => tool === name))
        return { text: `${name} is not available to you in this turn.`, isError: true };
      return run.story.execute(name, args, signal);
    }
    if (!timelineWritesAllowed({ mode: run.mode, action: run.storyAction }) && writesTimeline(name))
      return { text: STORY_TURN_TIMELINE_REFUSAL, isError: true };
    if (isEditingToolName(name)) {
      if (!run.editing) return { text: "Editing is not available in this runtime.", isError: true };
      return run.editing.execute(name, args, signal);
    }
    if (isAnalysisToolName(name)) {
      if (!run.analysis)
        return { text: "Analysis is not available in this runtime.", isError: true };
      return run.analysis.execute(name, args, signal);
    }
    if (!run.orchestrator)
      return { text: "There is no running turn for this tool call.", isError: true };
    return run.orchestrator.execute(caller, name, args, signal);
  }

  private async finalize(
    run: ActiveRun,
    status: TurnSummary["status"],
    error?: unknown,
  ): Promise<void> {
    if (run.finalizing) return;
    run.finalizing = true;
    // Every delegated run must be over before the checkpoint closes, or its later writes would escape Revert.
    await run.orchestrator?.shutdown(status === "completed").catch(() => undefined);
    // Editing calls still running (or a render) end here too: no editing write may land after the checkpoint closes.
    // Analysis jobs are cancelled and a rough cut already sent to the editing service is awaited for the same reason;
    // a story edit or build already sent to the story service is awaited too (it is atomic there).
    await run.story?.shutdown().catch(() => undefined);
    await run.analysis?.shutdown().catch(() => undefined);
    await run.editing?.shutdown().catch(() => undefined);
    if (run.heartbeat) this.timers.clearTimeout(run.heartbeat);
    const createdAt = run.turn.checkpoint?.createdAt ?? run.turn.startedAt;
    const closedAt = this.now();
    let checkpoint: TurnCheckpoint = { status: "ready", entryIds: [], createdAt, closedAt };
    if (run.checkpoint) {
      try {
        checkpoint = { ...checkpoint, entryIds: await run.checkpoint.end() };
      } catch {
        // Studio could not be reached (shutting down, restarting). The transaction is not lost: it stays "active"
        // with its id, and recoverCheckpoints() closes it and collects its entries on the next turn or project load.
        checkpoint = {
          status: "active",
          entryIds: [],
          createdAt,
          transactionId: run.checkpoint.transactionId,
        };
      }
    }
    run.turn.checkpoint = checkpoint;
    run.turn.status = status;
    run.turn.endedAt = closedAt;
    if (status === "failed") {
      run.turn.error = {
        code: "agent_failed",
        message: errorMessage(error, "The agent failed to complete this turn"),
      };
    }
    const assistantStatus: AssistantMessageStatus =
      status === "completed" ? "complete" : status === "failed" ? "failed" : "aborted";
    await this.bestEffort(() =>
      this.chats.emit(run.chatId, {
        type: "message.completed",
        messageId: run.assistantMessage.id,
        status: assistantStatus,
      }),
    );
    await this.bestEffort(() =>
      this.chats.emit(run.chatId, {
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
    await this.bestEffort(() =>
      this.chats.markStatus(run.chatId, chatStatus).then(() => undefined),
    );
    if (status === "failed") {
      await this.bestEffort(() =>
        this.chats.emit(run.chatId, {
          type: "turn.failed",
          turn: run.turn,
          error: run.turn.error ?? {
            code: "agent_failed",
            message: "The agent failed to complete this turn",
          },
        }),
      );
    } else if (status === "completed") {
      await this.bestEffort(() =>
        this.chats.emit(run.chatId, { type: "turn.completed", turn: run.turn }),
      );
    } else {
      await this.bestEffort(() =>
        this.chats.emit(run.chatId, { type: "turn.aborted", turn: run.turn }),
      );
    }
    this.sessionManager.scheduleDisposal(run.chatId);
    if (this.active === run) {
      this.chats.publishProject({ type: "project.activeTurn", activeTurn: null });
      this.active = null;
    }
  }

  private info(run: ActiveRun): ActiveTurnInfo {
    return { chatId: run.chatId, turnId: run.turn.id, startedAt: run.turn.startedAt };
  }

  private async bestEffort(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch {}
  }
}
