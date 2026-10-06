import type { ChatState, ExecutionPlan, PlanStep, TurnSummary } from "@hyperframes/agent-protocol";
import { runningTurn } from "./agentSelectors";
import { carriedOutProposalIds } from "./retryTurn";

/** A turn with a plan that has steps: what the pinned dock can show. */
export type PlanTurn = TurnSummary & { plan: ExecutionPlan };

function hasSteps(turn: TurnSummary): turn is PlanTurn {
  return (turn.plan?.steps.length ?? 0) > 0;
}

/**
 * A finished plan proposal still waiting for the user: not carried out by a later turn (`carriedOut`, from
 * `carriedOutProposalIds`). Offered with "Carry out" / "Change" — "Carry out anyway" once other turns ran after it.
 */
export function awaitsApproval(
  turn: TurnSummary,
  carriedOut: ReadonlySet<string>,
): turn is PlanTurn {
  return turn.plan?.proposal === true && turn.status === "completed" && !carriedOut.has(turn.id);
}

/**
 * The turn whose plan the chat pins above the conversation: the running turn's plan, else the newest proposal
 * still waiting for the user. A running turn that has no steps yet keeps an older waiting proposal in place
 * (its buttons are disabled meanwhile) rather than handing it back to the feed for a moment. Null when there is
 * nothing to pin; the plan of a turn that ended stays in the feed.
 */
export function dockedPlanTurn(chat: ChatState): PlanTurn | null {
  const running = runningTurn(chat);
  if (running && hasSteps(running)) return running;
  const carriedOut = carriedOutProposalIds(chat);
  for (let index = chat.turns.length - 1; index >= 0; index -= 1) {
    const turn = chat.turns[index];
    if (turn && awaitsApproval(turn, carriedOut) && hasSteps(turn)) return turn;
  }
  return null;
}

/** The step the Director is on, with its place in the plan; null when none is running. */
export function currentPlanStep(
  steps: readonly PlanStep[],
): { index: number; step: PlanStep } | null {
  const index = steps.findIndex((step) => step.status === "running");
  const step = steps[index];
  return step ? { index, step } : null;
}
