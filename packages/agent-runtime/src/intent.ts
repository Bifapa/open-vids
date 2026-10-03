import type { ChatIntent, PlanApproval, PlanStep } from "@hyperframes/agent-protocol";
import { EDITING_TOOL_NAMES } from "./editing/tools.js";
import { ANALYSIS_TOOL_NAMES } from "./analysis/tools.js";
import { STORY_TOOL_NAMES } from "./story/tools.js";
import { RESEARCH_TOOL_NAMES } from "./research/tools.js";

/**
 * Tools that change the project or produce output from it: editing the timeline, rendering, building a rough cut,
 * editing/building the story, importing outside material, and the harness's own file writes. An Ask turn never gets
 * the runtime ones, an Edit turn loses them the moment it proposes a plan, and any call that names one anyway is
 * refused (see {@link intentRefusal}).
 */
const PROJECT_CHANGING_TOOLS: Readonly<Record<string, true>> = {
  [EDITING_TOOL_NAMES.edit]: true,
  [EDITING_TOOL_NAMES.render]: true,
  [ANALYSIS_TOOL_NAMES.build]: true,
  [STORY_TOOL_NAMES.edit]: true,
  [STORY_TOOL_NAMES.build]: true,
  [STORY_TOOL_NAMES.rebuild]: true,
  [RESEARCH_TOOL_NAMES.import]: true,
  [RESEARCH_TOOL_NAMES.resolve]: true,
  // get_website_file is not listed: its "read" mode changes nothing (the executor refuses "save" outside Edit turns).
  [RESEARCH_TOOL_NAMES.record]: true,
  edit: true,
  write: true,
};

export function changesProject(toolName: string): boolean {
  return Object.hasOwn(PROJECT_CHANGING_TOOLS, toolName);
}

/**
 * Why a project-changing call is refused in this turn; null when the turn may make it. An Ask turn refuses them
 * from the start; an Edit turn refuses them after its Director proposed a plan (`planProposed`) or offered Story
 * Mode (`storyOffered`), because the rest of that turn changes nothing until the user decides.
 */
export function intentRefusal(
  intent: ChatIntent,
  toolName: string,
  planProposed = false,
  storyOffered = false,
): string | null {
  if (!changesProject(toolName)) return null;
  if (intent === "ask") {
    return `This is an Ask turn: the user wants an answer only, so ${toolName} is not available. Answer from what you can read and inspect.`;
  }
  if (storyOffered) {
    return `This turn already offered Story Mode and nothing in the project changes until the user answers the offer, so ${toolName} is not available. End the turn with a short reply about what the story would do with their chapters.`;
  }
  if (planProposed) {
    return `This turn already published a plan proposal and nothing in the project changes until the user approves it, so ${toolName} is not available. End the turn with a short summary of the plan.`;
  }
  return null;
}

/** The prompt block that tells the Director what the user wants from this turn (empty for Edit turns). */
export function renderIntentBlock(intent: ChatIntent): string {
  if (intent === "ask") {
    return [
      "<turn-intent>",
      "Ask: the user wants an answer only. Read, inspect and analyze what you need, then answer directly and concisely. Refer to moments as HH:MM:SS timecodes when it helps.",
      "Do not change the project: editing, rendering, importing and story-changing tools are unavailable, and file writes are refused.",
      "</turn-intent>",
    ].join("\n");
  }
  return "";
}

const PLAN_APPROVAL_COMMON = `propose_plan publishes the steps the user sees next to your reply, with a button that runs them and one that asks for changes (labelled in the user's language: do not quote button names). After it, every project-changing tool is refused for the rest of this turn, so end the turn with a short summary — what you will do, in which order, and what the result will be — and stop there; one closing line may say that the user can run the plan with the button under it or write what to change. When the user runs it, the next turn carries the approved steps out; when they write changes, your next turn revises the proposal. Do not call propose_plan in a turn that carries an approved plan out.`;

const PLAN_APPROVAL_RULES: Record<Exclude<PlanApproval, "never">, string> = {
  big: "The user approves a plan before big work. Call propose_plan first when the request is big: more than two steps, or work for two or more specialists, or a render, an import or a download, or removing or replacing what the user made, or long-form analysis. Small edits (a title, a colour, a trim, one quick change): do them directly, without a proposal.",
  always:
    "The user approves a plan before every request that changes the project: call propose_plan first, whatever the size. Requests that only read or answer need no proposal.",
};

/**
 * The block of an Edit turn whose Director may propose a plan (see the plan-approval setting); `never` renders
 * nothing — that turn has no propose_plan tool.
 */
export function renderPlanApprovalBlock(planApproval: PlanApproval): string {
  if (planApproval === "never") return "";
  return [
    "<plan-approval>",
    PLAN_APPROVAL_RULES[planApproval],
    PLAN_APPROVAL_COMMON,
    "A plan is 3–7 short product-level steps in the order you will do them, each with the specialist who will do it when you know.",
    "</plan-approval>",
  ].join("\n");
}

/** The block of a turn that carries out a plan the user approved: the steps, exactly as proposed. */
export function renderExecutePlanBlock(steps: readonly PlanStep[]): string {
  const lines = steps.map(
    (step, index) =>
      `${index + 1}. ${step.title}${step.agent && step.agent !== "director" ? ` (${step.agent})` : ""}`,
  );
  return [
    "<approved-plan>",
    "The user approved this plan and asked you to carry it out now:",
    ...lines,
    "Carry out every step in order. Track progress with update_plan as usual (started steps running, finished ones done); do not propose a new plan. Keep the reply short.",
    "</approved-plan>",
  ].join("\n");
}
