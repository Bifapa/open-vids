import {
  COMPOSITION_FRAME_LIMITS,
  EDIT_LIMITS,
  isRecord,
  type AgentId,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import type { HostTool, HostToolResult, ToolActivity } from "../backend.js";
import { withInheritedTools } from "../agents/inherit.js";

export const FRAMES_TOOL_NAMES = { composition: "inspect_composition" } as const;

export type FramesToolName = (typeof FRAMES_TOOL_NAMES)[keyof typeof FRAMES_TOOL_NAMES];

export function isFramesToolName(name: string): name is FramesToolName {
  return Object.values<string>(FRAMES_TOOL_NAMES).includes(name);
}

type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolResult>;

/**
 * Who can look at the composition: everyone who changes how it looks or judges it. When one of those specialists is off
 * in the chat the Director inherits the tool (it has it anyway). Jev, Research and Audio have no reason to look.
 */
export function framesToolsFor(agent: AgentId, enabled: readonly SpecialistId[]): FramesToolName[] {
  return withInheritedTools(agent, enabled, (who): FramesToolName[] => {
    switch (who) {
      case "director":
      case "editor":
      case "motion":
      case "vision":
        return [FRAMES_TOOL_NAMES.composition];
      default:
        return [];
    }
  });
}

/** The working rule for roles: look at the result of your own work here instead of rendering a video. */
export const FRAMES_ROLE_PROMPT = `Composition frames: inspect_composition (up to ${COMPOSITION_FRAME_LIMITS.times} seconds on the timeline per call, optional composition) shows the composition as the preview shows it — video, titles, captions, graphics — as small images, without rendering a video. Look at the result of your own work with it instead of rendering: after a batch of edits check the moments that matter (a title appearing, a caption over a cut, an overlay, the first and last second) and fix what you see. A frame has no audio, and a turn has a frame budget (frames of an unchanged project are cached and free): pick the times with intent instead of sampling evenly.`;

const DESCRIPTION = `Look at frames of a composition as the preview shows them — video, images, text, captions and graphics at their timeline positions — as JPEG images, without rendering a video (seconds, not minutes). Pass times: seconds on the composition timeline, at most ${COMPOSITION_FRAME_LIMITS.times} per call; a time at or past the end shows the last readable frame. Use it to check your own result (a title in frame, captions not colliding with other graphics, the right B-roll under a cut, nothing black or out of frame) instead of rendering a video; pick the moments that matter, not an even sampling. Defaults to the main composition; pass composition to look at another one. Frames show the composition as it is on disk now and carry no audio. The turn has a frame budget (Execution Quality): a call that would exceed it is refused; frames of a project that has not changed since they were captured are cached and cost nothing.`;

const PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    times: {
      type: "array",
      minItems: 1,
      maxItems: COMPOSITION_FRAME_LIMITS.times,
      description: "Seconds on the composition timeline (0 = start).",
      items: { type: "number", minimum: 0, maximum: EDIT_LIMITS.maxTime },
    },
    composition: {
      type: "string",
      maxLength: EDIT_LIMITS.pathChars,
      description: "Project-relative composition path; defaults to the main composition.",
    },
  },
  required: ["times"],
  additionalProperties: false,
};

function activity(args: unknown): ToolActivity {
  const count = isRecord(args) && Array.isArray(args.times) ? args.times.length : 0;
  return {
    category: "inspect",
    label: `Looking at ${count === 1 ? "1 frame" : `${count} frames`} of the composition`,
    labelCode: "inspecting_composition",
    labelParams: { count },
  };
}

/** The frame tools of one agent; every call goes to `execute` (the running turn's frames executor). */
export function buildFrameTools(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  execute: Executor,
): HostTool[] {
  return framesToolsFor(agent, enabled).map((name) => ({
    name,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    execute: (args, signal) => execute(name, args, signal),
    activity,
  }));
}
