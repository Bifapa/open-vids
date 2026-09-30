import {
  CLIP_FITS,
  EDIT_LIMITS,
  EDIT_OPERATION_NAMES,
  PRESET_KINDS,
  TEXT_PLACEMENTS,
  TEXT_SIZES,
  isRecord,
  type AgentId,
  type EditOperationName,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import type { BackendToolKind, HostTool, HostToolResult } from "../backend.js";
import { RENDER_QUALITIES } from "./host.js";

export const EDITING_TOOL_NAMES = {
  project: "inspect_project",
  timeline: "inspect_timeline",
  edit: "edit_timeline",
  presets: "browse_presets",
  render: "render_video",
} as const;

export type EditingToolName = (typeof EDITING_TOOL_NAMES)[keyof typeof EDITING_TOOL_NAMES];

export function isEditingToolName(name: string): name is EditingToolName {
  return Object.values<string>(EDITING_TOOL_NAMES).includes(name);
}

type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolResult>;

/**
 * Which editing tools an agent gets. The Director edits the timeline itself only when there is no Editor to delegate
 * to; specialists get what their domain needs. Jev gets none.
 */
export function editingToolsFor(
  agent: AgentId,
  enabled: readonly SpecialistId[],
): EditingToolName[] {
  const { project, timeline, edit, presets, render } = EDITING_TOOL_NAMES;
  switch (agent) {
    case "director":
      return enabled.includes("editor")
        ? [project, timeline, presets, render]
        : [project, timeline, presets, render, edit];
    case "editor":
      return [project, timeline, presets, render, edit];
    case "motion":
      return [project, timeline, presets, edit];
    case "audio":
      return [project, timeline, edit];
    case "vision":
    case "research":
      return [project, timeline, presets];
    default:
      return [];
  }
}

// ── Descriptions ─────────────────────────────────────────────────────────────

const CONVENTIONS = `Conventions: all times are seconds on the composition timeline (0 = start). Clip ids come from inspect_timeline and from the results of your own edits; assets are project-relative paths from inspect_project. Track 0 is the A-roll: the main story, audible. Higher tracks are B-roll and overlays (their video is muted; they are drawn on top of lower tracks because newer clips get a higher z-index) and titles. Music and sound effects are audio clips on tracks of their own: music at volume about 0.2–0.4 under speech with a 1–2 s fadeIn/fadeOut, sound effects as loud as they need to be.`;

const EDIT_OPERATIONS_GUIDE = `Operations (each has "op" plus):
- add_clip: asset, start, track; optional duration (default: rest of the media; 3 s for images), mediaStart (in-point in the source), volume (0–${EDIT_LIMITS.maxVolume}), muted, fit ("contain"|"cover"), frame ({x, y, width, height} in composition pixels, e.g. a logo in a corner; default: the media centred inside the frame), fadeIn/fadeOut (seconds of linear audio/video gain ramp at the clip start/end; use 1–2 s on music beds).
- add_sequence: asset (video/audio), track, ranges [{from, to}] (source in/out points, up to ${EDIT_LIMITS.sequenceRanges}); optional start (default 0), volume, muted, fit, frame, edgeFade (0–${EDIT_LIMITS.maxEdgeFade} s audio ramp at both edges of every clip, e.g. 0.02 against clicks). Places one clip per range back to back with no gaps and returns all their ids; use it for cutting one long recording, not for placing single clips. Refused if a range runs past the end of the source.
- add_text: text, start, duration, track; optional placement ("top"|"center"|"bottom"), size ("small"|"medium"|"large"), color.
- add_component: name (a block/component from browse_presets), start, track; optional duration.
- apply_captions: preset (a caption preset from browse_presets), cues [{text, start, end}] spanning the composition; optional track.
- remove_clip: clip, or clips (many ids at once, up to ${EDIT_LIMITS.removeClips}); optional ripple (close the gap by moving later clips on the track).
- move_clip: clip; start and/or track.
- trim_clip: clip; new timeline start and/or end (trimming the head of a video/audio clip advances its media in-point).
- split_clip: clip, at (timeline time inside the clip). The result reports the new second half's clip id.
- set_clip: clip; any of volume, muted, fit, zIndex, frame, fadeIn, fadeOut.
- arrange_track: track, clips (ids in order), optional start (default 0) and gap; lays them end to end.
- set_composition: duration (explicit length; otherwise the length follows the content).`;

const DESCRIPTIONS: Record<EditingToolName, string> = {
  inspect_project: `List the project's compositions (size, length, clip count), media assets (kind, size, duration, whether video has audio) and existing renders. Call it first to learn what material exists before planning an edit.`,
  inspect_timeline: `Show a composition's timeline as a table: clip id, kind, label, start–end, track, source, notes (media in-point, volume, muted, locked), plus the composition's size, length and content version. Also reports the user's playhead, selected clips/asset/time range and active composition as they were when the user sent the message (they may have changed since). Read it before editing and again after a batch to verify the result. Defaults to the main composition. ${CONVENTIONS}`,
  edit_timeline: `Change the timeline of a composition with a batch of operations. The batch is atomic: if any operation is refused, nothing is applied and the error names the failing operation (operations[N]) so you can fix it and retry. Operations run in order; clips they create get ids that are returned in the result (use them in a later call). After edits the Studio timeline and preview update by themselves, and every edit belongs to this turn's checkpoint, so the user can revert it. Pass baseVersion (the version from inspect_timeline) to refuse the batch if the composition changed since you looked. ${CONVENTIONS}\n${EDIT_OPERATIONS_GUIDE}`,
  browse_presets: `Search the built-in presets: caption styles ("caption", used by apply_captions), motion-graphics "block"s and reusable "component"s (both used by add_component). Returns names with a short description and natural length. Optional query filters by text.`,
  render_video: `Render a composition to an mp4 file in the project's renders folder and wait until it finishes. Returns the project-relative path, length, resolution and size; report the path to the user. Use "draft" quality for a quick check, "standard" (default) or "high" for the final video. Fails if the render fails or is cancelled. A render takes minutes per minute of video: render only when the user asked for a video file, an export or a render (or for a short draft check), not after every edit of a long timeline — offer it instead.`,
};

// ── Schemas ──────────────────────────────────────────────────────────────────

const str = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength !== undefined && { maxLength }),
});
const time = (description: string) => ({
  type: "number",
  minimum: 0,
  maximum: EDIT_LIMITS.maxTime,
  description,
});
const track = (description: string) => ({
  type: "integer",
  minimum: 0,
  maximum: EDIT_LIMITS.maxTrack,
  description,
});
const clipId = str("Clip id from inspect_timeline or an earlier edit result.", EDIT_LIMITS.idChars);
const volume = {
  type: "number",
  minimum: 0,
  maximum: EDIT_LIMITS.maxVolume,
  description: "Volume: 1 = the source level; music under speech about 0.2–0.4.",
};
const fade = (edge: string) => ({
  type: "number",
  minimum: 0,
  maximum: EDIT_LIMITS.maxTime,
  description: `Seconds of linear audio/video gain ramp at the clip's ${edge}; 1–2 s suits a music bed.`,
});
const fit = {
  type: "string",
  enum: [...CLIP_FITS],
  description: "contain shows all of the frame; cover fills it.",
};
const frame = {
  type: "object",
  description:
    "Position and size in composition pixels (left/top corner, width, height), e.g. a logo in a corner.",
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number", exclusiveMinimum: 0 },
    height: { type: "number", exclusiveMinimum: 0 },
  },
  required: ["x", "y", "width", "height"],
  additionalProperties: false,
};

interface OperationSchema {
  type: "object";
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

function operationSchema(
  op: EditOperationName,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): OperationSchema {
  return {
    type: "object",
    description,
    properties: { op: { type: "string", enum: [op] }, ...properties },
    required: ["op", ...required],
    additionalProperties: false,
  };
}

const OPERATION_SCHEMAS: Record<EditOperationName, OperationSchema> = {
  add_clip: operationSchema(
    "add_clip",
    "Place a project asset (video, image or audio) on the timeline.",
    {
      asset: str("Project-relative asset path from inspect_project.", EDIT_LIMITS.pathChars),
      start: time("Timeline start in seconds."),
      track: track("Track: 0 = A-roll, higher = B-roll/overlay; audio on its own track."),
      duration: { type: "number", exclusiveMinimum: 0, description: "Seconds on the timeline." },
      mediaStart: time("In-point in the source media, seconds."),
      volume,
      muted: { type: "boolean" },
      fit,
      frame,
      fadeIn: fade("start"),
      fadeOut: fade("end"),
    },
    ["asset", "start", "track"],
  ),
  add_sequence: operationSchema(
    "add_sequence",
    "Place many ranges of ONE video/audio source back to back on a track (a rough cut): one clip per range, no gaps.",
    {
      asset: str("Project-relative video or audio asset path.", EDIT_LIMITS.pathChars),
      track: track("Track: 0 = A-roll."),
      start: time("Timeline position of the first range; default 0."),
      ranges: {
        type: "array",
        minItems: 1,
        maxItems: EDIT_LIMITS.sequenceRanges,
        description: "Source in/out points in seconds, played in this order.",
        items: {
          type: "object",
          properties: {
            from: time("In-point in the source, seconds."),
            to: {
              type: "number",
              exclusiveMinimum: 0,
              maximum: EDIT_LIMITS.maxTime,
              description: "Out-point in the source, seconds; after from.",
            },
          },
          required: ["from", "to"],
          additionalProperties: false,
        },
      },
      volume,
      muted: { type: "boolean" },
      fit,
      frame,
      edgeFade: {
        type: "number",
        minimum: 0,
        maximum: EDIT_LIMITS.maxEdgeFade,
        description:
          "Short audio gain ramp (seconds) at both edges of every clip, against clicks at cuts; 0.02 is typical.",
      },
    },
    ["asset", "track", "ranges"],
  ),
  add_text: operationSchema(
    "add_text",
    "Add a text/title clip.",
    {
      text: str("The text to show.", EDIT_LIMITS.textChars),
      start: time("Timeline start in seconds."),
      duration: { type: "number", exclusiveMinimum: 0, description: "Seconds on the timeline." },
      track: track("Use a track above the video it overlays."),
      placement: { type: "string", enum: [...TEXT_PLACEMENTS] },
      size: { type: "string", enum: [...TEXT_SIZES] },
      color: str("Hex (#ffffff) or CSS color name.", 40),
    },
    ["text", "start", "duration", "track"],
  ),
  add_component: operationSchema(
    "add_component",
    "Install a block/component from browse_presets and mount it as a clip.",
    {
      name: str("Preset name from browse_presets.", EDIT_LIMITS.idChars),
      start: time("Timeline start in seconds."),
      track: track("Track for the graphic; above the video it overlays."),
      duration: {
        type: "number",
        exclusiveMinimum: 0,
        description: "Seconds; defaults to its natural length.",
      },
    },
    ["name", "start", "track"],
  ),
  apply_captions: operationSchema(
    "apply_captions",
    "Write captions from cues in a caption preset's style, spanning the whole composition.",
    {
      preset: str("Caption preset name from browse_presets.", EDIT_LIMITS.idChars),
      cues: {
        type: "array",
        minItems: 1,
        maxItems: EDIT_LIMITS.captionCues,
        items: {
          type: "object",
          properties: {
            text: str("The words shown.", EDIT_LIMITS.textChars),
            start: time("Cue start, seconds."),
            end: time("Cue end, seconds; after its start."),
          },
          required: ["text", "start", "end"],
          additionalProperties: false,
        },
      },
      track: track("Optional track for the captions."),
    },
    ["preset", "cues"],
  ),
  remove_clip: operationSchema(
    "remove_clip",
    "Remove one clip (clip) or many at once (clips); give exactly one of the two.",
    {
      clip: clipId,
      clips: {
        type: "array",
        minItems: 1,
        maxItems: EDIT_LIMITS.removeClips,
        items: clipId,
        description: "Clip ids to remove, all at once (for example a previous rough cut).",
      },
      ripple: {
        type: "boolean",
        description: "Close the gaps by moving later clips on the track.",
      },
    },
    [],
  ),
  move_clip: operationSchema(
    "move_clip",
    "Move a clip in time and/or to another track (give at least one of start, track).",
    { clip: clipId, start: time("New timeline start, seconds."), track: track("New track.") },
    ["clip"],
  ),
  trim_clip: operationSchema(
    "trim_clip",
    "Set new timeline in/out points (give at least one of start, end).",
    {
      clip: clipId,
      start: time("New timeline start, seconds."),
      end: { type: "number", exclusiveMinimum: 0, description: "New timeline end, seconds." },
    },
    ["clip"],
  ),
  split_clip: operationSchema(
    "split_clip",
    "Split a clip in two at a timeline time inside it.",
    {
      clip: clipId,
      at: { type: "number", exclusiveMinimum: 0, description: "Timeline time, seconds." },
    },
    ["clip", "at"],
  ),
  set_clip: operationSchema(
    "set_clip",
    "Change clip properties (give at least one).",
    {
      clip: clipId,
      volume,
      muted: { type: "boolean" },
      fit,
      zIndex: { type: "integer", description: "Stacking order; higher draws on top." },
      frame,
      fadeIn: fade("start"),
      fadeOut: fade("end"),
    },
    ["clip"],
  ),
  arrange_track: operationSchema(
    "arrange_track",
    "Lay clips end to end on a track in the given order.",
    {
      track: track("The track."),
      clips: {
        type: "array",
        minItems: 1,
        maxItems: EDIT_LIMITS.arrangeClips,
        items: clipId,
        description: "Clip ids in playing order.",
      },
      start: time("Where the first clip starts; default 0."),
      gap: time("Seconds between clips; default 0."),
    },
    ["track", "clips"],
  ),
  set_composition: operationSchema(
    "set_composition",
    "Set the composition length explicitly.",
    { duration: { type: "number", exclusiveMinimum: 0, description: "Seconds." } },
    ["duration"],
  ),
};

const compositionProperty = str(
  "Project-relative composition path; defaults to the main composition.",
  EDIT_LIMITS.pathChars,
);

const PARAMETERS: Record<EditingToolName, Record<string, unknown>> = {
  inspect_project: { type: "object", properties: {}, additionalProperties: false },
  inspect_timeline: {
    type: "object",
    properties: { composition: compositionProperty },
    additionalProperties: false,
  },
  edit_timeline: {
    type: "object",
    properties: {
      composition: compositionProperty,
      baseVersion: str(
        "The `version` from inspect_timeline; the batch is refused with a conflict if the composition changed since.",
        200,
      ),
      operations: {
        type: "array",
        minItems: 1,
        maxItems: EDIT_LIMITS.operations,
        description: "Operations applied in order, atomically.",
        items: { anyOf: EDIT_OPERATION_NAMES.map((name) => OPERATION_SCHEMAS[name]) },
      },
    },
    required: ["operations"],
    additionalProperties: false,
  },
  browse_presets: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...PRESET_KINDS],
        description: "caption, block or component.",
      },
      query: str("Optional text to filter by name, title or tags.", 200),
    },
    required: ["kind"],
    additionalProperties: false,
  },
  render_video: {
    type: "object",
    properties: {
      composition: compositionProperty,
      quality: { type: "string", enum: [...RENDER_QUALITIES], description: "Default: standard." },
    },
    additionalProperties: false,
  },
};

// ── Activity rows ────────────────────────────────────────────────────────────

const OP_SUMMARY: Record<EditOperationName, string> = {
  add_clip: "add clip",
  add_sequence: "add sequence",
  add_text: "add text",
  add_component: "add component",
  apply_captions: "captions",
  remove_clip: "remove",
  move_clip: "move",
  trim_clip: "trim",
  split_clip: "split",
  set_clip: "adjust",
  arrange_track: "arrange",
  set_composition: "set length",
};

const isOperationName = (value: unknown): value is EditOperationName =>
  EDIT_OPERATION_NAMES.some((name) => name === value);

/** "Editing the timeline · 4 changes (add clip ×3, split)"; never throws on malformed arguments. */
function editLabel(args: unknown): string {
  const operations = isRecord(args) && Array.isArray(args.operations) ? args.operations : [];
  if (operations.length === 0) return "Editing the timeline";
  const counts = new Map<string, number>();
  for (const operation of operations) {
    const name = isRecord(operation) && isOperationName(operation.op) ? operation.op : null;
    const label = name ? OP_SUMMARY[name] : "edit";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const groups = [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  const shown = groups.length > 3 ? [...groups.slice(0, 3), "…"] : groups;
  const noun = operations.length === 1 ? "change" : "changes";
  return `Editing the timeline · ${operations.length} ${noun} (${shown.join(", ")})`;
}

const ACTIVITIES: Record<
  EditingToolName,
  (args: unknown) => { category: BackendToolKind; label: string }
> = {
  inspect_project: () => ({ category: "inspect", label: "Inspecting the project" }),
  inspect_timeline: () => ({ category: "inspect", label: "Inspecting the timeline" }),
  edit_timeline: (args) => ({ category: "edit", label: editLabel(args) }),
  browse_presets: (args) => {
    const kind = isRecord(args)
      ? PRESET_KINDS.find((candidate) => candidate === args.kind)
      : undefined;
    return { category: "search", label: kind ? `Browsing ${kind} presets` : "Browsing presets" };
  },
  render_video: () => ({ category: "other", label: "Rendering video" }),
};

/** The editing tools of one agent; every call goes to `execute` (the running turn's editing executor). */
export function buildEditingTools(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  execute: Executor,
): HostTool[] {
  return editingToolsFor(agent, enabled).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: PARAMETERS[name],
    execute: (args, signal) => execute(name, args, signal),
    activity: (args) => ACTIVITIES[name](args),
  }));
}
