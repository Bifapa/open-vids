import { isChapter } from "@hyperframes/agent-protocol";
import { TOOL_NAMES } from "../agents/tools.js";
import { intentRefusal } from "../intent.js";
import { HEAVY_ANALYSIS } from "../qa/phase.js";
import { timelineWritesAllowed } from "../story/tools.js";
import { STORY_TURN_TIMELINE_REFUSAL, writesProjectFiles } from "../turnSupport.js";
import type { ActiveRun, TurnContext } from "./context.js";

/** Whether the running turn's Director may propose a plan (the prompt block and `propose_plan` go together). */
export function planProposalOffered(run: ActiveRun): boolean {
  return (
    run.intent === "edit" &&
    run.mode !== "story" &&
    run.executePlan === null &&
    run.planApproval !== "never"
  );
}

/** Whether the running turn already published a plan proposal (everything project-changing is refused then). */
export function planProposed(run: ActiveRun): boolean {
  return run.turn.plan?.proposal === true;
}

/**
 * Whether the turn may offer Story Mode: an ordinary Edit turn (not a story-mode or execute-plan one), in a chat
 * that has not declined an offer, while the project's Story graph has no chapters. False when the story could not
 * be read — the accept would fail the same way.
 */
export async function storyOfferOpen(
  ctx: TurnContext,
  run: ActiveRun,
  signal: AbortSignal,
): Promise<boolean> {
  if (!run.story || run.mode !== "normal" || run.intent !== "edit" || run.executePlan !== null)
    return false;
  if (ctx.chats.get(run.chatId)?.chat.storyDeclined === true) return false;
  const snapshot = await run.story.snapshot(signal);
  if (snapshot.view === null) return false;
  return !(snapshot.view.graph?.nodes.some(isChapter) ?? false);
}

/** What the phase rules look at: Render QA's phase and whether the turn already proposed a plan or offered Story Mode. */
export interface PhaseState {
  qaPhase: ActiveRun["qaPhase"];
  planProposed: boolean;
  storyOffered: boolean;
}

/**
 * Phase rules for the tools that steer the turn itself. A plan proposal and a Story Mode offer each end the turn's
 * changes, so neither may follow the other, and neither belongs in Render QA (a proposal there would wedge the
 * corrections and contradict the final report). The final report starts no analysis job, and Render QA asks no
 * questions of its own. Null when the call may go on to the tool-specific checks.
 */
export function phaseGateRefusal(state: PhaseState, name: string): string | null {
  if (name === TOOL_NAMES.propose || name === TOOL_NAMES.offerStory) {
    if (state.qaPhase !== null)
      return `Render QA is checking the result: ${name} is not available now. Finish the corrections or the final report.`;
    if (name === TOOL_NAMES.offerStory && state.planProposed)
      return "This turn already published a plan proposal and nothing in the project changes until the user approves it, so Story Mode cannot be offered now. End the turn with a short summary of the plan.";
    if (name === TOOL_NAMES.propose && state.storyOffered)
      return "Story Mode is already offered in this turn, so a plan cannot be proposed now. End the turn with a short reply about the offer.";
  }
  if (name === TOOL_NAMES.input && state.qaPhase !== null)
    return "Render QA is checking the result: asking the user is not available now. Use your best judgement and say what you assumed in your report.";
  if (state.qaPhase === "final" && HEAVY_ANALYSIS[name])
    return `Render QA is over and the Director is writing the final report: ${name} is refused now. Report what was done and what QA found.`;
  return null;
}

/**
 * The harness's own file writes (edit/write) follow the same per-turn rules as the host tools: refused in an Ask
 * turn and after a plan or story offer (intent), once Render QA has taken over (the final report must describe a state
 * QA checked), and in a story-mode turn that does not build (the timeline is composition HTML these tools could
 * rewrite behind the story's rules). Counting a write for the turn's change summary is {@link noteFileWrite}'s job, once
 * the whole guard chain has let it through.
 */
export function fileWriteRefusal(
  ctx: TurnContext,
  chatId: string,
  toolName: string,
): string | null {
  const run = ctx.active;
  if (!run || run.chatId !== chatId) return null;
  const intent = intentRefusal(run.intent, toolName, planProposed(run), run.storyOffer !== null);
  if (writesProjectFiles(toolName)) run.workAttempted = true;
  if (intent || !writesProjectFiles(toolName)) return intent;
  if (run.qaPhase === "final" || run.qaPhase === "review") {
    return `Render QA is ${run.qaPhase === "review" ? "reviewing the render" : "over and the Director is writing the final report"}: ${toolName} is refused now. Nothing may be edited, delegated, imported, built or rendered any more; report what was done and what QA found.`;
  }
  if (!timelineWritesAllowed({ mode: run.mode, action: run.storyAction }))
    return STORY_TURN_TIMELINE_REFUSAL;
  return null;
}

/** A harness file write (`edit`/`write`) passed every check of the tool guard: it counts in the turn's change summary. */
export function noteFileWrite(ctx: TurnContext, chatId: string, toolName: string): void {
  const run = ctx.active;
  if (run && run.chatId === chatId && writesProjectFiles(toolName)) run.changes.noteFileWrite();
}

/** The user's "ask before changing locked sections" setting for the turn that is running (true when none is). */
export function askBeforeLockedEdits(ctx: TurnContext, chatId: string): boolean {
  const run = ctx.active;
  if (!run || run.chatId !== chatId) return true;
  return run.setup?.autonomy.askBeforeLockedEdits ?? true;
}
