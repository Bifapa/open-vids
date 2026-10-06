import type {
  SaveVoiceScriptRequest,
  VoiceCheckRequest,
  VoiceCheckResult,
  VoiceDialect,
  VoiceErrorCode,
  VoicePreset,
  VoiceProviderInfo,
  VoiceScriptIssue,
  VoiceScriptView,
  VoiceSynthesisProgress,
  VoiceSynthesisRequest,
  VoiceSynthesisResult,
} from "@hyperframes/agent-protocol";

/**
 * Voiceover as the runtime sees it: Studio's voice service (the user's providers, presets and dialects under
 * `/api/voice`, the project's script, takes and synthesis under `/api/projects/:id/voice`). A host is bound to one
 * project. Reads are cancellable through their signal. {@link synthesize} writes project files (audio under
 * `assets/voice/`, the takes file), so the turn awaits its end before the checkpoint closes: aborting its signal asks
 * the server to cancel it, but the host keeps waiting for the server's answer (a take may already be committing) and
 * settles without one only after a bounded wait, with `write_unsettled`.
 *
 * Keys never reach the runtime: the agents name a preset the user configured and the server holds the credentials.
 */
export interface VoiceHost {
  /** The user's saved voices (`GET /api/voice/presets`). */
  presets(signal: AbortSignal): Promise<VoicePreset[]>;
  /** One saved voice; null when there is no such preset. */
  getPreset(id: string, signal: AbortSignal): Promise<VoicePreset | null>;
  /** The five providers with their state and the user's rules for the agent. */
  providers(signal: AbortSignal): Promise<VoiceProviderInfo[]>;
  /** The script dialects the server knows (`GET /api/voice/dialects`). */
  dialects(signal: AbortSignal): Promise<VoiceDialect[]>;
  /** The project's script: voice, dialect, lines with their takes. */
  script(signal: AbortSignal): Promise<VoiceScriptView>;
  /** Replaces the script's lines (takes of lines that keep their id survive). */
  saveScript(request: SaveVoiceScriptRequest, signal: AbortSignal): Promise<VoiceScriptView>;
  /** Sets (or clears) the project's voice from a saved preset. */
  setProjectVoice(presetId: string | null, signal: AbortSignal): Promise<VoiceScriptView>;
  /** Dialect check and estimate; nothing is paid. */
  check(request: VoiceCheckRequest, signal: AbortSignal): Promise<VoiceCheckResult>;
  /**
   * Generates the takes of the request's lines and answers when they are written. `onProgress` is called with the
   * server's progress while the call runs (best effort).
   */
  synthesize(
    request: Omit<VoiceSynthesisRequest, "requestId">,
    signal: AbortSignal,
    onProgress?: (progress: VoiceSynthesisProgress) => void,
  ): Promise<VoiceSynthesisResult>;
}

/** Failures that do not come from the service's own answer: transport, cancellation and an unsettled write. */
export type VoiceToolErrorCode =
  | VoiceErrorCode
  | "studio_unavailable"
  | "aborted"
  | "write_unsettled";

/**
 * A voice failure the model can act on: a stable code, a message (keys are scrubbed by the server), the service's
 * parameters (`retryAfterSeconds`, `daily`, `contentType`, `body`) and, for a script the dialect refuses, the issues.
 */
export class VoiceToolError extends Error {
  readonly code: VoiceToolErrorCode;
  readonly params: Record<string, string | number>;
  readonly issues: readonly VoiceScriptIssue[];

  constructor(
    code: VoiceToolErrorCode,
    message: string,
    params: Record<string, string | number> = {},
    issues: readonly VoiceScriptIssue[] = [],
  ) {
    super(message);
    this.name = "VoiceToolError";
    this.code = code;
    this.params = params;
    this.issues = issues;
  }
}
