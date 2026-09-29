import { randomUUID } from "node:crypto";
import type {
  ActiveTurnInfo,
  AssistantMessage,
  AssistantMessageStatus,
  UserPart,
  UserMessage,
  ChatSummary,
  RevertMode,
  RevertTurnResponse,
  StartTurnRequest,
  SteerTurnRequest,
  TurnCheckpoint,
  TurnSummary,
} from "@hyperframes/agent-protocol";
import type { AgentBackend, BackendSession } from "./backend.js";
import { RuntimeError, errorMessage } from "./errors.js";
import type { CheckpointHandle, CheckpointHost } from "./checkpointHost.js";
import { ChatService } from "./chats.js";
import { renderPromptContext } from "./promptContext.js";
import { SessionManager } from "./sessionManager.js";
import { FileChatStore } from "./store/index.js";
import { TurnEventWriter, type StreamTimerApi } from "./turnStream.js";
import { cloneTurn, createDeferredVoid, sameIds, type TurnRunnerOptions } from "./turnSupport.js";
export type { TurnRunnerOptions } from "./turnSupport.js";

const DEFAULT_IDLE_MS = 15 * 60_000;

interface ActiveRun {
  chatId: string;
  turn: TurnSummary;
  assistantMessage: AssistantMessage;
  controller: AbortController;
  checkpoint: CheckpointHandle | null;
  session: BackendSession | null;
  promptStarted: Promise<void>;
  markPromptStarted: () => void;
  task: Promise<void> | null;
  forcedError: unknown | null;
  finalizing: boolean;
}

/** Serializes all project mutations while keeping one resumable backend session per chat. */
export class TurnRunner {
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly idleMs: number;
  private readonly timers: StreamTimerApi;
  private readonly sessionManager: SessionManager;
  private active: ActiveRun | null = null;
  private revertingChatId: string | null = null;

  constructor(
    private readonly chats: ChatService,
    private readonly backend: AgentBackend,
    private readonly checkpoints: CheckpointHost,
    private readonly store: FileChatStore,
    options: TurnRunnerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;
    this.idleMs = options.sessionIdleMs ?? DEFAULT_IDLE_MS;
    this.timers = options.timers ?? {
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
    };
    this.sessionManager = new SessionManager(
      backend,
      store,
      chats.scope.projectDir,
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
    const checkpointLabel = `Director: ${input.prompt.slice(0, 60)}`;
    const started = createDeferredVoid();
    const reservation: ActiveRun = {
      chatId,
      turn: cloneTurn(turn),
      assistantMessage,
      controller: new AbortController(),
      checkpoint: null,
      session: null,
      promptStarted: started.promise,
      markPromptStarted: () => started.resolve(),
      task: null,
      forcedError: null,
      finalizing: false,
    };
    this.active = reservation;

    try {
      reservation.checkpoint = await this.checkpoints.begin(this.chats.scope, checkpointLabel);
      const checkpoint: TurnCheckpoint = {
        status: "active",
        entryIds: [],
        createdAt: reservation.checkpoint.startedAt,
      };
      turn.checkpoint = checkpoint;
      reservation.turn.checkpoint = { ...checkpoint, entryIds: [] };
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
    if (this.active !== run || run.finalizing || !run.session) {
      throw new RuntimeError("turn_not_active", "Turn is no longer active", 409);
    }
    try {
      await run.session.steer(renderPromptContext(input.text, input.editorContext));
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

  async recoverInterruptedTurns(): Promise<void> {
    for (const chat of this.chats.list()) {
      const state = this.chats.get(chat.id);
      if (!state) continue;
      for (const previous of state.turns.filter((turn) => turn.status === "running")) {
        const promptMessage = state.messages.find(
          (message) =>
            message.role === "user" && message.turnId === previous.id && !message.steering,
        );
        const prompt = promptMessage?.parts.find((part) => part.type === "text")?.text ?? "";
        const label = `Director: ${prompt.slice(0, 60)}`;
        let entryIds: string[] = [];
        try {
          entryIds = await this.checkpoints.recover(
            this.chats.scope,
            label,
            previous.checkpoint?.createdAt ?? previous.startedAt,
          );
        } catch {}
        const checkpoint: TurnCheckpoint = {
          status: "ready",
          entryIds,
          createdAt: previous.checkpoint?.createdAt ?? previous.startedAt,
          closedAt: this.now(),
        };
        const turn: TurnSummary = {
          ...previous,
          status: "interrupted",
          endedAt: this.now(),
          checkpoint,
        };
        await this.chats.emit(chat.id, { type: "checkpoint.updated", turnId: turn.id, checkpoint });
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

  private async runTurn(run: ActiveRun, input: StartTurnRequest): Promise<void> {
    let writer: TurnEventWriter | null = null;
    try {
      const session = await this.sessionManager.get(run.chatId);
      if (run.finalizing) return;
      run.session = session;
      writer = new TurnEventWriter({
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
      const promptPromise = session.prompt({
        text: renderPromptContext(input.prompt, input.editorContext, input.references),
        model: run.turn.model,
        thinking: run.turn.thinking,
        signal: run.controller.signal,
        onEvent: (event) => writer?.accept(event),
      });
      run.markPromptStarted();
      const outcome = await promptPromise;
      if (run.forcedError) {
        await writer.finish("failed");
        await this.finalize(run, "failed", run.forcedError);
      } else if (outcome === "aborted" || run.controller.signal.aborted) {
        await writer.finish("aborted");
        await this.finalize(run, "aborted");
      } else {
        await writer.finish("complete");
        await this.finalize(run, "completed");
      }
    } catch (error) {
      run.markPromptStarted();
      await writer?.finish("failed").catch(() => undefined);
      if (run.controller.signal.aborted && !run.forcedError) await this.finalize(run, "aborted");
      else await this.finalize(run, "failed", run.forcedError ?? error);
    }
  }

  private async finalize(
    run: ActiveRun,
    status: TurnSummary["status"],
    error?: unknown,
  ): Promise<void> {
    if (run.finalizing) return;
    run.finalizing = true;
    let entryIds: string[] = [];
    if (run.checkpoint) {
      try {
        entryIds = await run.checkpoint.end();
      } catch {
        entryIds = [];
      }
    }
    const closedAt = this.now();
    const checkpoint: TurnCheckpoint = {
      status: "ready",
      entryIds,
      createdAt: run.turn.checkpoint?.createdAt ?? run.turn.startedAt,
      closedAt,
    };
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
