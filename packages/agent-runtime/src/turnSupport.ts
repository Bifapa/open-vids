import type { TurnSummary } from "@hyperframes/agent-protocol";
import type { ProjectScope } from "./checkpointHost.js";
import type { AnalysisHost } from "./analysis/host.js";
import type { EditingHost } from "./editing/host.js";
import { EDITING_TOOL_NAMES } from "./editing/tools.js";
import { ANALYSIS_TOOL_NAMES } from "./analysis/tools.js";
import type { StoryHost } from "./story/host.js";
import type { DesignHost } from "./design/host.js";
import type { ResearchHost } from "./research/host.js";
import type { FramesHost } from "./editing/frames.js";
import type { CrossProjectHost } from "./crossProject/host.js";
import type { QaHost } from "./qa/host.js";
import type { StreamTimerApi } from "./turnStream.js";
import type { VoiceHost } from "./voice/host.js";

export interface TurnRunnerOptions {
  now?: () => number;
  ids?: () => string;
  sessionIdleMs?: number;
  timers?: StreamTimerApi;
  /** How often a running turn renews its project transaction (default 20 s; must stay well under the host's lease). */
  renewIntervalMs?: number;
  /** How long aborted delegated runs may take to stop before their sessions are force-closed (default 10 s). */
  stopGraceMs?: number;
  /**
   * Opens the editing host of a project. Without it the agents get no editing tools (inspect/edit/render); the
   * production runtime always provides it.
   */
  editing?: (scope: ProjectScope) => EditingHost;
  /**
   * Opens the analysis host (long-form transcription, speakers, shots, take issues, cut plans) of a project. Without
   * it the agents get no analysis tools; the production runtime always provides it.
   */
  analysis?: (scope: ProjectScope) => AnalysisHost;
  /** How often a running analysis job is polled (default 750 ms). */
  analysisPollMs?: number;
  /**
   * Opens the story host (the Story Graph, story edits and Build Story) of a project. Without it the agents get no
   * story tools; the production runtime always provides it.
   */
  story?: (scope: ProjectScope) => StoryHost;
  /**
   * Opens the design host (the design-system library, the project's attached snapshot and extraction) of a project.
   * Without it a design action is refused and the agents get no design tools; the production runtime always provides it.
   */
  design?: (scope: ProjectScope) => DesignHost;
  /**
   * Opens the research host (the Asset Search policy, finding and importing outside material, the project's sources)
   * of a project. Without it the agents get no research tools and renders report no license check; the production
   * runtime always provides it.
   */
  research?: (scope: ProjectScope) => ResearchHost;
  /**
   * Opens the QA host (render checks, frames of a render, the stored reports) of a project. Without it — or without an
   * editing host, which renders — no turn runs autonomous render QA; the production runtime always provides both.
   */
  qa?: (scope: ProjectScope) => QaHost;
  /**
   * Opens the frames host (composition frames without a render) of a project. Without it the agents get no
   * inspect_composition tool; the production runtime always provides it.
   */
  frames?: (scope: ProjectScope) => FramesHost;
  /**
   * Opens the cross-project host (the manifests of the other projects the user attached with `#`, and copying their
   * files) of a project. Without it the agents get no import_from_project tool and no <attached-projects> block;
   * the production runtime always provides it.
   */
  crossProject?: (scope: ProjectScope) => CrossProjectHost;
  /**
   * Opens the voice host (the user's voice providers and saved voices, the project's script and takes, synthesis) of a
   * project. Without it the agents get no voice tools and their prompts say nothing about voiceover; the production
   * runtime always provides it.
   */
  voice?: (scope: ProjectScope) => VoiceHost;
  /**
   * How long the Director's model may stay silent (no event at all, no tool of its own running) before the turn is
   * stopped with a clear error (default 10 minutes). Delegated runs have their own watchdog.
   */
  promptStallMs?: number;
}

/** What a story-mode turn (plan/review) says when an agent tries to write the timeline anyway. */
export const STORY_TURN_TIMELINE_REFUSAL =
  "This is a Story Mode turn: the timeline is not changed here. Shape the story with edit_story; the user builds it into the timeline with Build Story.";

/** Tools that write the timeline (or start a render of it): refused in story-mode turns that do not build the story. */
export function writesTimeline(name: string): boolean {
  return (
    name === EDITING_TOOL_NAMES.edit ||
    name === EDITING_TOOL_NAMES.render ||
    name === ANALYSIS_TOOL_NAMES.build
  );
}

/** What a design turn says when an agent tries to write the timeline or a composition anyway. */
export const DESIGN_TURN_REFUSAL =
  "This is a Design Systems turn: it writes only the design library (and the project's design/ folder through attach_design_system), never compositions or the timeline. Applying a system to existing compositions is a separate step the user approves; tell them it is saved and what applying would change.";

/** The harness's own file-writing tools: they change project files without going through any host tool. */
export function writesProjectFiles(name: string): boolean {
  return name === "edit" || name === "write";
}

/** The history label of a turn's transaction; recovery rebuilds it from the persisted prompt, so it must be pure. */
export function checkpointLabel(prompt: string): string {
  return `Director: ${prompt.slice(0, 60)}`;
}

export function cloneTurn(turn: TurnSummary): TurnSummary {
  return {
    ...turn,
    model: turn.model ? { ...turn.model } : null,
    checkpoint: turn.checkpoint
      ? { ...turn.checkpoint, entryIds: [...turn.checkpoint.entryIds] }
      : null,
    ...(turn.error && { error: { ...turn.error } }),
  };
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
