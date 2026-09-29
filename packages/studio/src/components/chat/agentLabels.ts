import type {
  AgentId,
  AgentModelCatalog,
  AgentRunStatus,
  ModelConfig,
  ModelSelection,
  PlanStepStatus,
  ThinkingEffort,
} from "@hyperframes/agent-protocol";
import { displayModelName, resolveModel } from "../../agent/agentSelectors";

export const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** One line on what each agent is for, shown where the user enables or configures it. */
export const AGENT_BLURBS: Record<AgentId, string> = {
  director: "Leads the chat and hands work to the specialists you enable.",
  editor: "Cuts, trims, pacing and scene order.",
  vision: "Looks at frames and layout; visual QA.",
  motion: "Titles, lower thirds, overlays and animation.",
  research: "Finds assets, facts and references in the project.",
  audio: "Music, sound effects and audio pacing.",
  jev: "A fast worker the Director and specialists hand small, well-defined tasks.",
};

export const RUN_STATUS_LABELS: Record<AgentRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  aborted: "Stopped",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export const PLAN_STATUS_LABELS: Record<PlanStepStatus, string> = {
  pending: "Pending",
  running: "In progress",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

/** What "default" means for an agent's model and thinking when its own fields are null. */
export interface ConfigDefaults {
  model: ModelSelection | null;
  thinking: ThinkingEffort | null;
}

/** "Sonnet · High": the model an agent runs with and, when the model has any, its thinking effort. */
export function describeModelConfig(
  config: ModelConfig,
  catalog: AgentModelCatalog | null,
  defaults: ConfigDefaults,
): string {
  if (!catalog) return "Models unavailable";
  const { selection, info } = resolveModel(config.model, catalog, defaults.model);
  const model = displayModelName(selection, info);
  const effort = config.thinking ?? defaults.thinking;
  if (!effort || !info || info.efforts.length === 0) return model;
  return `${model} · ${EFFORT_LABELS[effort]}`;
}
