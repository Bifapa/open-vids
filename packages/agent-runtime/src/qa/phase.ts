import { TOOL_NAMES } from "../agents/tools.js";
import { ANALYSIS_TOOL_NAMES } from "../analysis/tools.js";
import { EDITING_TOOL_NAMES } from "../editing/tools.js";
import { RESEARCH_TOOL_NAMES } from "../research/tools.js";
import { STORY_TOOL_NAMES } from "../story/tools.js";
import { savesWebsiteFiles } from "../intent.js";
import type { QaPhase } from "./loop.js";

/** Tools that change the project or start work that could: nothing of the kind runs once QA is over. */
const CHANGES_PROJECT: Record<string, true> = {
  [EDITING_TOOL_NAMES.edit]: true,
  [EDITING_TOOL_NAMES.render]: true,
  [ANALYSIS_TOOL_NAMES.build]: true,
  [STORY_TOOL_NAMES.edit]: true,
  [STORY_TOOL_NAMES.build]: true,
  [STORY_TOOL_NAMES.rebuild]: true,
  [RESEARCH_TOOL_NAMES.import]: true,
  [RESEARCH_TOOL_NAMES.resolve]: true,
  [RESEARCH_TOOL_NAMES.record]: true,
  [TOOL_NAMES.delegate]: true,
  [TOOL_NAMES.message]: true,
  [TOOL_NAMES.jev]: true,
};

/**
 * Why a tool call is refused in this phase of Render QA, or null when it may run. In a correction the runtime renders
 * and re-checks by itself, so nobody renders; in the final prompt the Director only reports.
 */
export function qaPhaseRefusal(phase: QaPhase, tool: string, args?: unknown): string | null {
  if (phase === "final" && (CHANGES_PROJECT[tool] || savesWebsiteFiles(tool, args))) {
    return `Render QA is over and the Director is writing the final report: ${tool} is refused now. Nothing may be edited, delegated, imported, built or rendered any more; report what was done and what QA found.`;
  }
  if (phase === "correction" && tool === EDITING_TOOL_NAMES.render) {
    return `${tool} is refused during a Render QA correction: the runtime re-renders and re-checks the project after the correction. Finish the corrections; do not render.`;
  }
  return null;
}
