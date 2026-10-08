import type {
  ActiveTurnInfo,
  AgentErrorCode,
  AgentRun,
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
  QuestionRequest,
  SpecialistConfig,
  SpecialistDefaults,
  PermissionDecision,
  PermissionRequest,
  SpecialistId,
  DesignAction,
  DesignActionOptions,
  StoryAction,
  StoryActionOptions,
  StoryOffer,
  ThinkingEffort,
  TurnSummary,
} from "./types.js";
import type { ExecutionQuality } from "./qa.js";
import type { VoicePilotRequest, VoiceSetupRequest } from "./voice.js";

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
 * Project ids and directories may hold any Unicode (a Russian project name, a folder under `~/Видео`), but HTTP
 * header values must be Latin-1, so the gateway percent-encodes the project scope and the runtime decodes it.
 */
export function encodeScopeHeader(value: string): string {
  return encodeURIComponent(value);
}

/** The decoded scope header; null when absent or not valid percent-encoding. */
export function decodeScopeHeader(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

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
  /** The chat's intent (Edit / Ask) for its next turns. */
  intent?: ChatIntent;
  /** The chat's own Execution Quality; null returns the chat to the global default. */
  executionQuality?: ExecutionQuality | null;
  /** Linked sites the user removed from this chat (replaces the list); the runtime then refuses them. */
  excludedSites?: string[];
}

export interface StartTurnRequest {
  prompt: string;
  references?: MessageReference[];
  editorContext?: EditorContext;
  /** Mode of this turn; defaults to the chat's `activeMode`. A story action implies `story`. */
  mode?: ChatMode;
  /**
   * What the user wants from this turn; defaults to the chat's `intent`, else `edit`. Ask turns change nothing. A
   * story action and an execute-plan request always run as `edit`.
   */
  intent?: ChatIntent;
  /**
   * "Carry out the plan": the user approved a plan proposal of this chat, identified by the turn that published it.
   * The runtime adds the approved steps to the prompt and the Director carries them out; it never proposes again in
   * that turn. Refused when the turn carries no plan proposal, and never combined with a story action.
   */
  executePlan?: { turnId: string };
  /** Run a Story workspace action (Review with AI / Build Story / Rebuild affected sections) as this turn. */
  storyAction?: StoryAction;
  /** The user's choices for a `build` or `rebuild` action; refused with any other action. */
  storyOptions?: StoryActionOptions;
  /**
   * Run a Design Systems action ("create from this project", "edit the system") as this turn. Always an `edit`
   * turn in the chat's mode; never combined with a story action or an executePlan. The prompt is the user's brief.
   */
  designAction?: DesignAction;
  designOptions?: DesignActionOptions;
  /**
   * `auto`: the user started the project with the frame format on Auto, so the composition's current size is only a
   * placeholder and the agent must decide the format from the brief and the footage before building (edit_timeline's
   * `set_canvas`). Absent: the composition's size is the user's choice.
   */
  canvas?: "auto";
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
  /** Files the steering message attaches. */
  references?: MessageReference[];
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

/**
 * `POST /v1/chats/:chatId/turns/:turnId/permissions/:permissionId` — the user's answer to a {@link PermissionRequest}
 * shown in the chat. `always` switches the setting on, `once` allows it for the rest of the turn; the waiting tool
 * call then continues. Answers the request in its new state; a request that is no longer pending is
 * `turn_not_active`.
 */
export interface AnswerPermissionRequest {
  decision: PermissionDecision;
}

export interface AnswerPermissionResponse {
  permission: PermissionRequest;
}

/** The user's answer to a {@link StoryOffer} card. */
export const STORY_OFFER_DECISIONS = ["accept", "decline"] as const;
export type StoryOfferDecision = (typeof STORY_OFFER_DECISIONS)[number];

/**
 * `POST /v1/chats/:chatId/turns/:turnId/story-offers/:offerId` — the user's answer to the Story Mode offer card.
 * `accept`: the runtime writes the chapters into the Story Graph (no model) and marks the offer accepted; `decline`:
 * the chat records the decline and the offer becomes declined. Unlike a permission, a pending offer stays answerable
 * after its own turn ends; a new user turn expires it.
 */
export interface AnswerStoryOfferRequest {
  decision: StoryOfferDecision;
}

export interface AnswerStoryOfferResponse {
  offer: StoryOffer;
}

/**
 * `POST /v1/chats/:chatId/turns/:turnId/questions/:questionId` — the user's answer to a {@link QuestionRequest}:
 * one of its suggested options or free text. Answers the question once; an expired or answered question is refused
 * (409 `turn_not_active`).
 */
export interface AnswerQuestionRequest {
  answer: string;
}

export interface AnswerQuestionResponse {
  question: QuestionRequest;
}

/**
 * `POST /v1/chats/:chatId/turns/:turnId/voice-setups/:setupId` — the user's answer to a voice-setup card: the
 * saved preset to use (`{ presetId }`) or `{ decline: true }` ("Not now"). Body: `AnswerVoiceSetupRequest`
 * (voice.ts). The waiting `request_voice_setup` call continues. An expired or answered card is refused (409
 * `turn_not_active`), an unknown preset 400 `invalid_request`.
 */
export interface AnswerVoiceSetupResponse {
  setup: VoiceSetupRequest;
}

/**
 * `POST /v1/chats/:chatId/turns/:turnId/voice-pilots/:pilotId` — the user's verdict on the pilot line: approve (the
 * rest is generated) or change with a note for the agent. Body: `AnswerVoicePilotRequest` (voice.ts). A pilot that is
 * no longer pending is refused (409 `turn_not_active`).
 */
export interface AnswerVoicePilotResponse {
  pilot: VoicePilotRequest;
}

/**
 * `POST /v1/chats/:chatId/turns/:turnId/runs/:runId/cancel` — the user stops one delegated run; the turn and the
 * other runs go on. The run ends `cancelled`.
 */
export interface CancelRunRequest {
  /** A short note for the Director's report ("the user stopped this task"); optional. */
  reason?: string;
}

export interface CancelRunResponse {
  run: AgentRun;
}

/**
 * `DELETE /v1/chats/:chatId` — removes the chat and its stored events. Refused with 409 `chat_busy` while the chat
 * runs a turn. Takes no body; the project then publishes a `chat.deleted` event.
 */
export interface DeleteChatResponse {
  chatId: string;
}

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
  /**
   * `auto`: the user left the frame format on Auto ("let the agent decide"), so the project was scaffolded with the
   * preferred size as a placeholder and the first turn must choose the format itself. Absent: the fixed size the
   * project was created with.
   */
  format?: "auto";
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
  extendedContext?: boolean;
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

/**
 * One short, tool-less completion that names a project being started (`POST /project-title`). Home calls it while
 * the Start button is busy; any failure makes it fall back to its own derivation.
 */
export interface ProjectTitleRequest {
  /** What the user described; the title must fit this prompt. */
  prompt: string;
  /** Names (never paths) of the files the project will import; may be empty. */
  files: string[];
  /** The composer's chosen model; null asks for the runtime's Main default. */
  model: ModelSelection | null;
  /** UI language the title must be written in (`en`, `ru`, …); null follows the prompt's own language. */
  language: string | null;
}

export interface ProjectTitleResponse {
  title: string;
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
