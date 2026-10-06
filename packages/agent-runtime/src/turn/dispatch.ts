import type { AgentId, StoryOffer } from "@hyperframes/agent-protocol";
import type { HostToolResult, ToolProgress } from "../backend.js";
import { withCallerRun } from "../agents/callerRun.js";
import { TOOL_NAMES } from "../agents/tools.js";
import { designToolsFor, isDesignToolName } from "../design/tools.js";
import { parseQuestionArgs, parseStoryOfferArgs } from "../agents/toolArgs.js";
import { isAnalysisToolName } from "../analysis/tools.js";
import { isLockRefusal, lockedEditAdvice } from "../autonomy.js";
import { isCrossProjectToolName } from "../crossProject/tools.js";
import { isEditingToolName } from "../editing/tools.js";
import { framesToolsFor, isFramesToolName } from "../editing/frames.tools.js";
import { changesProject, intentRefusal, savesWebsiteFiles } from "../intent.js";
import { qaPhaseRefusal } from "../qa/phase.js";
import { isQaToolName } from "../qa/tools.js";
import { isResearchToolName } from "../research/tools.js";
import {
  STORY_TOOL_NAMES,
  isStoryToolName,
  storyToolsFor,
  timelineWritesAllowed,
} from "../story/tools.js";
import {
  DESIGN_TURN_REFUSAL,
  STORY_TURN_TIMELINE_REFUSAL,
  writesTimeline,
} from "../turnSupport.js";
import type { ActiveRun, TurnContext } from "./context.js";
import {
  askBeforeLockedEdits,
  phaseGateRefusal,
  planProposalOffered,
  planProposed,
} from "./gates.js";

const refuse = (text: string): HostToolResult => ({ text, isError: true });

/**
 * Host tools are bound to a session for many turns; each call goes to the orchestrator of the running turn. `runId` is
 * the delegated run the calling session serves: the call runs as that run, so a specialist with two runs going, or a
 * specialist and the Jev run it started, are never mixed up. A refusal the editing or story service made because of a
 * lock or a user decision carries the user's instruction for such items (stop and ask, or leave it and report; see
 * autonomy.ts). The whole call is tracked as in flight, so neither the Director's prompt watchdog nor a run's progress
 * watchdog fires while a tool works (a render, an analysis job, a question to the user).
 */
export async function dispatchTool(
  ctx: TurnContext,
  chatId: string,
  caller: AgentId,
  name: string,
  args: unknown,
  signal: AbortSignal,
  progress?: ToolProgress,
  runId: string | null = null,
): Promise<HostToolResult> {
  const run = ctx.active;
  const watchdog = caller === "director" && run?.chatId === chatId ? run.watchdog : null;
  watchdog?.hold();
  try {
    if (run && run.chatId === chatId && attemptsWork(name, args)) run.workAttempted = true;
    const call = () => dispatchToolCall(ctx, chatId, caller, name, args, signal, progress);
    const result = await withCallerRun(runId, () =>
      run?.orchestrator ? run.orchestrator.trackToolCall(caller, call) : call(),
    );
    const active = ctx.active;
    if (active?.chatId === chatId) active.changes.noteToolCall(name, args, result);
    if (!result.isError || !isLockRefusal(result.text)) return result;
    return {
      ...result,
      text: `${result.text}\n\n${lockedEditAdvice(askBeforeLockedEdits(ctx, chatId))}`,
    };
  } finally {
    watchdog?.release();
  }
}

async function dispatchToolCall(
  ctx: TurnContext,
  chatId: string,
  caller: AgentId,
  requested: string,
  args: unknown,
  signal: AbortSignal,
  progress?: ToolProgress,
): Promise<HostToolResult> {
  const run = ctx.active;
  if (!run || run.chatId !== chatId || run.finalizing)
    return refuse("There is no running turn for this tool call.");
  // Every host tool binds its own exact name, so `requested` is always one of ours.
  const name = requested;
  const refusal =
    qaPhaseRefusal(run.qaPhase, name, args) ??
    intentRefusal(
      run.intent,
      name,
      run.turn.plan?.proposal === true,
      run.storyOffer !== null,
      args,
    ) ??
    phaseGateRefusal(
      {
        qaPhase: run.qaPhase,
        planProposed: planProposed(run),
        storyOffered: run.storyOffer !== null,
        designUnsaved: run.designAction !== null && !(run.design?.hasSaved() ?? false),
      },
      name,
    );
  if (refusal) return refuse(refusal);
  // A reused session keeps its old tool list: propose_plan is refused unless this turn actually offers it.
  if (name === TOOL_NAMES.propose && (caller !== "director" || !planProposalOffered(run)))
    return refuse(
      "Proposing a plan is not available in this turn: do the work, or finish with your reply.",
    );
  if (name === TOOL_NAMES.offerStory) return offerStory(ctx, run, caller, args);
  if (name === TOOL_NAMES.input) return askUser(run, caller, args, signal);
  if (isQaToolName(name)) {
    if (!run.qa) return refuse("Render QA is not available in this runtime.");
    return run.qa.execute(caller, name, args, signal);
  }
  if (isResearchToolName(name)) {
    if (!run.research) return refuse("Research is not available in this runtime.");
    return run.research.execute(caller, name, args, signal);
  }
  if (isCrossProjectToolName(name)) {
    if (!run.crossProject)
      return refuse("Copying from other projects is not available in this runtime.");
    return run.crossProject.execute(caller, name, args, signal);
  }
  if (isStoryToolName(name)) {
    if (!run.story) return refuse("Story Mode is not available in this runtime.");
    // A design turn changes the design library only: the story is read, never edited or built.
    if (run.designAction !== null && name !== STORY_TOOL_NAMES.read)
      return refuse(DESIGN_TURN_REFUSAL);
    const allowed = storyToolsFor(caller, run.setup?.enabled ?? [], {
      mode: run.mode,
      action: run.storyAction,
    });
    if (!allowed.some((tool) => tool === name))
      return refuse(`${name} is not available to you in this turn.`);
    return run.story.execute(name, args, signal);
  }
  if (isDesignToolName(name)) {
    if (!run.design) return refuse("Design systems are not available in this turn.");
    const allowed = designToolsFor(caller, { action: run.designAction });
    if (!allowed.some((tool) => tool === name))
      return refuse(`${name} is not available to you in this turn.`);
    return run.design.execute(name, args, signal);
  }
  if (run.designAction !== null && writesTimeline(name)) return refuse(DESIGN_TURN_REFUSAL);
  if (!timelineWritesAllowed({ mode: run.mode, action: run.storyAction }) && writesTimeline(name))
    return refuse(STORY_TURN_TIMELINE_REFUSAL);
  if (isEditingToolName(name)) {
    if (!run.editing) return refuse("Editing is not available in this runtime.");
    return run.editing.execute(name, args, signal, progress, caller);
  }
  if (isFramesToolName(name)) {
    if (!run.frames) return refuse("Composition frames are not available in this runtime.");
    const allowed = framesToolsFor(caller, run.setup?.enabled ?? []);
    if (!allowed.some((tool) => tool === name))
      return refuse(`${name} is not available to you in this turn.`);
    return run.frames.execute(name, args, signal);
  }
  if (isAnalysisToolName(name)) {
    if (!run.analysis) return refuse("Analysis is not available in this runtime.");
    return run.analysis.execute(name, args, signal, progress);
  }
  if (!run.orchestrator) return refuse("There is no running turn for this tool call.");
  return run.orchestrator.execute(caller, name, args, signal);
}

async function offerStory(
  ctx: TurnContext,
  run: ActiveRun,
  caller: AgentId,
  args: unknown,
): Promise<HostToolResult> {
  if (caller !== "director" || !run.storyOfferEligible)
    return refuse(
      "Offering Story Mode is not available in this turn: do the work, or finish with your reply.",
    );
  if (run.storyOffer)
    return refuse(
      "Story Mode is already offered in this turn: end it with a short reply about the offer.",
    );
  const parsed = parseStoryOfferArgs(args);
  if (!parsed.ok) return refuse(parsed.message);
  const offer: StoryOffer = {
    id: ctx.ids(),
    chapters: parsed.value.chapters,
    state: "pending",
    requestedAt: ctx.now(),
  };
  run.storyOffer = offer;
  await ctx.chats.emit(run.chatId, {
    type: "storyOffer.updated",
    messageId: run.assistantMessage.id,
    offer,
  });
  return {
    text: `The Story Mode offer with ${offer.chapters.length} chapters is on screen: the user can open the Story workspace or decline (labelled in the user's language; do not quote button names). Every project-changing tool is refused for the rest of this turn — write one or two sentences about what the story would do with these chapters, in the user's language, and end the turn.`,
  };
}

/**
 * `request_input`: the question is shown in the chat and the call waits for the user's answer, the end of the turn, or
 * the cancelling of the run that asked (which expires this question alone).
 */
async function askUser(
  run: ActiveRun,
  caller: AgentId,
  args: unknown,
  signal: AbortSignal,
): Promise<HostToolResult> {
  if (caller === "jev") return refuse("request_input is not available to you.");
  if (!run.questions) return refuse("Asking the user is not available in this runtime.");
  const parsed = parseQuestionArgs(args);
  if (!parsed.ok) return refuse(parsed.message);
  const answered = await run.questions.ask(
    { agent: caller, text: parsed.value.question, options: parsed.value.options },
    signal,
  );
  if (answered.state === "answered" && answered.answer !== undefined)
    return { text: `The user answered: ${answered.answer}` };
  return refuse(
    "The user did not answer before the question ended (the turn finished or this task was stopped). Carry on with your best judgement and say in your report what you assumed.",
  );
}

/** Whether a call is an attempt to change the project or start work that could (a delegation counts). */
function attemptsWork(name: string, args: unknown): boolean {
  return (
    changesProject(name) ||
    savesWebsiteFiles(name, args) ||
    name === TOOL_NAMES.delegate ||
    name === TOOL_NAMES.message ||
    name === TOOL_NAMES.jev
  );
}
