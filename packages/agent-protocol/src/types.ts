/**
 * OpenVids Agent Runtime protocol — core data model.
 *
 * These types are OpenVids-owned. Nothing here mirrors OMP (or any other
 * harness) types: the runtime adapter translates at its boundary, and Studio
 * depends on this package only.
 */

export const AGENT_PROTOCOL_VERSION = 2;

// ── Models and thinking ──────────────────────────────────────────────────────

export const THINKING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

export interface ModelSelection {
  /** Provider id as the runtime reports it (e.g. "anthropic"). Opaque to the product. */
  provider: string;
  modelId: string;
}

export interface AgentModelInfo extends ModelSelection {
  name: string;
  reasoning: boolean;
  /** Efforts the model accepts, excluding "off". Empty when effort is not controllable. */
  efforts: ThinkingEffort[];
  contextWindow?: number;
}

export interface AgentModelCatalog {
  /** Authenticated, usable models only. */
  models: AgentModelInfo[];
  /** What the runtime would use for a chat with no explicit choice. */
  defaultModel: ModelSelection | null;
  defaultThinking: ThinkingEffort | null;
}

// ── Agents ───────────────────────────────────────────────────────────────────

/** The fixed v1 specialist roles the Director can delegate to. Users enable them per chat. */
export const SPECIALIST_IDS = ["editor", "vision", "motion", "research", "audio"] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

/**
 * Everyone that can produce work in a chat: the Director, a specialist, or Jev — the shared fast worker that the
 * Director and every specialist may call. Jev is configured globally, never enabled per chat.
 */
export type AgentId = "director" | SpecialistId | "jev";
/** Agents that run as a delegated unit of work inside a Director turn. */
export type WorkerAgentId = SpecialistId | "jev";

export const AGENT_DISPLAY_NAMES: Readonly<Record<AgentId, string>> = {
  director: "Director",
  editor: "Editor",
  vision: "Vision",
  motion: "Motion Designer",
  research: "Research",
  audio: "Audio",
  jev: "Jev",
};

export function isSpecialistId(value: unknown): value is SpecialistId {
  return typeof value === "string" && (SPECIALIST_IDS as readonly string[]).includes(value);
}

/** A model plus thinking effort; null fields mean "runtime default". */
export interface ModelConfig {
  model: ModelSelection | null;
  thinking: ThinkingEffort | null;
}

/**
 * How one specialist runs. `allowedModels` are the only other models the Director may pick for a single delegated
 * task (empty: the Director must use `model`). The Director may lower thinking for a task but never raise it above
 * `thinking`.
 */
export interface SpecialistConfig extends ModelConfig {
  allowedModels: ModelSelection[];
}

export interface SpecialistDefaults extends SpecialistConfig {
  /** Whether new chats start with this specialist enabled. */
  enabledByDefault: boolean;
}

export const JEV_CREDENTIAL_MODES = ["provider-login", "api-key"] as const;
/**
 * `provider-login`: use the sign-in/key the agent runtime already has for the provider.
 * `api-key`: use the key stored in OpenVids settings (never sent back to clients).
 */
export type JevCredentialMode = (typeof JEV_CREDENTIAL_MODES)[number];

export interface JevSettings {
  enabled: boolean;
  provider: string | null;
  modelId: string | null;
  thinking: ThinkingEffort | null;
  credentials: JevCredentialMode;
  /** True when an API key is stored for Jev. The key itself never leaves the runtime. */
  apiKeyConfigured: boolean;
}

/** Global (per-user) agent settings: defaults for new chats plus the Jev worker. */
export interface AgentSettings {
  director: ModelConfig;
  specialists: Record<SpecialistId, SpecialistDefaults>;
  jev: JevSettings;
}

/** Per-chat specialist overrides; a missing entry means "use the global default". */
export type SpecialistOverrides = Partial<Record<SpecialistId, SpecialistConfig>>;

export interface ProviderInfo {
  id: string;
  /** True when the runtime already has credentials for this provider. */
  authenticated: boolean;
}

// ── Chats and turns ──────────────────────────────────────────────────────────

export const CHAT_STATUSES = ["idle", "working", "interrupted", "completed", "failed"] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

/**
 * `normal`: the Director edits the video. `story`: the Director plans the video as the project's Story Graph and
 * does not touch the timeline (except when the user asks it to build the story).
 */
export const CHAT_MODES = ["normal", "story"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

/**
 * A Story workspace action run as a turn: `review` — the Director reviews the current (user-edited) graph;
 * `build` — the story is built into the timeline. Both are ordinary checkpointed turns.
 */
export const STORY_ACTIONS = ["review", "build"] as const;
export type StoryAction = (typeof STORY_ACTIONS)[number];

export interface ChatSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: ChatStatus;
  lastTaskSummary: string | null;
  activeMode: ChatMode;
  /** Explicit choice for this chat; null means "runtime default". */
  mainAgentModel: ModelSelection | null;
  /** Explicit choice for this chat; null means "runtime default". */
  thinking: ThinkingEffort | null;
  /** Specialists the Director may delegate to in this chat. */
  enabledAgents: SpecialistId[];
  /** Per-chat specialist model/thinking overrides. Absent (chats from before specialists existed) = none. */
  agentOverrides?: SpecialistOverrides;
}

/** The specialist configuration a chat actually uses: its own override, else the global default. */
export function effectiveSpecialistConfig(
  chat: Pick<ChatSummary, "agentOverrides">,
  settings: Pick<AgentSettings, "specialists">,
  id: SpecialistId,
): SpecialistConfig {
  return chat.agentOverrides?.[id] ?? settings.specialists[id];
}

export const TURN_STATUSES = ["running", "completed", "failed", "aborted", "interrupted"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

export const CHECKPOINT_STATUSES = ["active", "ready", "unavailable", "reverted"] as const;
export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];

/** The reversible project transaction that belongs to exactly one user prompt. */
export interface TurnCheckpoint {
  status: CheckpointStatus;
  /** Project-history entries the turn produced, oldest first. Empty when the turn changed nothing. */
  entryIds: string[];
  createdAt: number;
  closedAt?: number;
  revertedAt?: number;
  /** Why a checkpoint could not be taken. */
  reason?: string;
  /**
   * The project-history transaction behind the checkpoint while it is open. Persisted so a restarted runtime can
   * close a transaction a crashed turn left open.
   */
  transactionId?: string;
}

export interface AgentError {
  code: AgentErrorCode;
  message: string;
}

export interface TurnSummary {
  id: string;
  chatId: string;
  status: TurnStatus;
  startedAt: number;
  endedAt?: number;
  promptMessageId: string;
  assistantMessageId: string;
  model: ModelSelection | null;
  thinking: ThinkingEffort | null;
  checkpoint: TurnCheckpoint | null;
  /** The Director's compact live plan for this turn; absent until the Director publishes one. */
  plan?: ExecutionPlan;
  /** The chat mode the turn ran in (absent on turns from before modes existed = `normal`). */
  mode?: ChatMode;
  /** The Story workspace action the turn ran, if any. */
  storyAction?: StoryAction;
  error?: AgentError;
}

/** The single project-modifying turn allowed at a time, across every chat of a project. */
export interface ActiveTurnInfo {
  chatId: string;
  turnId: string;
  startedAt: number;
}

// ── Execution plan ───────────────────────────────────────────────────────────

export const PLAN_STEP_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

/** One line of the compact plan ("Assemble rough cut — running"). Informational, not an approval queue. */
export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  /** Who is expected to do the step, when the Director said so. */
  agent: AgentId | null;
}

export interface ExecutionPlan {
  steps: PlanStep[];
  updatedAt: number;
}

// ── Agent runs ───────────────────────────────────────────────────────────────

export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "aborted",
  "cancelled",
  "interrupted",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export function isAgentRunTerminal(status: AgentRunStatus): boolean {
  return status !== "queued" && status !== "running";
}

/**
 * One delegated unit of work inside a Director turn: a specialist task, or a Jev call made by the Director or by a
 * specialist. It shares the turn's checkpoint, so reverting the turn reverts it too.
 */
export interface AgentRun {
  id: string;
  turnId: string;
  agent: WorkerAgentId;
  /** Null when the Director started the run; the calling specialist run when a specialist used Jev. */
  parentRunId: string | null;
  /** Short task title for milestones and breadcrumbs. */
  title: string;
  status: AgentRunStatus;
  model: ModelSelection | null;
  thinking: ThinkingEffort | null;
  /** True when the Director picked the model/effort for this task within the user's limits. */
  routedByDirector: boolean;
  /** The task message in the agent's own thread and the reply that streams under it. */
  taskMessageId: string;
  assistantMessageId: string;
  startedAt: number;
  endedAt?: number;
  /** Short outcome shown in the main chat once the run ends. */
  summary: string | null;
  error?: AgentError;
}

// ── References (attachment-ready; no attachment UI in Milestone 1) ───────────

export type MediaSource =
  | { type: "project-path"; path: string }
  | { type: "url"; url: string }
  | { type: "upload"; uploadId: string };

interface ReferenceBase {
  id: string;
  label?: string;
}

export interface MediaReference extends ReferenceBase {
  kind: "image" | "video" | "audio" | "file";
  source: MediaSource;
  mimeType?: string;
}

export interface UrlReference extends ReferenceBase {
  kind: "url";
  url: string;
  title?: string;
}

export interface AssetReference extends ReferenceBase {
  kind: "asset";
  /** Project-relative asset path. */
  path: string;
}

export interface TimelineRangeReference extends ReferenceBase {
  kind: "timeline-range";
  compositionPath?: string;
  start: number;
  end: number;
  elementIds?: string[];
}

export interface EditorSelectionReference extends ReferenceBase {
  kind: "editor-selection";
  context: EditorContext;
}

export type MessageReference =
  | MediaReference
  | UrlReference
  | AssetReference
  | TimelineRangeReference
  | EditorSelectionReference;

export type MessageReferenceKind = MessageReference["kind"];

// ── Editor context ───────────────────────────────────────────────────────────

export interface EditorClipSummary {
  id: string;
  label?: string;
  tag: string;
  start: number;
  duration: number;
  track: number;
  hfId?: string;
  domId?: string;
  sourceFile?: string;
  src?: string;
}

export interface EditorPreviewElement {
  hfId?: string;
  domId?: string;
  selector?: string;
  label?: string;
  tagName?: string;
  sourceFile?: string;
}

/**
 * What the Director is told about the editor without asking. Built by Studio,
 * carried on prompt/steer requests, rendered into the model prompt by the
 * runtime. Fields that Studio cannot know are null/empty, never invented.
 */
export interface EditorContext {
  schemaVersion: 1;
  capturedAt: number;
  project: { id: string; title?: string };
  activeComposition: {
    path: string;
    width?: number;
    height?: number;
    fps?: number;
    duration?: number;
  } | null;
  timeline: {
    duration: number;
    elementCount: number;
    /** Capped by the producer; elementCount is the true total. */
    elements: EditorClipSummary[];
  };
  playhead: { time: number; playing: boolean };
  selection: {
    clips: EditorClipSummary[];
    assetPath: string | null;
    previewElement: EditorPreviewElement | null;
    range: { start: number; end: number } | null;
  };
  renderSettings: {
    format?: string;
    fps?: number;
    quality?: string;
    resolution?: string;
  } | null;
  /** The Story workspace as the user sees it: graph version and the selected node (null: no story yet). */
  storyGraph: { version: string | null; selectedNode: string | null } | null;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface TextPart {
  type: "text";
  id: string;
  text: string;
}

export interface ThinkingPart {
  type: "thinking";
  id: string;
  text: string;
  done: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface ReferencePart {
  type: "reference";
  id: string;
  reference: MessageReference;
}

export const ACTIVITY_CATEGORIES = ["inspect", "search", "edit", "other"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/**
 * A product-level unit of agent work ("Reading 3 files"), not a raw tool call.
 * Consecutive calls of one category are folded into one activity by the runtime.
 */
export interface Activity {
  id: string;
  category: ActivityCategory;
  status: "running" | "done" | "failed";
  /** Human-readable, present tense while running ("Reading 3 files"). */
  label: string;
  /** Number of underlying operations folded into this activity. */
  count: number;
  /** Project-relative targets, capped by the producer. */
  targets: string[];
  startedAt: number;
  endedAt?: number;
}

export interface ActivityPart {
  type: "activity";
  id: string;
  activity: Activity;
}

/** Where a message started a delegated run: the main chat shows the run's progress at this point. */
export interface DelegationPart {
  type: "delegation";
  id: string;
  runId: string;
}

export type UserPart = TextPart | ReferencePart;
export type AssistantPart = TextPart | ThinkingPart | ActivityPart | DelegationPart;

interface MessageBase {
  id: string;
  chatId: string;
  turnId: string;
  createdAt: number;
  /** The agent run whose thread this message belongs to; absent for the main (Director) conversation. */
  runId?: string;
}

export interface UserMessage extends MessageBase {
  role: "user";
  parts: UserPart[];
  /** True for a mid-run steering instruction; false for the prompt that opened the turn. */
  steering: boolean;
}

export type AssistantMessageStatus = "streaming" | "complete" | "aborted" | "failed";

export interface AssistantMessage extends MessageBase {
  role: "assistant";
  parts: AssistantPart[];
  status: AssistantMessageStatus;
  model: ModelSelection | null;
  /** Who is speaking; absent means the Director. */
  agent?: AgentId;
}

/** An instruction to a delegated agent, shown at the top of (and during) its run in the agent's own thread. */
export interface TaskMessage extends MessageBase {
  role: "task";
  runId: string;
  /** The agent the task is for. */
  agent: WorkerAgentId;
  /** Who gave it: the Director, or the specialist that called Jev. */
  from: AgentId;
  parts: TextPart[];
  /** True for a follow-up correction sent to a run already in progress. */
  steering: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage | TaskMessage;

// ── Errors ───────────────────────────────────────────────────────────────────

export const AGENT_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "runtime_unavailable",
  "chat_not_found",
  "turn_not_found",
  "turn_not_active",
  "chat_busy",
  "project_busy",
  "model_unavailable",
  "checkpoint_unavailable",
  "revert_conflict",
  "revert_unavailable",
  "agent_failed",
  "internal",
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

// ── Durable chat state ───────────────────────────────────────────────────────

/** A chat as the UI holds it: what a snapshot returns and what the event reducer folds into. */
export interface ChatState {
  chat: ChatSummary;
  messages: ChatMessage[];
  turns: TurnSummary[];
  /** Every delegated run of the chat, oldest first. */
  runs: AgentRun[];
  /** Sequence number of the last event folded in; 0 for a chat with no events yet. */
  lastSeq: number;
}
