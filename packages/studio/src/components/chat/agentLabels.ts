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
import { t, type TranslationKey } from "../../i18n";

export const EFFORT_LABELS: Record<ThinkingEffort, TranslationKey> = {
  off: "chat.effort.off",
  minimal: "chat.effort.minimal",
  low: "chat.effort.low",
  medium: "chat.effort.medium",
  high: "chat.effort.high",
  xhigh: "chat.effort.xhigh",
  max: "chat.effort.max",
};

/** What each agent is called in the interface; the Director leads the chat as "Main" (`chatAgentName`). */
export const AGENT_NAME_KEYS: Record<AgentId, TranslationKey> = {
  director: "chat.agent.name.director",
  editor: "chat.agent.name.editor",
  vision: "chat.agent.name.vision",
  motion: "chat.agent.name.motion",
  research: "chat.agent.name.research",
  audio: "chat.agent.name.audio",
  jev: "chat.agent.name.jev",
};

/** One line on what each agent is for, shown where the user enables or configures it. */
export const AGENT_BLURBS: Record<AgentId, TranslationKey> = {
  director: "chat.agent.blurb.director",
  editor: "chat.agent.blurb.editor",
  vision: "chat.agent.blurb.vision",
  motion: "chat.agent.blurb.motion",
  research: "chat.agent.blurb.research",
  audio: "chat.agent.blurb.audio",
  jev: "chat.agent.blurb.jev",
};

export const RUN_STATUS_LABELS: Record<AgentRunStatus, TranslationKey> = {
  queued: "chat.run.status.queued",
  running: "chat.run.status.running",
  completed: "chat.run.status.completed",
  failed: "chat.run.status.failed",
  aborted: "chat.run.status.aborted",
  cancelled: "chat.run.status.cancelled",
  interrupted: "chat.run.status.interrupted",
};

export const PLAN_STATUS_LABELS: Record<PlanStepStatus, TranslationKey> = {
  pending: "chat.plan.status.pending",
  running: "chat.plan.status.running",
  done: "chat.plan.status.done",
  failed: "chat.plan.status.failed",
  skipped: "chat.plan.status.skipped",
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
  if (!catalog) return t("chat.model.unavailable");
  const { selection, info } = resolveModel(config.model, catalog, defaults.model);
  const model = displayModelName(selection, info);
  const effort = config.thinking ?? defaults.thinking;
  if (!effort || !info || info.efforts.length === 0) return model;
  return t("chat.model.withEffort", { model, effort: t(EFFORT_LABELS[effort]) });
}
