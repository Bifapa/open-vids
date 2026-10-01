import type {
  AgentId,
  AgentModelCatalog,
  AgentModelInfo,
  ListProvidersResponse,
  ModelSelection,
  OAuthFlow,
  OAuthLoginState,
  ThinkingEffort,
} from "@hyperframes/agent-protocol";

/**
 * The OpenVids-owned boundary in front of the harness that actually runs the
 * agents — Director, specialists, Jev (OMP today). Everything above this file
 * (chat store, turn runner, orchestrator, HTTP server, Studio) is
 * harness-agnostic; everything that names OMP lives in `./omp/` and is imported
 * only by `main.ts`.
 *
 * A backend reports what happened as normalized {@link BackendEvent}s. It never
 * decides message/part ids, activity folding, delegation, checkpoints or persistence.
 */

/** What kind of project work a tool call was; the adapter maps raw tool names onto this. */
export type BackendToolKind = "inspect" | "search" | "edit" | "other";

export type BackendEvent =
  /** The model/effort that will actually run (after defaults were resolved). Emitted once per prompt. */
  | { type: "model.resolved"; model: ModelSelection; thinking: ThinkingEffort | null }
  | { type: "text.delta"; delta: string }
  | { type: "thinking.delta"; delta: string }
  /** The current thinking block ended. */
  | { type: "thinking.end" }
  | {
      type: "tool.start";
      toolCallId: string;
      kind: BackendToolKind;
      /** Project-relative paths or short display targets; never raw tool arguments. */
      targets: string[];
      /**
       * A product-level row label ("Editing the timeline · 3 changes"), set only for runtime tools that declare an
       * activity. A labelled call is shown as its own row and never folds into a file-activity group.
       */
      label?: string;
    }
  | { type: "tool.end"; toolCallId: string; ok: boolean }
  /** A running host tool's determinate progress, 0–100 (a render). */
  | { type: "tool.progress"; toolCallId: string; progress: number };

/** An image a tool shows to the model (base64, without a data-URL prefix). */
export interface HostToolImage {
  mimeType: string;
  data: string;
}

/** What a runtime-provided tool returns to the model. */
export interface HostToolResult {
  text: string;
  isError?: boolean;
  /** Shown to the model after the text (e.g. video frames); a backend without image input ignores them. */
  images?: HostToolImage[];
}

/**
 * A tool the runtime (not the harness) implements: delegation, plan updates, Jev, editing. The backend exposes it to
 * the model next to its own project-file tools. Its calls are not reported as file activity: the runtime emits its own
 * product-level events for orchestration tools, and a tool that declares {@link HostTool.activity} gets one labelled
 * activity row per call.
 */
export interface HostTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
  /** `progress` reports determinate progress (0–100) of a long call, such as a render; optional for the backend. */
  execute(
    args: unknown,
    signal: AbortSignal,
    progress?: (percent: number) => void,
  ): Promise<HostToolResult>;
  /** The activity row this call shows, from its (untrusted) arguments; null or absent keeps the call hidden. */
  activity?(args: unknown): { category: BackendToolKind; label: string } | null;
}

export interface BackendPromptInput {
  /** The fully rendered user text (editor context and references already folded in by the runtime). */
  text: string;
  /** Explicit per-chat choices; null means "backend default". */
  model: ModelSelection | null;
  thinking: ThinkingEffort | null;
  /** Aborting must end the prompt promptly and resolve it with `"aborted"`. */
  signal: AbortSignal;
  onEvent: (event: BackendEvent) => void;
}

export type BackendPromptOutcome = "completed" | "aborted";

/** A live conversation with the harness for one chat. */
export interface BackendSession {
  /**
   * Runs one user turn to its end. Resolves `"completed"` or `"aborted"`;
   * rejects with an Error for any failure (the runner turns that into turn.failed).
   * Steering text delivered through {@link steer} while this is pending is
   * handled inside the same promise.
   */
  prompt(input: BackendPromptInput): Promise<BackendPromptOutcome>;
  /** Redirects the running turn. Only called while `prompt` is pending. */
  steer(text: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface OpenBackendSessionInput {
  chatId: string;
  /** Which agent this session runs; informational for the harness (naming, logs). */
  agent: AgentId;
  /** Absolute project directory: the only tree the agent may read or change. */
  projectDir: string;
  /**
   * Absolute directory reserved for this session's harness-private state; created on demand. Reopening it resumes
   * the conversation. Null: an ephemeral session that keeps nothing on disk.
   */
  stateDir: string | null;
  /** The agent's role instructions (system prompt), owned by the runtime. */
  instructions: string;
  hostTools: HostTool[];
  /** Explicit credentials for this session only (Jev's API-key mode); never shared with other sessions. */
  credentials?: { provider: string; apiKey: string };
  /**
   * Asked before each call of the harness's own project-file tools (by tool name, e.g. `edit`, `write`); a string
   * refuses the call with that reason. The runtime uses it to keep Plan and Ask turns from changing files.
   */
  fileWriteRefusal?: (toolName: string) => string | null;
  /**
   * Asked when the harness's own file tools hit a clip the user locked: `true` (the default) tells the agent to stop and
   * ask the user, `false` to leave the clip alone and carry on. The lock itself is enforced either way.
   */
  askBeforeLockedEdits?: () => boolean;
}

/** What {@link AgentBackend.refreshProviders} does. */
export interface RefreshProvidersOptions {
  /** Refresh only this provider's live model list (a key was just saved); omitted: every provider. */
  provider?: string;
  /** Do not contact any provider: re-read credentials and rebuild the catalog from what is known (a key was removed). */
  offline?: boolean;
}

export interface AgentBackend {
  /** Informational name reported by /health. */
  readonly name: string;
  listModels(): Promise<AgentModelCatalog>;
  /**
   * Providers the harness knows with their credential status, and when the catalog last synced. Re-reads the API keys
   * OpenVids stores, so a key saved by another runtime process is applied before this answers.
   */
  listProviders(): Promise<ListProvidersResponse>;
  /**
   * Re-reads every credential source (the user's OMP login, the keys OpenVids stores), re-fetches the providers' live
   * model lists, rebuilds the catalog every session and `listModels` use, and answers with the fresh provider list.
   * Never throws for a provider that fails: that provider's status says so.
   */
  refreshProviders(options?: RefreshProvidersOptions): Promise<ListProvidersResponse>;
  /** Every model of one provider, with or without credentials. */
  listProviderModels(provider: string): Promise<AgentModelInfo[]>;
  /**
   * Starts an in-app OAuth sign-in for a provider (its default flow, or `flow`) and answers once the user has something to
   * act on. One per provider at a time: a second start returns the one in progress. The credential goes to OpenVids' own
   * store, never OMP's. Never opens a browser. Rejects with `invalid_request` when the provider has no in-app sign-in.
   */
  startOAuthLogin(provider: string, flow?: OAuthFlow): Promise<OAuthLoginState>;
  /** A sign-in's state; rejects with `login_not_found` once it is unknown (or long finished). */
  getOAuthLogin(id: string): OAuthLoginState;
  /** Answers the prompt a sign-in is waiting on (a pasted code). */
  submitOAuthLoginInput(id: string, text: string): OAuthLoginState;
  /** Stops a sign-in and its callback listener; safe on a finished one. */
  cancelOAuthLogin(id: string): Promise<OAuthLoginState>;
  /** Removes the sign-in OpenVids stored for a provider (OMP's cannot be removed) and answers with the fresh list. */
  signOutOAuth(provider: string): Promise<ListProvidersResponse>;
  openSession(input: OpenBackendSessionInput): Promise<BackendSession>;
  dispose(): Promise<void>;
}
