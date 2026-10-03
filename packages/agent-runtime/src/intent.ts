import type { ChatIntent } from "@hyperframes/agent-protocol";
import { EDITING_TOOL_NAMES } from "./editing/tools.js";
import { ANALYSIS_TOOL_NAMES } from "./analysis/tools.js";
import { STORY_TOOL_NAMES } from "./story/tools.js";
import { RESEARCH_TOOL_NAMES } from "./research/tools.js";

/**
 * Tools that change the project or produce output from it: editing the timeline, rendering, building a rough cut,
 * editing/building the story, importing outside material, and the harness's own file writes. A Plan or Ask turn never
 * gets the runtime ones, and any call that names one anyway is refused (see {@link intentRefusal}).
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

/** Why a project-changing call is refused in a Plan or Ask turn; null when the turn may make it. */
export function intentRefusal(intent: ChatIntent, toolName: string): string | null {
  if (intent === "edit" || !changesProject(toolName)) return null;
  return intent === "plan"
    ? `This is a Plan turn: nothing in the project changes yet, so ${toolName} is not available. Publish the plan with update_plan and describe it; the user proceeds with an Edit turn.`
    : `This is an Ask turn: the user wants an answer only, so ${toolName} is not available. Answer from what you can read and inspect.`;
}

/** The prompt block that tells the Director what the user wants from this turn (empty for Edit turns). */
export function renderIntentBlock(intent: ChatIntent): string {
  if (intent === "plan") {
    return [
      "<turn-intent>",
      "Plan: the user wants your plan before anything changes. Read, inspect and analyze what you need (delegated agents may inspect too), then publish the steps with update_plan (every step pending) and reply with a short proposal: what you will do, in which order, and what the result will be.",
      "Do not change the project in this turn: editing, rendering, importing and story-changing tools are unavailable, and file writes are refused.",
      "End by asking the user to proceed (or to adjust the plan). When they proceed, the next turn is an Edit turn that carries out this plan.",
      "</turn-intent>",
    ].join("\n");
  }
  if (intent === "ask") {
    return [
      "<turn-intent>",
      "Ask: the user wants an answer only. Read, inspect and analyze what you need, then answer directly and concisely. Refer to moments as HH:MM:SS timecodes when it helps.",
      "Do not change the project and do not publish a plan: editing, rendering, importing and story-changing tools are unavailable, and file writes are refused.",
      "</turn-intent>",
    ].join("\n");
  }
  return "";
}
