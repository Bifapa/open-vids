import type {
  ActiveTurnInfo,
  AgentErrorCode,
  AgentModelInfo,
  AgentSettings,
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
  ThinkingEffort,
  TurnSummary,
} from "./types.js";

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
}

export interface StartTurnRequest {
  prompt: string;
  references?: MessageReference[];
  editorContext?: EditorContext;
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
