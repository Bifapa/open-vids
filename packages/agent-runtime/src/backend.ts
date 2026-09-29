import type {
  AgentModelCatalog,
  ModelSelection,
  ThinkingEffort,
} from "@hyperframes/agent-protocol";

/**
 * The OpenVids-owned boundary in front of the harness that actually runs the
 * Director (OMP today). Everything above this file (chat store, turn runner,
 * HTTP server, Studio) is harness-agnostic; everything that names OMP lives in
 * `./omp/` and is imported only by `main.ts`.
 *
 * A backend reports what happened as normalized {@link BackendEvent}s. It never
 * decides message/part ids, activity folding, checkpoints or persistence.
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
    }
  | { type: "tool.end"; toolCallId: string; ok: boolean };

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
  /** Absolute project directory: the only tree the Director may read or change. */
  projectDir: string;
  /** Absolute directory reserved for this chat's harness-private state; created on demand. Reopening it resumes the conversation. */
  stateDir: string;
}

export interface AgentBackend {
  /** Informational name reported by /health. */
  readonly name: string;
  listModels(): Promise<AgentModelCatalog>;
  openSession(input: OpenBackendSessionInput): Promise<BackendSession>;
  dispose(): Promise<void>;
}
