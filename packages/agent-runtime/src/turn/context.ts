import type {
  ActiveTurnInfo,
  AssistantMessage,
  ChatIntent,
  ChatMode,
  PlanApproval,
  PlanStep,
  StoryAction,
  StoryActionOptions,
  StoryOffer,
  TurnCheckpoint,
  TurnSummary,
} from "@hyperframes/agent-protocol";
import type { AgentBackend, BackendSession } from "../backend.js";
import type { Orchestrator, TurnAgentSetup } from "../agents/orchestrator.js";
import type { TurnAnalysis } from "../analysis/executor.js";
import type { CheckpointHandle, CheckpointHost } from "../checkpointHost.js";
import type { ChatService } from "../chats.js";
import type { TurnEditing } from "../editing/executor.js";
import type { TurnCrossProject } from "../crossProject/executor.js";
import type { TurnFrames } from "../editing/frames.executor.js";
import { RuntimeError } from "../errors.js";
import type { PermissionBroker } from "../permissions.js";
import type { QaPhase } from "../qa/loop.js";
import type { TurnQa } from "../qa/executor.js";
import type { QuestionBroker } from "../questions.js";
import type { TurnResearch } from "../research/executor.js";
import type { WebsiteResourceLog } from "../research/websiteResources.js";
import type { SessionManager } from "../sessionManager.js";
import type { AgentSettingsStore } from "../settings.js";
import type { TurnStory } from "../story/executor.js";
import type { FileChatStore } from "../store/index.js";
import type { StreamTimerApi, StreamTimerHandle } from "../turnStream.js";
import type { TurnRunnerOptions } from "../turnSupport.js";
import type { WriteLeases } from "../writeLeases.js";
import type { ChangeTally } from "./changes.js";
import type { PromptWatchdog } from "./watchdog.js";

/** The plan a turn carries out, as proposed; `projectFingerprint` is the project's state when it was proposed. */
export interface ExecutePlan {
  turnId: string;
  steps: PlanStep[];
  projectFingerprint?: string;
}

/** Everything one running turn owns. The runner keeps at most one per project. */
export interface ActiveRun {
  chatId: string;
  turn: TurnSummary;
  assistantMessage: AssistantMessage;
  controller: AbortController;
  checkpoint: CheckpointHandle | null;
  session: BackendSession | null;
  setup: TurnAgentSetup | null;
  orchestrator: Orchestrator | null;
  /** The turn's editing tools; closed and awaited before the checkpoint ends. */
  editing: TurnEditing | null;
  /** The turn's composition-frame tool; closed and awaited before the checkpoint ends. */
  frames: TurnFrames | null;
  /** The turn's analysis tools; closed (jobs cancelled, calls awaited) before the checkpoint ends. */
  analysis: TurnAnalysis | null;
  /** The turn's story tools; closed (in-flight edits/builds awaited) before the checkpoint ends. */
  story: TurnStory | null;
  /** The turn's research tools; closed (in-flight imports and resolutions awaited) before the checkpoint ends. */
  research: TurnResearch | null;
  /**
   * The turn's cross-project tool (copying files of the projects the user attached with `#`); closed and awaited
   * before the checkpoint ends. Null when the runtime has no cross-project host.
   */
  crossProject: TurnCrossProject | null;
  /** `import_from_project` is in the sessions' tool lists this turn (some project was attached when it began). */
  crossProjectOffered: boolean;
  /**
   * The turn's permission requests: a website tool whose setting is off asks the user from the chat and waits here.
   * Expired at the turn's end so no waiting call hangs; the turn's grant is revoked then too.
   */
  permissions: PermissionBroker | null;
  /** The questions agents asked the user (`request_input`); expired at the turn's end like permissions. */
  questions: QuestionBroker | null;
  /** The turn's render QA (service calls and Vision's review tools); closed and awaited before the checkpoint ends. */
  qa: TurnQa | null;
  /** Where the turn is in render QA: tools are refused accordingly (see qa/phase.ts). */
  qaPhase: QaPhase;
  /** The mode the turn runs in (a story action implies `story`). */
  mode: ChatMode;
  /** What the user wants from the turn: an Ask turn never changes the project. */
  intent: ChatIntent;
  /** The user's plan-approval setting for this turn (from the global settings as the turn started). */
  planApproval: PlanApproval;
  /** The approved plan this turn carries out, if the user started it from a proposal. */
  executePlan: ExecutePlan | null;
  /** The Story workspace action the turn runs, if any. */
  storyAction: StoryAction | null;
  /** The user's choices for a build/rebuild action (scope, manual-edit policy, locked chapters), if any. */
  storyOptions: StoryActionOptions | null;
  /** Whether this turn may offer Story Mode at all (the tool and the prompt block go together). */
  storyOfferEligible: boolean;
  /** The offer this turn published, if any: another one is refused and project changes stop until answered. */
  storyOffer: StoryOffer | null;
  /** What the turn's tools applied to the project, for `TurnSummary.changes`. */
  changes: ChangeTally;
  /** A project-changing tool (or a delegation) was called this turn, whether it landed or was refused. */
  workAttempted: boolean;
  /** The Director's prompt has ended but the turn is still collecting delegated work. */
  directorIdle: boolean;
  /** The first Director prompt has been handed to the model; steering before that rides on it. */
  firstPromptSent: boolean;
  /** Steering received while the Director could not take it (setup, idle, a failed steer): opens its next prompt. */
  pendingSteering: string[];
  /** Bounds the Director's current prompt; set while one runs. */
  watchdog: PromptWatchdog | null;
  task: Promise<void> | null;
  forcedError: unknown | null;
  finalizing: boolean;
  heartbeat: StreamTimerHandle | null;
}

/** The delegated run a specialist or Jev session serves; null while it serves none. */
export interface RunSlot {
  runId: string | null;
}

/** The services and state every module of the turn runner shares. `active` and `revertingChatId` are the only mutable parts. */
export interface TurnContext {
  readonly chats: ChatService;
  readonly backend: AgentBackend;
  readonly checkpoints: CheckpointHost;
  readonly store: FileChatStore;
  readonly settings: AgentSettingsStore;
  readonly options: TurnRunnerOptions;
  readonly timers: StreamTimerApi;
  readonly sessions: SessionManager;
  readonly leases: WriteLeases;
  /** Chats whose last turn ended while Studio could not close its checkpoint: recovered on the next attempt. */
  readonly recoverChats: Set<string>;
  /** Chats being deleted: reserved before the first await, so a turn or revert cannot start on one. */
  readonly deletingChats: Set<string>;
  /**
   * Which delegated run each chat's resumable specialist session serves right now (`chatId|agent`): the session's
   * closures outlive the run, so the run it works for is rebound whenever a new run takes the session.
   */
  readonly runSlots: Map<string, RunSlot>;
  /** Files the linked sites' reads listed, per chat: full access may fetch exactly these (see websiteResources.ts). */
  readonly websiteResources: WebsiteResourceLog;
  readonly now: () => number;
  readonly ids: () => string;
  readonly renewIntervalMs: number;
  readonly promptStallMs: number;
  active: ActiveRun | null;
  revertingChatId: string | null;
}

export interface ChatTurnTarget {
  turn: TurnSummary;
  checkpoint: TurnCheckpoint | null;
}

export function turnInfo(run: ActiveRun): ActiveTurnInfo {
  return { chatId: run.chatId, turnId: run.turn.id, startedAt: run.turn.startedAt };
}

/**
 * The error a request gets while the project is busy: a running turn, revert or deletion of this chat is `chat_busy`,
 * of another chat `project_busy` (a deletion only touches its own chat, so it never blocks the others). Null when
 * nothing is in the way.
 */
export function busyError(ctx: TurnContext, chatId: string): RuntimeError | null {
  if (ctx.deletingChats.has(chatId))
    return new RuntimeError("chat_busy", "This chat is being deleted", 409);
  if (ctx.active) {
    if (ctx.active.chatId === chatId)
      return new RuntimeError("chat_busy", "This chat has a running turn", 409);
    return new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
      activeTurn: turnInfo(ctx.active),
    });
  }
  if (ctx.revertingChatId) {
    if (ctx.revertingChatId === chatId)
      return new RuntimeError("chat_busy", "This chat is being reverted", 409);
    return new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
      activeTurn: null,
    });
  }
  return null;
}
