import { TOOL_NAMES } from "../agents/tools.js";
import { ANALYSIS_TOOL_NAMES } from "../analysis/tools.js";
import { EDITING_TOOL_NAMES } from "../editing/tools.js";
import { RESEARCH_TOOL_NAMES } from "../research/tools.js";
import { CROSS_PROJECT_TOOL_NAMES } from "../crossProject/tools.js";
import { STORY_TOOL_NAMES } from "../story/tools.js";
import { VOICE_TOOL_NAMES } from "../voice/tools.js";
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
  [CROSS_PROJECT_TOOL_NAMES.import]: true,
  [TOOL_NAMES.delegate]: true,
  [TOOL_NAMES.message]: true,
  [TOOL_NAMES.jev]: true,
};

/** Analysis tools that start long jobs or write analysis results: nothing like it runs in a review or the final report. */
export const HEAVY_ANALYSIS: Record<string, true> = {
  [ANALYSIS_TOOL_NAMES.analyze]: true,
  [ANALYSIS_TOOL_NAMES.frames]: true,
  [ANALYSIS_TOOL_NAMES.plan]: true,
  [ANALYSIS_TOOL_NAMES.segments]: true,
  [ANALYSIS_TOOL_NAMES.vision]: true,
};

/**
 * Why a tool call is refused in this phase of Render QA, or null when it may run. In a correction the runtime renders
 * and re-checks by itself, so nobody renders; in a review (the Director standing in for Vision) it only looks and
 * reports; in the final prompt the Director only reports.
 */
export function qaPhaseRefusal(phase: QaPhase, tool: string, args?: unknown): string | null {
  // Voiceover asks the user and costs them money: nothing of the kind happens while QA checks the result.
  if (phase !== null && (tool === VOICE_TOOL_NAMES.setup || tool === VOICE_TOOL_NAMES.generate)) {
    return `Render QA is checking the result: ${tool} is not available now. Finish the corrections or the final report; a voiceover is made in a turn of its own.`;
  }
  if (phase === "final" && (CHANGES_PROJECT[tool] || savesWebsiteFiles(tool, args))) {
    return `Render QA is over and the Director is writing the final report: ${tool} is refused now. Nothing may be edited, delegated, imported, built or rendered any more; report what was done and what QA found.`;
  }
  if (
    phase === "review" &&
    (CHANGES_PROJECT[tool] || HEAVY_ANALYSIS[tool] || savesWebsiteFiles(tool, args))
  ) {
    return `${tool} is refused during a Render QA review: you are only looking at the render now (inspect_render) and reporting what you see (report_render_findings). Corrections come after the review.`;
  }
  if (phase === "correction" && tool === EDITING_TOOL_NAMES.render) {
    return `${tool} is refused during a Render QA correction: the runtime re-renders and re-checks the project after the correction. Finish the corrections; do not render.`;
  }
  return null;
}
