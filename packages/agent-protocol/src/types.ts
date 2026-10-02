/**
 * OpenVids Agent Runtime protocol — core data model.
 *
 * These types are OpenVids-owned. Nothing here mirrors OMP (or any other
 * harness) types: the runtime adapter translates at its boundary, and Studio
 * depends on this package only.
 */

import type {
  ExecutionBudget,
  ExecutionQuality,
  ExecutionQualityPreset,
  TurnQaState,
} from "./qa.js";

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

/**
 * How much the agents may do without asking (Settings → Execution → Autonomy).
 *
 * - `defaultIntent`: the Mode chip a new chat's composer starts with. The runtime only stores it; Studio applies it.
 * - `askBeforeLockedEdits`: material the user locked or set by hand (locked timeline clips, locked Story nodes, the
 *   user's decisions) is NEVER changed by an agent, whatever this says (the editing and story services refuse it).
 *   `true`: an agent that needs such a change stops work on that item and asks the user first. `false`: it leaves the
 *   item as it is, carries on with the rest and reports what it left untouched afterwards.
 * - `askBeforeDownloads`: `true`: Research may search and inspect, but `import_asset` and `read_website` with `save`
 *   are refused until the user has approved in the turn (an explicit download/import instruction or a yes, or the
 *   Story workspace's "Find missing material" action). `false`: agents import what fits without asking.
 */
export interface AutonomySettings {
  defaultIntent: ChatIntent;
  askBeforeLockedEdits: boolean;
  askBeforeDownloads: boolean;
}

/** Global (per-user) agent settings: defaults for new chats plus the Jev worker. */
export interface AgentSettings {
  director: ModelConfig;
  specialists: Record<SpecialistId, SpecialistDefaults>;
  jev: JevSettings;
  /** Execution Quality of chats that have not chosen their own. */
  executionQuality: ExecutionQuality;
  autonomy: AutonomySettings;
}

/** Per-chat specialist overrides; a missing entry means "use the global default". */
export type SpecialistOverrides = Partial<Record<SpecialistId, SpecialistConfig>>;

/**
 * What the runtime can honestly tell about a provider:
 * - `connected`: credentials exist (or the provider needs none) and nothing is known to be wrong.
 * - `not_configured`: no credentials.
 * - `error`: credentials exist, but the provider's live model list could not be fetched with them (see `error`).
 *   The provider's models stay usable; the message says why it is suspect.
 * - `signin_required`: no usable credentials, and an OMP sign-in of this provider was torn down because its token
 *   refresh failed definitively (expired or revoked). Only detected after such a failed refresh, never predicted.
 */
export const PROVIDER_STATUSES = [
  "connected",
  "not_configured",
  "error",
  "signin_required",
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

/**
 * Where the provider's credential comes from: `omp` (the user's OMP login, key, environment variable or models.yml,
 * read-only), `api-key` (an API key stored in OpenVids' own private credentials file) or `oauth` (a sign-in made inside
 * OpenVids, stored in OpenVids' own private auth database and refreshed there). A key or sign-in stored in OpenVids
 * takes precedence over what OMP has for the same provider; an API key wins over a sign-in.
 */
export const PROVIDER_CREDENTIAL_SOURCES = ["omp", "api-key", "oauth"] as const;
export type ProviderCredentialSource = (typeof PROVIDER_CREDENTIAL_SOURCES)[number];

/**
 * How an in-app sign-in reaches the user. `browser`: the runtime listens on a loopback port and the user approves in
 * their browser (a pasted redirect URL is accepted as a fallback). `device`: the user opens a verification page and
 * enters a short code while the runtime polls. `paste`: the user signs in in the browser and pastes the code or the
 * redirect URL back.
 */
export const OAUTH_FLOWS = ["browser", "device", "paste"] as const;
export type OAuthFlow = (typeof OAUTH_FLOWS)[number];

export interface OAuthFlowInfo {
  flow: OAuthFlow;
  /** The loopback port a `browser` flow prefers; null for flows without a callback server. */
  callbackPort: number | null;
  /** The provider accepts only that exact port: when it is taken the sign-in fails with a clear message. */
  fixedPort: boolean;
}

/** The in-app sign-ins a provider offers, the first being the default. */
export interface ProviderOAuthInfo {
  flows: OAuthFlowInfo[];
}

export interface ProviderInfo {
  id: string;
  /** True when the runtime already has credentials for this provider (or it needs none). */
  authenticated: boolean;
  /** Human-readable provider name ("Anthropic"). */
  name: string;
  status: ProviderStatus;
  /** Null when there is no credential, or the provider is keyless (`keyless`). */
  credentialSource: ProviderCredentialSource | null;
  /** A human-readable reason when `status` is `error` or `signin_required`; otherwise null. */
  error: string | null;
  /** How many models the catalog lists for this provider; usable only while `authenticated`. */
  modelCount: number;
  /** A local or keyless provider that works without any credential. */
  keyless: boolean;
  /**
   * True when a live model list was fetched from the provider with its credential in this runtime, so the credential
   * is known to work. False means "not checked" (cached or bundled catalog, no listing endpoint), not "bad".
   */
  verified: boolean;
  /**
   * The in-app sign-in this provider offers, or null when it has none (it is key-only, or the runtime cannot store
   * sign-ins in this setup). Always sent by the runtime; optional so older clients' fixtures stay valid.
   */
  oauth?: ProviderOAuthInfo | null;
}

// ── In-app OAuth sign-in ─────────────────────────────────────────────────────

/**
 * Where a sign-in is: `pending` (started; the user must act in the browser or with the device code, or the runtime is
 * still working), `needs_input` (the runtime waits for the user to answer `prompt`), `succeeded`, `failed` (`error`
 * says why), `cancelled` (the user or a restart stopped it) or `expired` (nobody finished it in time).
 */
export const OAUTH_LOGIN_STATUSES = [
  "pending",
  "needs_input",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;
export type OAuthLoginStatus = (typeof OAUTH_LOGIN_STATUSES)[number];

/** Something the sign-in asks the user to type or paste. The answer is never echoed back by any route. */
export interface OAuthLoginPrompt {
  message: string;
  placeholder: string | null;
  /** The answer is a secret: the UI should mask it. */
  secret: boolean;
  /**
   * The sign-in continues without an answer (the authorization URL is already out and the browser callback may still
   * complete it): a pasted code is a fallback, and `status` stays `pending`. False: the sign-in waits (`needs_input`).
   */
  optional: boolean;
}

export interface OAuthLoginState {
  /** Opaque, unguessable id of this sign-in; poll and cancel with it. */
  id: string;
  provider: string;
  status: OAuthLoginStatus;
  flow: OAuthFlow;
  /** The authorization or verification URL the user must open. The runtime never opens a browser itself. */
  authUrl: string | null;
  /** What to tell the user ("Enter code: ABCD-1234", "Complete login in your browser…"), as the provider words it. */
  instructions: string | null;
  /** The short code to enter at `authUrl` (device flows), when it could be told apart from the instructions. */
  deviceCode: string | null;
  /** The latest progress line ("Waiting for browser authentication…"). */
  progress: string | null;
  prompt: OAuthLoginPrompt | null;
  /** One line, set when `status` is `failed`. Never contains a token or a code. */
  error: string | null;
  startedAt: number;
  /** When an unfinished sign-in is given up (epoch ms). */
  expiresAt: number;
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
 * What the user wants from a turn (the composer's Mode chip): `plan` — the Director proposes a plan first and changes
 * nothing (the user proceeds with an Edit turn); `edit` — the agents act on the project; `ask` — the Director answers
 * only. Plan and Ask turns never change the project: the runtime withholds and refuses every project-changing tool.
 */
export const CHAT_INTENTS = ["plan", "edit", "ask"] as const;
export type ChatIntent = (typeof CHAT_INTENTS)[number];

export function isChatIntent(value: unknown): value is ChatIntent {
  return typeof value === "string" && (CHAT_INTENTS as readonly string[]).includes(value);
}

/** Autonomy of a user who never changed it: new chats start in Plan, and agents ask before locked edits and downloads. */
export const DEFAULT_AUTONOMY_SETTINGS: Readonly<AutonomySettings> = {
  defaultIntent: "plan",
  askBeforeLockedEdits: true,
  askBeforeDownloads: true,
};

/**
 * A Story workspace action run as a turn: `review` — the Director reviews the current (user-edited) graph;
 * `build` — the whole story is built into the timeline; `rebuild` — only the sections the graph changed since the
 * last build are rebuilt; `resolve` — the Research specialist looks for the material of the story's Missing Asset
 * nodes (within the global Asset Search policy) and resolves them with what it imports. All are ordinary
 * checkpointed turns.
 */
export const STORY_ACTIONS = ["review", "build", "rebuild", "resolve"] as const;
export type StoryAction = (typeof STORY_ACTIONS)[number];

/**
 * What happens to generated clips that were edited after the build when a rebuild would regenerate them: `keep`
 * leaves the edited material on the timeline (that part of the story change is not applied), `replace` rebuilds it.
 */
export const MANUAL_EDIT_POLICIES = ["keep", "replace"] as const;
export type ManualEditPolicy = (typeof MANUAL_EDIT_POLICIES)[number];

/**
 * The user's choices for a `build` / `rebuild` / `resolve` turn, made in the Story workspace. The turn's story tools
 * apply them; a model cannot widen them (it can never unlock a chapter or replace edited material on its own).
 */
export interface StoryActionOptions {
  /** rebuild: only these chapters' changed sections are regenerated (default: every affected section). */
  chapters?: string[];
  /** rebuild: edited generated clips in a section that must change (default `keep`). */
  manualEdits?: ManualEditPolicy;
  /** build/rebuild: locked chapters the user allows to be rebuilt (their built section is otherwise frozen). */
  allowLocked?: string[];
  /** resolve: only these Missing Asset nodes (default: every unlocked Missing Asset node). */
  missing?: string[];
}

export interface ChatSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: ChatStatus;
  lastTaskSummary: string | null;
  activeMode: ChatMode;
  /** The chat's intent for its next turns (the Mode chip); absent (chats from before intents) = `edit`. */
  intent?: ChatIntent;
  /** Explicit choice for this chat; null means "runtime default". */
  mainAgentModel: ModelSelection | null;
  /** Explicit choice for this chat; null means "runtime default". */
  thinking: ThinkingEffort | null;
  /** Specialists the Director may delegate to in this chat. */
  enabledAgents: SpecialistId[];
  /** Per-chat specialist model/thinking overrides. Absent (chats from before specialists existed) = none. */
  agentOverrides?: SpecialistOverrides;
  /** The chat's own Execution Quality; absent or null = the global default. */
  executionQuality?: ExecutionQuality | null;
  /**
   * The chat's frame format is still to be decided: the project was started with the format on Auto, so the agent
   * must pick the canvas before building. Set by the runtime when a turn arrives with `canvas: "auto"`, durable
   * across turns and restarts; cleared when a successful `edit_timeline` batch sets the canvas.
   */
  canvasAuto?: boolean;
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
  /** Project-relative files the turn's entries changed, sorted; absent on turns from before it was recorded. */
  files?: string[];
  createdAt: number;
  closedAt?: number;
  revertedAt?: number;
  /** History entries the revert wrote, oldest first: undoing them is "Undo revert". */
  revertEntryIds?: string[];
  /** The turn's own entries a revert has undone, oldest first: they are in effect again after "Undo revert". */
  revertedEntryIds?: string[];
  /** Files the revert left as they were because they changed after the turn (Revert untouched files). */
  keptFiles?: string[];
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
  /** What the user wanted from the turn (absent on turns from before intents = `edit`). */
  intent?: ChatIntent;
  /** The Story workspace action the turn ran, if any. */
  storyAction?: StoryAction;
  /** The user's choices for that action (build/rebuild). */
  storyOptions?: StoryActionOptions;
  /** The Execution Quality the turn ran with (preset and the budget it resolved to). */
  execution?: { preset: ExecutionQualityPreset; budget: ExecutionBudget };
  /** Autonomous render QA of the turn; absent when QA never started (nothing changed, or turns before QA existed). */
  qa?: TurnQaState;
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
  /** `activity.<titleCode>` locale key for `title`; the UI prefers it when present, `title` is the fallback. */
  titleCode?: string;
  /** Placeholder values for `activity.<titleCode>`. */
  titleParams?: CodedMessageParams;
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
  /** An interim progress note written before the turn's render QA; the final report after QA is not marked. */
  interim?: true;
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
  /** `activity.<labelCode>` locale key for `label`; the UI prefers it when present, `label` is the fallback. */
  labelCode?: string;
  /** Placeholder values for `activity.<labelCode>`. */
  labelParams?: CodedMessageParams;
  /** Number of underlying operations folded into this activity. */
  count: number;
  /** Project-relative targets, capped by the producer. */
  targets: string[];
  /** Determinate progress 0–100 of a running activity that reports it (a render); absent otherwise. */
  progress?: number;
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
  "login_not_found",
  "checkpoint_unavailable",
  "revert_conflict",
  "revert_unavailable",
  "agent_failed",
  "internal",
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/** Values a translated message may interpolate; keys are the locale placeholders (`{count}`, `{path}`). */
export type CodedMessageParams = Record<string, string | number>;

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
