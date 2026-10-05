import type { SpecialistId, StartTurnRequest } from "@hyperframes/agent-protocol";
import type { TurnAgentSetup } from "../agents/orchestrator.js";
import { renderTeam } from "../agents/setup.js";
import { renderExecutePlanBlock, renderIntentBlock, renderPlanApprovalBlock } from "../intent.js";
import {
  renderCanvasAutoBlock,
  renderCanvasAutoPlanBlock,
  renderPromptContext,
} from "../promptContext.js";
import { renderInterimInstruction } from "../qa/prompt.js";
import { renderRevertedTurns, revertedSinceLastPrompt } from "../revertedTurns.js";
import { renderStoryBlocks } from "../story/prompt.js";
import { renderStoryDeclinedBlock, renderStoryOfferBlock } from "../storyOffer.js";
import type { ActiveRun, TurnContext } from "./context.js";
import { planProposalOffered } from "./gates.js";

/** How steering the Director got while it could not take it is shown on its next prompt. */
export function renderSteeringBlocks(texts: readonly string[]): string[] {
  return texts.map((text) => `<user-steering>\n${text}\n</user-steering>`);
}

/** What the story-mode blocks of the turn's prompt are made from. */
async function storyBlockInput(run: ActiveRun, setup: TurnAgentSetup) {
  const story = run.story;
  if (!story) throw new Error("The turn has no story tools.");
  const snapshot = await story.snapshot(run.controller.signal);
  return {
    action: run.storyAction,
    editorEnabled: setup.enabled.includes("editor"),
    researchEnabled: setup.enabled.includes("research"),
    storyOptions: run.storyOptions,
    graph: snapshot.graph,
    view: snapshot.view,
    researchReady: run.research !== null,
  };
}

/**
 * The Director's first prompt of a turn: the team, the user's message with the editor context (the one place the full
 * context JSON goes), and the blocks that say what this turn is — Ask, plan approval or an approved plan (stale or
 * not), a Story Mode offer, the format still open, story-mode rules, reverted turns, the interim-report rule. Steering
 * that arrived during setup rides along at the end.
 */
export async function buildFirstPrompt(
  ctx: TurnContext,
  run: ActiveRun,
  setup: TurnAgentSetup,
  input: StartTurnRequest,
  flags: {
    qaWillApply: boolean;
    planStale: boolean;
    /** The tools the turn gives the Director for the work of a specialist that is off. */
    inheritedTools: (specialist: SpecialistId) => readonly string[];
  },
): Promise<string> {
  const intentBlock = renderIntentBlock(run.intent);
  // An execute turn carries the approved steps; a turn that may propose carries when to propose. Never both.
  const planBlocks = run.executePlan
    ? `\n\n${renderExecutePlanBlock(run.executePlan.steps, flags.planStale)}`
    : planProposalOffered(run)
      ? `\n\n${renderPlanApprovalBlock(run.planApproval)}`
      : "";
  // The frame format is still open (the project was started with it on Auto): every turn of that chat carries a
  // canvas instruction until a successful edit sets it — a turn that acts sets it, an Ask turn states the choice.
  const canvasAuto =
    input.canvas === "auto" || (ctx.chats.get(run.chatId)?.chat.canvasAuto ?? false);
  const canvasBlock = canvasAuto
    ? `\n\n${run.intent === "edit" ? renderCanvasAutoBlock() : renderCanvasAutoPlanBlock()}`
    : "";
  const storyBlocks =
    run.mode === "story" && run.story
      ? `\n\n${renderStoryBlocks(await storyBlockInput(run, setup))}`
      : "";
  // The turn may offer Story Mode (the tool is there): its block says when that is what the user's request is, and
  // takes precedence over the plan-approval block. A chat that already declined one is told so in words.
  const offerBlocks = run.storyOfferEligible ? `\n\n${renderStoryOfferBlock()}` : "";
  const chatState = ctx.chats.get(run.chatId);
  const declinedBlocks =
    chatState?.chat.storyDeclined === true && run.mode === "normal"
      ? `\n\n${renderStoryDeclinedBlock()}`
      : "";
  // Earlier turns the user reverted since the Director's session last saw this chat: their edits are gone.
  const revertedBlock = chatState
    ? renderRevertedTurns(
        revertedSinceLastPrompt(chatState.turns, chatState.messages, run.turn.id),
        ctx.now(),
      )
    : "";
  const revertedBlocks = revertedBlock ? `\n\n${revertedBlock}` : "";
  const steering = renderSteeringBlocks(run.pendingSteering.splice(0));
  const steeringBlocks = steering.length > 0 ? `\n\n${steering.join("\n\n")}` : "";
  return `${renderTeam(setup, run.storyAction, flags.inheritedTools)}\n\n${renderPromptContext(input.prompt, input.editorContext, input.references, input.userLanguage, { editorJson: "full" })}${intentBlock ? `\n\n${intentBlock}` : ""}${planBlocks}${offerBlocks}${declinedBlocks}${canvasBlock}${storyBlocks}${revertedBlocks}${flags.qaWillApply ? `\n\n${renderInterimInstruction()}` : ""}${steeringBlocks}`;
}
