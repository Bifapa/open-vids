import { randomUUID } from "node:crypto";
import {
  normalizeChatIntent,
  type ActiveTurnInfo,
  type AgentModelCatalog,
  type AnswerPermissionResponse,
  type AnswerQuestionResponse,
  type AnswerStoryOfferResponse,
  type AssistantMessage,
  type CancelRunResponse,
  type ChatIntent,
  type ChatMode,
  type ChatState,
  type ChatSummary,
  type DeleteChatResponse,
  type MessageReference,
  type PermissionDecision,
  type RevertMode,
  type RevertTurnResponse,
  type StartTurnRequest,
  type StoryOfferDecision,
  type SteerTurnRequest,
  type TurnCheckpoint,
  type TurnSummary,
  type UserMessage,
  type UserPart,
} from "@hyperframes/agent-protocol";
import type { AgentBackend } from "./backend.js";
import type { TurnAgentSetup } from "./agents/orchestrator.js";
import { resolveTurnSetup } from "./agents/setup.js";
import type { CheckpointHost } from "./checkpointHost.js";
import { ChatService } from "./chats.js";
import { RuntimeError, errorMessage } from "./errors.js";
import { renderPromptContext } from "./promptContext.js";
import { WebsiteResourceLog } from "./research/websiteResources.js";
import { SessionManager } from "./sessionManager.js";
import type { AgentSettingsStore } from "./settings.js";
import { FileChatStore } from "./store/index.js";
import { ChangeTally } from "./turn/changes.js";
import {
  busyError,
  turnInfo,
  type ActiveRun,
  type ExecutePlan,
  type TurnContext,
} from "./turn/context.js";
import { websiteResourceFile } from "./turn/executors.js";
import { finalizeTurn } from "./turn/finalize.js";
import { recoverCheckpoints, revertTurn, unrevertTurn } from "./turn/reverts.js";
import { runTurn } from "./turn/run.js";
import { answerStoryOffer, expireStoryOffers } from "./turn/storyOffers.js";
import { DEFAULT_PROMPT_STALL_MS } from "./turn/watchdog.js";
import type { StreamTimerApi } from "./turnStream.js";
import { checkpointLabel as labelFor, cloneTurn, type TurnRunnerOptions } from "./turnSupport.js";
import { WriteLeases } from "./writeLeases.js";
export type { TurnRunnerOptions } from "./turnSupport.js";

const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_RENEW_MS = 20_000;

/** Serializes all project mutations: one Director turn at a time, with its delegated runs, per project. */
export class TurnRunner {
  private readonly ctx: TurnContext;

  constructor(
    chats: ChatService,
    backend: AgentBackend,
    checkpoints: CheckpointHost,
    store: FileChatStore,
    settings: AgentSettingsStore,
    options: TurnRunnerOptions = {},
  ) {
    const timers: StreamTimerApi = options.timers ?? {
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
    };
    const ctx: TurnContext = {
      chats,
      backend,
      checkpoints,
      store,
      settings,
      options,
      timers,
      sessions: new SessionManager(
        backend,
        options.sessionIdleMs ?? DEFAULT_IDLE_MS,
        timers,
        (chatId) => ctx.active?.chatId === chatId,
      ),
      leases: new WriteLeases(),
      recoverChats: new Set(),
      deletingChats: new Set(),
      runSlots: new Map(),
      websiteResources: new WebsiteResourceLog({
        fileOf: (chatId) => websiteResourceFile(ctx, chatId),
      }),
      now: options.now ?? Date.now,
      ids: options.ids ?? randomUUID,
      renewIntervalMs: options.renewIntervalMs ?? DEFAULT_RENEW_MS,
      promptStallMs: options.promptStallMs ?? DEFAULT_PROMPT_STALL_MS,
      active: null,
      revertingChatId: null,
    };
    this.ctx = ctx;
  }

  get activeTurn(): ActiveTurnInfo | null {
    return this.ctx.active ? turnInfo(this.ctx.active) : null;
  }

  async start(chatId: string, input: StartTurnRequest): Promise<TurnSummary> {
    const ctx = this.ctx;
    if (!input.prompt.trim())
      throw new RuntimeError("invalid_request", "prompt must not be empty", 400);
    if (input.storyAction && !ctx.options.story)
      throw new RuntimeError("invalid_request", "Story Mode is not available in this runtime", 400);
    const chatState = ctx.chats.get(chatId);
    if (!chatState) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    const busy = busyError(ctx, chatId);
    if (busy) throw busy;
    // "Carry out the plan": the proposal must exist on the chat before anything is reserved.
    const executePlan = this.resolveExecutePlan(chatState, input);
    // A Story workspace action is always a story-mode turn; a plan is carried out in a normal turn; otherwise the
    // request's mode, else the chat's.
    const mode: ChatMode = input.storyAction
      ? "story"
      : executePlan
        ? "normal"
        : (input.mode ?? chatState.chat.activeMode);
    // A Story workspace action and an approved plan always act; otherwise the request's intent, else the chat's
    // (an old chat may still store the removed `plan`, read as `edit`), else Edit.
    const intent: ChatIntent =
      input.storyAction || executePlan
        ? "edit"
        : (input.intent ?? normalizeChatIntent(chatState.chat.intent) ?? "edit");
    const startedAt = ctx.now();
    const turnId = ctx.ids();
    const promptMessageId = ctx.ids();
    const assistantMessageId = ctx.ids();
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
      intent,
      ...(input.storyAction && { storyAction: input.storyAction }),
      ...(input.storyOptions && { storyOptions: input.storyOptions }),
      ...(executePlan && { executedPlanTurnId: executePlan.turnId }),
    };
    const promptMessage: UserMessage = {
      id: promptMessageId,
      chatId,
      turnId,
      createdAt: startedAt,
      role: "user",
      steering: false,
      parts: [
        { type: "text", id: ctx.ids(), text: input.prompt },
        ...this.referenceParts(input.references),
      ],
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
      frames: null,
      analysis: null,
      story: null,
      research: null,
      crossProject: null,
      crossProjectOffered: false,
      permissions: null,
      questions: null,
      qa: null,
      qaPhase: null,
      mode,
      intent,
      planApproval: "never",
      executePlan,
      storyAction: input.storyAction ?? null,
      storyOptions: input.storyOptions ?? null,
      storyOfferEligible: false,
      storyOffer: null,
      changes: new ChangeTally(),
      workAttempted: false,
      directorIdle: false,
      firstPromptSent: false,
      pendingSteering: [],
      watchdog: null,
      task: null,
      forcedError: null,
      finalizing: false,
      heartbeat: null,
    };
    // The project is reserved before the first await: every check above and this assignment run in one tick, so a
    // concurrent start cannot slip in while the chat log is written or the setup resolved. Any failure releases it.
    ctx.active = reservation;

    try {
      // A new user turn moves the chat on: a Story Mode offer still waiting for its answer is expired. (The offer of
      // the turn that just ended stays answerable, so this is the only place a pending offer is taken down.)
      await expireStoryOffers(ctx, chatId);
      // A start-from-chat project on Auto: the format stays open across turns (a proposal now, the edit later)
      // until an edit sets the canvas. Durable on the chat, so a restart does not lose the choice.
      if (input.canvas === "auto") await ctx.chats.setCanvasAuto(chatId, true);

      // The team and the Director's model are fixed for the whole turn, from the chat and the global defaults.
      const prepared = await this.prepareTurn(chatState.chat, input);
      reservation.setup = prepared.setup;
      reservation.planApproval = prepared.setup.autonomy.planApproval;
      turn.model = prepared.model;
      turn.thinking = prepared.thinking;
      reservation.turn.model = prepared.model;
      reservation.turn.thinking = prepared.thinking;
      assistantMessage.model = prepared.model;
      const execution = prepared.setup.execution;
      turn.execution = { preset: execution.preset, budget: { ...execution.budget } };
      reservation.turn.execution = { preset: execution.preset, budget: { ...execution.budget } };
    } catch (error) {
      if (ctx.active === reservation) ctx.active = null;
      throw error;
    }

    try {
      await recoverCheckpoints(ctx, chatId);
      reservation.checkpoint = await ctx.checkpoints.begin(ctx.chats.scope, labelFor(input.prompt));
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
      if (ctx.active === reservation) ctx.active = null;
      throw new RuntimeError(
        "checkpoint_unavailable",
        errorMessage(error, "Could not open a project checkpoint"),
        409,
      );
    }

    try {
      await ctx.chats.emit(chatId, {
        type: "turn.started",
        turn,
        promptMessage,
        assistantMessage,
      });
      await ctx.chats.markWorking(chatId, input.prompt);
      await ctx.chats.refreshLinkedSites(chatId);
      ctx.chats.publishProject({ type: "project.activeTurn", activeTurn: turnInfo(reservation) });
      reservation.task = runTurn(ctx, reservation, input);
      return turn;
    } catch (error) {
      await finalizeTurn(ctx, reservation, "failed", error);
      throw error;
    }
  }

  private referenceParts(references: readonly MessageReference[] = []): UserPart[] {
    return references.map(
      (reference): UserPart => ({ type: "reference", id: this.ctx.ids(), reference }),
    );
  }

  /**
   * Steering reaches the Director when it can take it: a steer into the running prompt, else (setup not finished, the
   * Director waiting for delegated runs, or the model refusing the steer) it is queued and opens the Director's next
   * prompt. The steering message is in the chat from the start either way.
   */
  async steer(chatId: string, turnId: string, input: SteerTurnRequest): Promise<string> {
    const ctx = this.ctx;
    const run = ctx.active;
    if (!run || run.chatId !== chatId || run.turn.id !== turnId || run.finalizing) {
      throw new RuntimeError("turn_not_active", "Turn is not active", 409);
    }
    const messageId = ctx.ids();
    const message: UserMessage = {
      id: messageId,
      chatId,
      turnId,
      createdAt: ctx.now(),
      role: "user",
      steering: true,
      parts: [
        { type: "text", id: ctx.ids(), text: input.text },
        ...this.referenceParts(input.references),
      ],
    };
    await ctx.chats.emit(chatId, { type: "message.appended", message });
    await ctx.chats.refreshLinkedSites(chatId);
    run.editing?.noteUserRequest(input.text);
    if (ctx.active !== run || run.finalizing) {
      throw new RuntimeError("turn_not_active", "Turn is no longer active", 409);
    }
    const rendered = renderPromptContext(
      input.text,
      input.editorContext,
      input.references,
      input.userLanguage,
      { editorJson: "relevant" },
    );
    // A project attached by this steering joins the chat's attachments at once (access reads the messages): its
    // manifest rides on the steering the way the first prompt carries it.
    const attachedKeys = (input.references ?? []).flatMap((reference) =>
      reference.kind === "project" ? [reference.projectKey] : [],
    );
    const attachedBlock =
      run.crossProject && attachedKeys.length > 0
        ? await run.crossProject.promptBlock({
            onlyKeys: attachedKeys,
            offered: run.crossProjectOffered,
          })
        : "";
    if (ctx.active !== run || run.finalizing) {
      throw new RuntimeError("turn_not_active", "Turn is no longer active", 409);
    }
    const text = attachedBlock ? `${rendered}\n\n${attachedBlock}` : rendered;
    const queue = () => {
      run.pendingSteering.push(text);
      run.orchestrator?.notifySteer();
    };
    const session = run.session;
    if (!session || !run.firstPromptSent || run.directorIdle) {
      queue();
      return messageId;
    }
    try {
      await session.steer(text);
      // A Director blocked in wait_for_agents returns now, so the instruction reaches it promptly.
      run.orchestrator?.notifySteer();
    } catch {
      // The model could not take it mid-prompt: it opens the next prompt instead of ending the turn.
      queue();
    }
    return messageId;
  }

  abort(chatId: string, turnId: string): void {
    const run = this.ctx.active;
    if (run && run.chatId === chatId && run.turn.id === turnId && !run.finalizing)
      run.controller.abort();
  }

  /** The running turn of a chat, for the answer and cancel routes; unknown chat/turn are 404, anything else 409. */
  private activeRunOf(chatId: string, turnId: string): ActiveRun {
    const state = this.ctx.chats.get(chatId);
    if (!state) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    if (!state.turns.some((turn) => turn.id === turnId))
      throw new RuntimeError("turn_not_found", "Turn was not found", 404);
    const run = this.ctx.active;
    if (!run || run.chatId !== chatId || run.turn.id !== turnId || run.finalizing)
      throw new RuntimeError("turn_not_active", "Turn is not active", 409);
    return run;
  }

  /**
   * The user's answer to a permission request of the running turn (the chat's "Allow once" / "Turn on" / "Don't
   * allow"): the request is published in its new state and the tool call waiting on it resumes. Unknown chat or turn
   * are `chat_not_found` / `turn_not_found`; a turn that is not running, or a request that is no longer pending, is
   * `turn_not_active`. When Studio cannot apply an `always` or `once` answer the request stays pending and the
   * failure is answered, so the user can retry.
   */
  async answerPermission(
    chatId: string,
    turnId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<AnswerPermissionResponse> {
    const run = this.activeRunOf(chatId, turnId);
    if (!run.permissions) throw new RuntimeError("turn_not_active", "Turn is not active", 409);
    return { permission: await run.permissions.answer(permissionId, decision) };
  }

  /** The user's answer to a question an agent asked mid-turn (`request_input`): the waiting call resumes with it. */
  async answerQuestion(
    chatId: string,
    turnId: string,
    questionId: string,
    answer: string,
  ): Promise<AnswerQuestionResponse> {
    const run = this.activeRunOf(chatId, turnId);
    if (!run.questions) throw new RuntimeError("turn_not_active", "Turn is not active", 409);
    return { question: await run.questions.answer(questionId, answer) };
  }

  /** The user stops one delegated run of the running turn; the turn and the other runs go on. */
  async cancelRun(
    chatId: string,
    turnId: string,
    runId: string,
    reason?: string,
  ): Promise<CancelRunResponse> {
    const run = this.activeRunOf(chatId, turnId);
    if (!run.orchestrator) throw new RuntimeError("turn_not_active", "Turn is not active", 409);
    return { run: await run.orchestrator.cancelRun(runId, reason) };
  }

  answerStoryOffer(
    chatId: string,
    turnId: string,
    offerId: string,
    decision: StoryOfferDecision,
    signal?: AbortSignal,
  ): Promise<AnswerStoryOfferResponse> {
    return answerStoryOffer(this.ctx, chatId, turnId, offerId, decision, signal);
  }

  revert(chatId: string, turnId: string, mode?: RevertMode): Promise<RevertTurnResponse> {
    return revertTurn(this.ctx, chatId, turnId, mode);
  }

  unrevert(chatId: string, turnId: string, mode?: RevertMode): Promise<RevertTurnResponse> {
    return unrevertTurn(this.ctx, chatId, turnId, mode);
  }

  recoverCheckpoints(): Promise<void> {
    return recoverCheckpoints(this.ctx);
  }

  /**
   * Removes a chat and everything stored for it. Refused while the chat runs a turn, is being reverted or is already
   * being deleted; the chat is reserved before the first await, so a turn or revert cannot start on it meanwhile.
   */
  async deleteChat(chatId: string): Promise<DeleteChatResponse> {
    const ctx = this.ctx;
    if (!ctx.chats.get(chatId)) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    const busy = busyError(ctx, chatId);
    // Another chat's turn does not stand in the way of removing this one.
    if (busy?.code === "chat_busy") throw busy;
    ctx.deletingChats.add(chatId);
    try {
      await ctx.sessions.disposeChat(chatId);
      await ctx.chats.delete(chatId);
      ctx.recoverChats.delete(chatId);
      for (const key of [...ctx.runSlots.keys()]) {
        if (key.startsWith(`${chatId}|`)) ctx.runSlots.delete(key);
      }
    } finally {
      ctx.deletingChats.delete(chatId);
    }
    return { chatId };
  }

  /**
   * The approved proposal an execute turn carries out: the request names the turn whose plan the user approved.
   * Missing or unproposed turns are refused; the steps are the proposal's own, so a revise turn cannot change them.
   */
  private resolveExecutePlan(chatState: ChatState, input: StartTurnRequest): ExecutePlan | null {
    const requested = input.executePlan;
    if (!requested) return null;
    const source = chatState.turns.find((turn) => turn.id === requested.turnId);
    const steps = source?.plan?.proposal ? source.plan.steps : null;
    if (!steps || steps.length === 0)
      throw new RuntimeError(
        "invalid_request",
        "That turn has no plan proposal to carry out; propose one first",
        400,
      );
    const projectFingerprint = source?.plan?.projectFingerprint;
    return {
      turnId: requested.turnId,
      steps,
      ...(projectFingerprint !== undefined && { projectFingerprint }),
    };
  }

  async dispose(): Promise<void> {
    const active = this.ctx.active;
    if (active) {
      active.controller.abort();
      await active.task?.catch(() => undefined);
    }
    await this.ctx.sessions.dispose();
    // The turn's fire-and-forget `onModel` updates may still be appending when the run ended: await them before the
    // caller deletes the project directory, or the write races the removal (ENOENT/ENOTEMPTY on Windows).
    await this.ctx.chats.drain();
  }

  /** Heartbeat: keeps the turn's transaction open for the whole turn, however long it pauses between writes. */
  private scheduleRenew(run: ActiveRun): void {
    run.heartbeat = this.ctx.timers.setTimeout(
      () => void this.renew(run),
      this.ctx.renewIntervalMs,
    );
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

  /** Resolves the Director's model and the team for a new turn. Never throws: missing data means defaults. */
  private async prepareTurn(
    chat: ChatSummary,
    input: StartTurnRequest,
  ): Promise<{
    setup: TurnAgentSetup;
    model: TurnSummary["model"];
    thinking: TurnSummary["thinking"];
  }> {
    const { settings, backend, options } = this.ctx;
    const current = await settings.get();
    const jevApiKey = await settings.jevApiKey();
    let catalog: AgentModelCatalog = { models: [], defaultModel: null, defaultThinking: null };
    let catalogKnown = true;
    try {
      catalog = await backend.listModels();
    } catch {
      // No catalog: routing to other models and provider-login Jev are unavailable this turn; defaults still run.
      catalogKnown = false;
    }
    return {
      setup: resolveTurnSetup({
        qaAvailable: options.qa !== undefined && options.editing !== undefined,
        chat,
        settings: current,
        jevApiKey,
        catalog,
        catalogKnown,
        ...(input.editorContext && { editorContext: input.editorContext }),
        ...(input.userLanguage && { userLanguage: input.userLanguage }),
      }),
      model: chat.mainAgentModel ?? current.director.model,
      thinking: chat.thinking ?? current.director.thinking,
    };
  }
}
