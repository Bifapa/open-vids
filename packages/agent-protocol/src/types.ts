/**
 * OpenVids Agent Runtime protocol — core data model.
 *
 * These types are OpenVids-owned. Nothing here mirrors OMP (or any other
 * harness) types: the runtime adapter translates at its boundary, and Studio
 * depends on this package only.
 */

export const AGENT_PROTOCOL_VERSION = 1;

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

// ── Chats and turns ──────────────────────────────────────────────────────────

export const CHAT_STATUSES = ["idle", "working", "interrupted", "completed", "failed"] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

/** Only "normal" exists in Milestone 1; the field exists so Story/other modes need no schema change. */
export type ChatMode = "normal";

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
  /** Specialist ids enabled for this chat. Always empty until specialists exist. */
  enabledAgents: string[];
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
  error?: AgentError;
}

/** The single project-modifying turn allowed at a time, across every chat of a project. */
export interface ActiveTurnInfo {
  chatId: string;
  turnId: string;
  startedAt: number;
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
  /** Reserved for Story Mode; always null until it exists. */
  storyGraph: null;
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

export type UserPart = TextPart | ReferencePart;
export type AssistantPart = TextPart | ThinkingPart | ActivityPart;

interface MessageBase {
  id: string;
  chatId: string;
  turnId: string;
  createdAt: number;
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
}

export type ChatMessage = UserMessage | AssistantMessage;

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
  /** Sequence number of the last event folded in; 0 for a chat with no events yet. */
  lastSeq: number;
}
