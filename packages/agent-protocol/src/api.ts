import type {
  ActiveTurnInfo,
  AgentErrorCode,
  AgentModelInfo,
  AgentSettings,
  AutonomySettings,
  ChatIntent,
  ChatMode,
  ChatState,
  ChatSummary,
  CodedMessageParams,
  EditorContext,
  JevCredentialMode,
  MessageReference,
  ModelConfig,
  ModelSelection,
  OAuthFlow,
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

/**
 * A message the UI can translate: `code` names an `errors.<code>` locale key, `params` fills its placeholders.
 * The server always sends the English `message` too (the fallback and the log line).
 */
export interface CodedMessage {
  code: string;
  params?: CodedMessageParams;
}

export interface AgentErrorBody {
  error: {
    code: AgentErrorCode;
    message: string;
    params?: CodedMessageParams;
    details?: Record<string, unknown>;
  };
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
  /**
   * The user's UI language as a BCP-47 code (`en`, `ru`, …). The agents answer in that language;
   * absent means English behaviour.
   */
  userLanguage?: string;
}

export interface StartTurnResponse {
  turn: TurnSummary;
}

export interface SteerTurnRequest {
  text: string;
  editorContext?: EditorContext;
  /**
   * The user's UI language as a BCP-47 code (`en`, `ru`, …). The agents answer in that language;
   * absent means English behaviour.
   */
  userLanguage?: string;
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
  /** Fields omitted keep their value. */
  autonomy?: Partial<AutonomySettings>;
}

/** Stores (string) or removes (null) the Jev API key. The response never contains the key. */
export interface SetJevApiKeyRequest {
  apiKey: string | null;
}

/**
 * Stores (string) or removes (null) the API key OpenVids keeps for one provider (`POST /providers/:provider/api-key`).
 * The key is never returned by any route.
 */
export interface SetProviderApiKeyRequest {
  apiKey: string | null;
}

/** Starts a sign-in (`POST /providers/:provider/oauth/login`); an empty body picks the provider's default flow. */
export interface StartOAuthLoginRequest {
  flow?: OAuthFlow;
}

/** The user's answer to the prompt of a sign-in (`POST /oauth/logins/:id/input`): a pasted code or redirect URL. */
export interface SubmitOAuthLoginInputRequest {
  text: string;
}

/** The provider list; also the answer to saving/removing a provider key and to a forced refresh. */
export interface ListProvidersResponse {
  providers: ProviderInfo[];
  /** When (epoch ms) the model catalog last synced successfully with the providers; null if it never did. */
  syncedAt: number | null;
}

/** Every model the runtime knows for one provider, with or without credentials (for Jev's API-key mode). */
export interface ListProviderModelsResponse {
  models: AgentModelInfo[];
}

export type TestJevResponse =
  | { ok: true; model: ModelSelection; reply: string; elapsedMs: number }
  | { ok: false; message: string };
