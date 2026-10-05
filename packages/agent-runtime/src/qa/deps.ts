import type {
  ChatMode,
  StoryAction,
  TimelineSnapshot,
  TurnSummary,
} from "@hyperframes/agent-protocol";
import type { Orchestrator, TurnAgentSetup } from "../agents/orchestrator.js";
import type { BackendPromptOutcome } from "../backend.js";
import type { ChatService } from "../chats.js";
import type { LastRender } from "../editing/executor.js";
import type { EditingHost } from "../editing/host.js";
import type { TurnQa } from "./executor.js";

/**
 * Where the turn is in QA; the runner refuses tools accordingly (see `qaPhaseRefusal`): `review` — the Director looks
 * at the render in place of a disabled Vision, `correction` — it delegates the fixes, `final` — it only reports.
 */
export type QaPhase = "review" | "correction" | "final" | null;

/** What the loop needs from the turn runner to talk to the Director. */
export interface QaDirector {
  /** Runs one Director prompt and resolves how it ended. */
  prompt(text: string): Promise<BackendPromptOutcome>;
  /** Re-prompts the Director with delegated runs it finished without collecting and with steering, as after its first reply. */
  settle(outcome: BackendPromptOutcome): Promise<BackendPromptOutcome>;
  /** Marks the Director's text written so far in the turn's reply as an interim progress note. */
  markInterim(): Promise<void>;
  /** Steering received while the Director was idle; it opens the next prompt. */
  takeSteering(): string[];
  setPhase(phase: QaPhase): void;
}

export interface QaLoopDeps {
  chats: ChatService;
  chatId: string;
  /** The live turn record; `qa` is kept on it so terminal turn events carry it. */
  turn: TurnSummary;
  qa: TurnQa;
  editing: EditingHost;
  /** What the Director's own `render_video` calls did: whether the user asked for a render, and the last render. */
  renders: { asked(): boolean; last(): LastRender | null };
  orchestrator: Orchestrator;
  setup: TurnAgentSetup;
  mode: ChatMode;
  action: StoryAction | null;
  /** The project's fingerprint when the turn started; null when the QA service could not say. */
  startFingerprint: string | null;
  /**
   * The timeline when the turn started; null when it could not be read. The first pass compares it with the timeline
   * as it is now to see how much the turn changed (the cheap path).
   */
  startTimeline: TimelineSnapshot | null;
  director: QaDirector;
  /**
   * The Director or its team called at least one project-changing tool this turn (whether it succeeded or was refused).
   * With the project unchanged at the end, that is what makes the Director's reply suspect: it may have promised a
   * check, or reported an edit that did not land.
   */
  workAttempted(): boolean;
  /**
   * The Director was told (`<render-qa-pending>`) that a check follows its reply. When QA then does not run although
   * the project changed — or QA turns out to have nothing to check — its reply was interim and it is asked for the
   * final answer.
   */
  instructed?: boolean;
  /** The turn's abort signal. */
  signal: AbortSignal;
  now: () => number;
}

/** Whether the turn is one QA may run in: normal turns, story builds and rebuilds (report-only); never plan/review/resolve. */
export function qaApplies(mode: ChatMode, action: StoryAction | null): boolean {
  return mode !== "story" || action === "build" || action === "rebuild";
}
