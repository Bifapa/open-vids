import {
  DEFAULT_EXECUTION_QUALITY,
  effectiveSpecialistConfig,
  isAgentRunTerminal,
  type AgentModelCatalog,
  type AgentModelInfo,
  type AgentRun,
  type AgentSettings,
  type AssistantMessage,
  type ChatMessage,
  type ChatState,
  type ChatSummary,
  type ExecutionQuality,
  type ModelConfig,
  type ModelSelection,
  type SpecialistConfig,
  type SpecialistId,
  type TaskMessage,
  type ThinkingEffort,
  type TurnSummary,
  type UserMessage,
  type WorkerAgentId,
} from "@hyperframes/agent-protocol";
import { t } from "../i18n";

/** The turn currently running in a chat, if any. */
export function runningTurn(chat: ChatState | null): TurnSummary | null {
  if (!chat) return null;
  for (let index = chat.turns.length - 1; index >= 0; index -= 1) {
    const turn = chat.turns[index];
    if (turn?.status === "running") return turn;
  }
  return null;
}

/**
 * The runtime answered and lists no usable model: no provider has credentials. Not the same as a catalog that is
 * still loading or could not be read (`null`), nor as an agent that is unreachable (`availability`).
 */
export function hasNoUsableModel(catalog: AgentModelCatalog | null): boolean {
  return catalog !== null && catalog.models.length === 0;
}

export function findModel(
  catalog: AgentModelCatalog | null,
  selection: ModelSelection | null,
): AgentModelInfo | null {
  if (!catalog || !selection) return null;
  return (
    catalog.models.find(
      (model) => model.provider === selection.provider && model.modelId === selection.modelId,
    ) ?? null
  );
}

export interface ResolvedModel {
  /** What runs: the explicit choice, else the default it falls back to. */
  selection: ModelSelection | null;
  /** The catalog entry for `selection`; null when the catalog does not list it. */
  info: AgentModelInfo | null;
  /** True when there is no explicit model and the default applies. */
  isDefault: boolean;
}

/**
 * `fallback` is what "default" means for this agent: the Director's global default for the Director,
 * the runtime default (the catalog's) for everyone else.
 */
export function resolveModel(
  explicit: ModelSelection | null,
  catalog: AgentModelCatalog | null,
  fallback: ModelSelection | null = catalog?.defaultModel ?? null,
): ResolvedModel {
  const selection = explicit ?? fallback;
  return { selection, info: findModel(catalog, selection), isDefault: explicit === null };
}

/** Efforts the picker offers: Off plus whatever the model accepts. Empty when it has no control. */
export function effortChoices(info: AgentModelInfo | null): ThinkingEffort[] {
  if (!info || info.efforts.length === 0) return [];
  return ["off", ...info.efforts.filter((effort) => effort !== "off")];
}

export function displayModelName(
  selection: ModelSelection | null,
  info: AgentModelInfo | null,
): string {
  return info?.name ?? selection?.modelId ?? t("agent.model.none");
}

export function sameModel(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.provider === right.provider &&
    left.modelId === right.modelId
  );
}

// ── Agent configuration ──────────────────────────────────────────────────────

export interface AgentConfigView<T extends ModelConfig> {
  /** What the agent runs with in this chat. */
  config: T;
  /** True when the chat has its own choice instead of the global default. */
  custom: boolean;
}

/**
 * The Director's per-chat choice is `chat.mainAgentModel`/`chat.thinking`; a null field falls back to the
 * global default (`settings.director`), and a null there to the runtime default.
 */
export function directorConfig(
  chat: Pick<ChatSummary, "mainAgentModel" | "thinking">,
  settings: Pick<AgentSettings, "director"> | null,
): AgentConfigView<ModelConfig> {
  return {
    config: {
      model: chat.mainAgentModel ?? settings?.director.model ?? null,
      thinking: chat.thinking ?? settings?.director.thinking ?? null,
    },
    custom: chat.mainAgentModel !== null || chat.thinking !== null,
  };
}

/** A specialist's configuration in this chat; null when neither an override nor the settings are known. */
export function specialistConfig(
  chat: Pick<ChatSummary, "agentOverrides">,
  settings: Pick<AgentSettings, "specialists"> | null,
  id: SpecialistId,
): AgentConfigView<SpecialistConfig> | null {
  const override = chat.agentOverrides?.[id];
  if (override) return { config: override, custom: true };
  return settings ? { config: effectiveSpecialistConfig(chat, settings, id), custom: false } : null;
}

export interface ExecutionQualityView {
  /** What the chat's next turns run with. */
  quality: ExecutionQuality;
  /** True when the chat has its own choice instead of following the global default. */
  custom: boolean;
}

/** The chat's own Execution Quality, else the global default (the runtime's default before settings load). */
export function chatExecutionQuality(
  chat: Pick<ChatSummary, "executionQuality">,
  settings: Pick<AgentSettings, "executionQuality"> | null,
): ExecutionQualityView {
  if (chat.executionQuality) return { quality: chat.executionQuality, custom: true };
  return { quality: settings?.executionQuality ?? DEFAULT_EXECUTION_QUALITY, custom: false };
}

// ── Threads ──────────────────────────────────────────────────────────────────

/** What the conversation shows: the main (Director) chat, or one delegated agent's runs. */
export type ThreadId = "main" | WorkerAgentId;

export interface AgentCrumb {
  agent: WorkerAgentId;
  /** At least one of the agent's runs is queued or running. */
  live: boolean;
}

/** The agents that worked in this chat, each once, in the order they first appeared. */
export function agentCrumbs(runs: readonly AgentRun[]): AgentCrumb[] {
  const crumbs = new Map<WorkerAgentId, AgentCrumb>();
  for (const run of runs) {
    const live = !isAgentRunTerminal(run.status);
    const known = crumbs.get(run.agent);
    if (!known) crumbs.set(run.agent, { agent: run.agent, live });
    else if (live) known.live = true;
  }
  return [...crumbs.values()];
}

/**
 * The thread the open chat shows: the one selected for it, or Main when nothing was selected or the
 * selected agent has no run in the chat (any more).
 */
export function activeThread(
  threads: Readonly<Record<string, ThreadId>>,
  chat: Pick<ChatState, "chat" | "runs"> | null,
): ThreadId {
  const selected = chat ? threads[chat.chat.id] : undefined;
  if (!chat || !selected || selected === "main") return "main";
  return chat.runs.some((run) => run.agent === selected) ? selected : "main";
}

/** Ids of every message that belongs to a run's own thread, even one the producer left without `runId`. */
function runOwnedIds(runs: readonly AgentRun[]): Set<string> {
  const owned = new Set<string>();
  for (const run of runs) {
    owned.add(run.taskMessageId);
    owned.add(run.assistantMessageId);
  }
  return owned;
}

/** The main conversation: the user's prompts and the Director's replies, nothing from inside a run. */
export function mainThreadMessages(
  chat: Pick<ChatState, "messages" | "runs">,
): (UserMessage | AssistantMessage)[] {
  const owned = runOwnedIds(chat.runs);
  return chat.messages.filter(
    (message): message is UserMessage | AssistantMessage =>
      message.role !== "task" && !message.runId && !owned.has(message.id),
  );
}

export interface RunThread {
  run: AgentRun;
  /** The run's own messages in arrival order: its task, any follow-ups, and its reply. */
  messages: (TaskMessage | AssistantMessage)[];
}

/** Every run of one agent in this chat, oldest first, each with its own messages. */
export function agentThread(
  chat: Pick<ChatState, "messages" | "runs">,
  agent: WorkerAgentId,
): RunThread[] {
  const threads = chat.runs
    .filter((run) => run.agent === agent)
    .map((run): RunThread => ({ run, messages: [] }));
  const byMessage = new Map<string, RunThread>();
  const byRun = new Map<string, RunThread>();
  for (const thread of threads) {
    byRun.set(thread.run.id, thread);
    byMessage.set(thread.run.taskMessageId, thread);
    byMessage.set(thread.run.assistantMessageId, thread);
  }
  for (const message of chat.messages) {
    if (message.role === "user") continue;
    const thread = (message.runId && byRun.get(message.runId)) || byMessage.get(message.id);
    thread?.messages.push(message);
  }
  return threads;
}

/**
 * What a live run is doing right now: the label of the latest running activity of its reply
 * ("Editing scenes/intro.html"). Null once it ended or while it has no running activity.
 */
export function runCurrentStep(messages: readonly ChatMessage[], run: AgentRun): string | null {
  if (isAgentRunTerminal(run.status)) return null;
  const reply = messages.find((message) => message.id === run.assistantMessageId);
  if (reply?.role !== "assistant") return null;
  for (let index = reply.parts.length - 1; index >= 0; index -= 1) {
    const part = reply.parts[index];
    if (part?.type === "activity" && part.activity.status === "running") {
      return part.activity.label;
    }
  }
  return null;
}
