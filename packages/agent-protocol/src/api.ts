import type {
  ActiveTurnInfo,
  AgentErrorCode,
  AgentModelInfo,
  AgentSettings,
  ChatIntent,
  ChatMode,
  ChatState,
  ChatSummary,
  EditorContext,
  JevCredentialMode,
  MessageReference,
  ModelConfig,
  ModelSelection,
  ProviderInfo,
  SpecialistConfig,
  SpecialistDefaults,
  SpecialistId,
  StoryAction,
  StoryActionOptions,
  ThinkingEffort,
  TurnSummary,
} from "./types.js";
import type { ExecutionQuality } from "./qa.js";

/**
 * The OpenVids Agent Runtime HTTP API.
 *
 * Studio reaches it through the studio-server gateway at
 * `/api/projects/:projectId/agent/...`; the runtime itself serves the same
 * paths under `/v1/...`, scoped to one project by request headers that only the
 * gateway (which holds the per-launch token) can set.
 */

export const AGENT_RUNTIME_PREFIX = "/v1";

/** Sent by the gateway to the runtime. Never accepted from the browser. */
export const AGENT_HEADERS = {
  token: "authorization", // `Bearer <per-launch token>`
  projectId: "x-openvids-project-id",
  projectDir: "x-openvids-project-dir",
  /** Origin of the Studio server, used by the runtime to call the project-history routes for checkpoints. */
  studioOrigin: "x-openvids-studio-origin",
} as const;

export interface AgentErrorBody {
  error: { code: AgentErrorCode; message: string; details?: Record<string, unknown> };
}

export interface AgentHealth {
  ok: true;
  protocolVersion: number;
  /** Which harness backs the runtime; informational only. */
  backend: string;
}

// ── Requests / responses ─────────────────────────────────────────────────────

export interface ListChatsResponse {
  chats: ChatSummary[];
  activeTurn: ActiveTurnInfo | null;
}

export interface CreateChatRequest {
  title?: string;
  model?: ModelSelection | null;
  thinking?: ThinkingEffort | null;
}

export interface UpdateChatRequest {
  title?: string;
  model?: ModelSelection | null;
  thinking?: ThinkingEffort | null;
  /** Replaces the chat's enabled specialists. */
  enabledAgents?: SpecialistId[];
  /** Per-specialist overrides to set; null removes an override (back to the global default). */
  agentOverrides?: Partial<Record<SpecialistId, SpecialistConfig | null>>;
  /** The chat's mode for its next turns. */
  activeMode?: ChatMode;
  /** The chat's intent (Plan / Edit / Ask) for its next turns. */
  intent?: ChatIntent;
  /** The chat's own Execution Quality; null returns the chat to the global default. */
  executionQuality?: ExecutionQuality | null;
}

export interface StartTurnRequest {
  prompt: string;
  references?: MessageReference[];
  editorContext?: EditorContext;
  /** Mode of this turn; defaults to the chat's `activeMode`. A story action implies `story`. */
  mode?: ChatMode;
  /**
   * What the user wants from this turn; defaults to the chat's `intent`, else `edit`. Plan and Ask turns change
   * nothing. A story action always runs as `edit`.
   */
  intent?: ChatIntent;
  /** Run a Story workspace action (Review with AI / Build Story / Rebuild affected sections) as this turn. */
  storyAction?: StoryAction;
  /** The user's choices for a `build` or `rebuild` action; refused with any other action. */
  storyOptions?: StoryActionOptions;
}

export interface StartTurnResponse {
  turn: TurnSummary;
}

export interface SteerTurnRequest {
  text: string;
  editorContext?: EditorContext;
}

export interface SteerTurnResponse {
  messageId: string;
}

export const REVERT_MODES = ["keep-later-edits", "just-this"] as const;
/**
 * `keep-later-edits`: revert only the files nothing has changed since.
 * `just-this`: revert every file the turn touched, even if edited afterwards.
 */
export type RevertMode = (typeof REVERT_MODES)[number];

export interface RevertTurnRequest {
  mode?: RevertMode;
}

export type RevertTurnResponse =
  | { ok: true; turn: TurnSummary }
  | { ok: false; conflict: { files: string[] } };

export type GetChatResponse = ChatState;

export const INTAKE_FILE_KINDS = ["video", "audio", "image", "font", "other"] as const;
export type IntakeFileKind = (typeof INTAKE_FILE_KINDS)[number];

export interface AgentIntakeFile {
  /** Project-relative path of the imported copy (e.g. `assets/interview.mov`). */
  path: string;
  name: string;
  size: number;
  kind: IntakeFileKind;
}

/**
 * A project started from the Projects page chat: Home writes it to `<project>/.hyperframes/agent/intake.json` after
 * importing the files; Studio claims it once (`POST .../agent/intake/claim`) and starts the first turn from it.
 */
export interface AgentIntake {
  version: 1;
  prompt: string;
  intent: ChatIntent;
  model: ModelSelection | null;
  thinking: ThinkingEffort | null;
  agents: SpecialistId[];
  agentOverrides?: Partial<Record<SpecialistId, SpecialistConfig>>;
  files: AgentIntakeFile[];
  createdAt: string;
}

// ── Global agent settings ────────────────────────────────────────────────────

export type GetAgentSettingsResponse = AgentSettings;

/** Partial update of the global settings; omitted fields keep their value. */
export interface UpdateAgentSettingsRequest {
  director?: ModelConfig;
  specialists?: Partial<Record<SpecialistId, SpecialistDefaults>>;
  jev?: {
    enabled?: boolean;
    provider?: string | null;
    modelId?: string | null;
    thinking?: ThinkingEffort | null;
    credentials?: JevCredentialMode;
  };
  executionQuality?: ExecutionQuality;
}

/** Stores (string) or removes (null) the Jev API key. The response never contains the key. */
export interface SetJevApiKeyRequest {
  apiKey: string | null;
}

export interface ListProvidersResponse {
  providers: ProviderInfo[];
}

/** Every model the runtime knows for one provider, with or without credentials (for Jev's API-key mode). */
export interface ListProviderModelsResponse {
  models: AgentModelInfo[];
}

export type TestJevResponse =
  | { ok: true; model: ModelSelection; reply: string; elapsedMs: number }
  | { ok: false; message: string };
