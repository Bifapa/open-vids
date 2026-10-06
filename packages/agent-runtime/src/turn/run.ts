import type { BackendPromptOutcome } from "../backend.js";
import type { StartTurnRequest } from "@hyperframes/agent-protocol";
import { Orchestrator } from "../agents/orchestrator.js";
import { inheritedToolsOf } from "../agents/tools.js";
import { QaLoop, qaApplies } from "../qa/loop.js";
import { renderInterimInstruction } from "../qa/prompt.js";
import { TurnEventWriter } from "../turnStream.js";
import type { ActiveRun, TurnContext } from "./context.js";
import { finalizeTurn } from "./finalize.js";
import { buildFirstPrompt, renderSteeringBlocks } from "./prompt.js";
import { agentSession, jevSession } from "./sessions.js";
import { openTurnTools } from "./executors.js";
import { PromptWatchdog, stallMessage } from "./watchdog.js";

/** How many times the Director is re-prompted with results of runs it finished without collecting. */
const MAX_FOLLOW_UPS = 3;

/**
 * Runs one turn to its end: opens the turn's services, prompts the Director, keeps re-prompting it with the results
 * of delegated runs and with steering it could not take, runs render QA, and finalizes. A Stop at any point of the
 * setup ends the turn there, before the next expensive step.
 */
export async function runTurn(
  ctx: TurnContext,
  run: ActiveRun,
  input: StartTurnRequest,
): Promise<void> {
  let writer: TurnEventWriter | null = null;
  try {
    const setup = run.setup;
    if (!setup) throw new Error("The turn has no agent setup.");
    const signal = run.controller.signal;
    /** True when the turn is already over (finalized elsewhere, or stopped by the user): setup goes no further. */
    const over = async (): Promise<boolean> => {
      if (run.finalizing) return true;
      if (!signal.aborted) return false;
      if (run.forcedError) await finalizeTurn(ctx, run, "failed", run.forcedError);
      else await finalizeTurn(ctx, run, "aborted");
      return true;
    };
    if (await over()) return;

    const tools = await openTurnTools(ctx, run, setup, input);
    if (await over()) return;
    const { editingHost, availability } = tools;
    const qa = run.qa;
    // What the project is when the turn starts: render QA runs only when the turn changed it, and an approved plan is
    // stale when the project is no longer what it was when the plan was proposed.
    const startFingerprint = qa ? await qa.fingerprint(signal).catch(() => null) : null;
    const startTimeline =
      qa && editingHost ? await editingHost.timeline(undefined, signal).catch(() => null) : null;
    if (await over()) return;
    const proposedAt = run.executePlan?.projectFingerprint;
    const planStale =
      proposedAt !== undefined && startFingerprint !== null && startFingerprint !== proposedAt;

    const session = await agentSession(ctx, run.chatId, "director", availability);
    if (await over()) return;
    run.session = session;
    const inheritedTools = inheritedToolsOf(availability);
    const orchestrator = new Orchestrator({
      chats: ctx.chats,
      chatId: run.chatId,
      turn: run.turn,
      directorMessageId: run.assistantMessage.id,
      setup,
      inheritedTools,
      signal,
      now: ctx.now,
      ids: ctx.ids,
      timers: ctx.timers,
      leases: ctx.leases,
      stallMs: ctx.promptStallMs,
      ...(ctx.options.stopGraceMs !== undefined && { stopGraceMs: ctx.options.stopGraceMs }),
      specialistSession: (agent, parallel, runId) =>
        agentSession(ctx, run.chatId, agent, availability, { id: runId, parallel }),
      jevSession: (runId) => jevSession(ctx, run.chatId, setup, availability, runId),
      closeSpecialist: (agent) => ctx.sessions.disposeAgent(run.chatId, agent),
      projectFingerprint: qa
        ? (callSignal) => qa.fingerprint(callSignal).catch(() => null)
        : undefined,
    });
    run.orchestrator = orchestrator;
    const activeWriter = new TurnEventWriter({
      chats: ctx.chats,
      chatId: run.chatId,
      messageId: run.assistantMessage.id,
      turn: run.turn,
      runId: null,
      now: ctx.now,
      ids: ctx.ids,
      timers: ctx.timers,
      onModel: (event) => {
        run.turn.model = event.model;
        run.turn.thinking = event.thinking;
      },
    });
    writer = activeWriter;
    // A model that goes silent for too long ends the turn with a clear error instead of hanging it.
    const watchdog = new PromptWatchdog(ctx.timers, ctx.promptStallMs, (idleMs) => {
      run.forcedError ??= new Error(stallMessage(idleMs));
      run.controller.abort();
    });
    run.watchdog = watchdog;
    const promptDirector = async (text: string): Promise<BackendPromptOutcome> => {
      watchdog.arm();
      try {
        return await session.prompt({
          text,
          model: run.turn.model,
          thinking: run.turn.thinking,
          signal,
          onEvent: (event) => {
            watchdog.touch();
            activeWriter.accept(event);
          },
        });
      } finally {
        watchdog.disarm();
      }
    };
    /** A Director prompt after the first: the reply starts a new part of the same message. */
    const promptAgain = async (text: string): Promise<BackendPromptOutcome> => {
      run.directorIdle = false;
      activeWriter.startPrompt();
      const outcome = await promptDirector(text);
      run.directorIdle = true;
      return outcome;
    };
    /**
     * The Director must hear back from every run it started, and from steering it could not take while it worked: while
     * either is pending it is re-prompted (a bounded number of times) until it finishes with a reply.
     */
    const settleDirector = async (
      first: BackendPromptOutcome,
      beforeQa = false,
    ): Promise<BackendPromptOutcome> => {
      let outcome = first;
      let followUps = 0;
      while (
        outcome === "completed" &&
        !run.forcedError &&
        !signal.aborted &&
        followUps < MAX_FOLLOW_UPS &&
        (run.pendingSteering.length > 0 || orchestrator.hasUnreported())
      ) {
        const results =
          run.pendingSteering.length > 0 ? "" : await orchestrator.collectUnreported(signal);
        if (signal.aborted) break;
        const steering = run.pendingSteering.splice(0);
        if (steering.length === 0) followUps += 1;
        const blocks = [
          results &&
            `<delegated-results>\n${results}\n</delegated-results>\nThese delegated runs reported after your last reply.`,
          ...renderSteeringBlocks(steering),
          "Continue: adjust the plan and delegated work if needed, wait for any runs still working, then finish the user's request with a short reply.",
          beforeQa && renderInterimInstruction(),
        ].filter(Boolean);
        outcome = await promptAgain(blocks.join("\n\n"));
      }
      return outcome;
    };
    // Render QA will apply to this turn (it runs only if the project changed): every Director reply before it is interim.
    // A design turn writes the library, never a composition, so there is nothing to render and check.
    const qaWillApply =
      run.intent === "edit" &&
      run.designAction === null &&
      qa !== null &&
      editingHost !== null &&
      setup.execution.budget.qaPasses > 0 &&
      qaApplies(run.mode, run.storyAction);
    const firstPrompt = await buildFirstPrompt(ctx, run, setup, input, {
      qaWillApply,
      planStale,
      inheritedTools,
    });
    if (await over()) return;
    run.firstPromptSent = true;
    let outcome = await promptDirector(firstPrompt);
    run.directorIdle = true;
    outcome = await settleDirector(outcome, qaWillApply);

    // The Director's work is done: render QA renders, checks and (while passes are left) has the Director correct.
    if (
      run.intent === "edit" &&
      run.designAction === null &&
      qa &&
      editingHost &&
      outcome === "completed" &&
      !run.forcedError &&
      !signal.aborted
    ) {
      outcome = await new QaLoop({
        chats: ctx.chats,
        chatId: run.chatId,
        turn: run.turn,
        qa,
        editing: editingHost,
        renders: {
          // A render the user asked for in words or allowed on the long-render card is wanted: QA renders it too.
          asked: () =>
            (run.editing?.userAskedForRender() ?? false) ||
            (run.permissions?.allowsKind("long_render") ?? false),
          last: () => run.editing?.lastRender() ?? null,
        },
        orchestrator,
        setup,
        mode: run.mode,
        action: run.storyAction,
        startFingerprint,
        startTimeline,
        workAttempted: () => run.workAttempted,
        instructed: qaWillApply,
        director: {
          prompt: promptAgain,
          settle: (after) => settleDirector(after),
          markInterim: () => activeWriter.markTextInterim(),
          takeSteering: () => run.pendingSteering.splice(0),
          setPhase: (phase) => {
            run.qaPhase = phase;
          },
        },
        signal,
        now: ctx.now,
      }).run(outcome);
    }

    if (run.forcedError) {
      await activeWriter.finish("failed");
      await finalizeTurn(ctx, run, "failed", run.forcedError);
    } else if (outcome === "aborted" || signal.aborted) {
      await activeWriter.finish("aborted");
      await finalizeTurn(ctx, run, "aborted");
    } else {
      await activeWriter.finish("complete");
      await finalizeTurn(ctx, run, "completed");
    }
  } catch (error) {
    await writer?.finish("failed").catch(() => undefined);
    if (run.controller.signal.aborted && !run.forcedError) await finalizeTurn(ctx, run, "aborted");
    else await finalizeTurn(ctx, run, "failed", run.forcedError ?? error);
  }
}

export type { ActiveRun };
