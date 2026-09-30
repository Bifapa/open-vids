import {
  ANALYSIS_LIMITS,
  SEGMENT_PRIORITIES,
  SEGMENT_ROLES,
  VISION_QUALITIES,
  isRecord,
  type AgentId,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import type { BackendToolKind, HostTool, HostToolResult } from "../backend.js";
import { ANALYSIS_SECTIONS, basename } from "./format.js";

export const ANALYSIS_TOOL_NAMES = {
  analyze: "analyze_media",
  read: "read_analysis",
  transcript: "read_transcript",
  segments: "save_segments",
  frames: "inspect_frames",
  vision: "save_vision_notes",
  plan: "plan_cut",
  build: "build_rough_cut",
} as const;

export type AnalysisToolName = (typeof ANALYSIS_TOOL_NAMES)[keyof typeof ANALYSIS_TOOL_NAMES];

export function isAnalysisToolName(name: string): name is AnalysisToolName {
  return Object.values<string>(ANALYSIS_TOOL_NAMES).includes(name);
}

type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolResult>;

/**
 * Which analysis tools an agent gets. Everyone who edits or plans can read the analysis; the Director looks at frames
 * and plans/builds cuts itself only when there is no Vision/Editor to delegate to. Jev gets none.
 */
export function analysisToolsFor(
  agent: AgentId,
  enabled: readonly SpecialistId[],
): AnalysisToolName[] {
  const { analyze, read, transcript, segments, frames, vision, plan, build } = ANALYSIS_TOOL_NAMES;
  switch (agent) {
    case "director":
      return [
        analyze,
        read,
        transcript,
        segments,
        ...(enabled.includes("vision") ? [] : [frames, vision]),
        ...(enabled.includes("editor") ? [] : [plan, build]),
      ];
    case "editor":
      return [analyze, read, transcript, segments, plan, build];
    case "vision":
      return [analyze, read, transcript, frames, vision];
    case "motion":
    case "audio":
    case "research":
      return [read, transcript];
    default:
      return [];
  }
}

// ── Descriptions ─────────────────────────────────────────────────────────────

const SOURCE_TIMES = `Times are seconds of the SOURCE file (not the timeline); the results print them as mm:ss.s and, where you must pass a time back, also as plain seconds.`;

const DESCRIPTIONS: Record<AnalysisToolName, string> = {
  analyze_media: `Analyze a long video or audio file once and keep the result: speech transcript with word timestamps, speakers, pauses, shots with black/frozen-picture detection, take issues (retakes, false starts, restart cues, stutters, fillers), a draft segmentation, and the frames worth looking at. The analysis is cached per file (it survives across turns; only a changed file is recomputed), so calling it again is instant and never repeats work unless you pass force. It waits until the analysis has finished (a 30-minute talk takes a few minutes) and returns a compact overview: what each stage did, speakers, pause statistics, shots, take issues, segments, vision targets and existing cut plans. A stage this machine cannot run (for example no speech recognizer) is reported as unavailable with the reason. Pass the project-relative path of the media (from inspect_project). ${SOURCE_TIMES}`,
  read_analysis: `Read the cached analysis of a source (run analyze_media first). Without a section you get the overview; with a section you get that part in full: speakers (with turns), silence (every pause), shots (every shot and the black/frozen problems), takes (every take issue with its evidence), segments (with summaries), vision (notes and the targets still to inspect) or cuts (the existing cut plans). ${SOURCE_TIMES}`,
  read_transcript: `Read the transcript of a source as lines "s12 [01:02.3–01:05.8] S1: text". Sentence ids (s12) are what save_segments and plan_cut refer to. Sentences that a take issue touches end with ⟨t3 retake⟩. The result starts with the transcript version, which save_segments requires. A long transcript is returned in pages: pass from (and optionally to), in seconds of the source, to read the next page; the result tells you where to continue.`,
  save_segments: `Save the semantic segmentation of a source: the topic structure of the video, written by you after reading the whole transcript (read_transcript, every page). Segments are in time order, contiguous, and together cover every sentence exactly once (firstSentence/lastSentence are sentence ids such as s1 and s40). Give each a short title, a one-sentence summary, a role and a priority that preserve the MEANING of the video: "must" = the story depends on it, "should" = valuable, "optional" = can go when the cut must be shorter, "drop" = leave out (tangents, off-topic chatter, filler, repeated explanations). Pass the transcriptVersion you read; it is refused if the transcript changed since. Replaces the previous segmentation of the source.`,
  inspect_frames: `Look at video frames: returns JPEG images of the source at the given times, so you can judge what is on screen (speaker on camera, slide, black or frozen picture, slate, bad framing). Use the times of the vision targets from analyze_media/read_analysis — at most ${ANALYSIS_LIMITS.framesPerRequest} per call, roughly 40 frames per source in total, never the whole video. Frames that were extracted before are served from the cache. Record what you saw with save_vision_notes. ${SOURCE_TIMES}`,
  save_vision_notes: `Save what you saw in the frames: notes on ranges of the source, each with the frame times it is based on, a quality (good, usable, poor, unusable), short lowercase tags (speaker_on_camera, slide, black, frozen, slate, b_roll_candidate, ...) and a one-sentence finding. A note replaces a stored note with the same start and end. The planner and the Editor use these notes to decide what to keep. ${SOURCE_TIMES}`,
  plan_cut: `Plan a cut of a source: the deterministic edit decision list that turns the analysis into a shorter video, without touching the timeline. It keeps the segments in order (or in the order you give), drops segments with priority "drop" and those you list, removes the take issues marked "cut" (bad takes, false starts, restart cues) and filler words, shortens pauses longer than maxPause to pauseKeep, and can put a hook (a teaser of the best sentences) in front. Returns a plan id with statistics (length, removed pauses/fillers/takes, dropped and moved segments), warnings and the order of the kept segments. Refine a plan by passing basedOn: options you leave out are taken from that plan (a pacing pass: tighter maxPause and pauseKeep, drop optional segments). Then build it with build_rough_cut. "must" segments can only be dropped when also listed in allowDropMust. ${SOURCE_TIMES}`,
  build_rough_cut: `Build a cut plan on the real timeline as ONE atomic edit: it removes the clips of the target track that play the plan's source (the previous cut), places the plan's ranges back to back on that track with short audio fades against clicks (the clips remember the plan they came from), and sets the composition length to the cut. Clips on other tracks (cutaways, B-roll, graphics, music, manual additions) are kept and reported — their positions refer to the previous cut, so check them afterwards. Pass captions (a caption preset from browse_presets) to also write word-synced captions from the transcript for exactly the kept material. The Studio timeline and preview update by themselves and the change belongs to this turn's checkpoint, so the user can revert it. Returns the number of clips, the length, and the timeline positions where kept material overlaps a black or frozen stretch (cover them with edit_timeline, e.g. B-roll on a higher track, or trim them). Afterwards verify with inspect_timeline. Building a refined plan replaces the previous cut.`,
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
  maximum: ANALYSIS_LIMITS.maxTime,
  description,
});
const source = str(
  "Project-relative path of the video or audio file (from inspect_project), e.g. assets/raw-talk.mp4.",
  ANALYSIS_LIMITS.pathChars,
);
const sentenceId = (description: string) => str(description, ANALYSIS_LIMITS.idChars);
const idList = (description: string, maxItems: number) => ({
  type: "array",
  maxItems,
  description,
  items: str("An id.", ANALYSIS_LIMITS.idChars),
});

const PARAMETERS: Record<AnalysisToolName, Record<string, unknown>> = {
  analyze_media: {
    type: "object",
    properties: {
      source,
      language: str(
        "Spoken language hint such as en or ru; detected when omitted. Give it when you know it.",
        ANALYSIS_LIMITS.languageChars,
      ),
      force: {
        type: "boolean",
        description:
          "Recompute every stage even if cached. Only when the user asks to redo the analysis.",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
  read_analysis: {
    type: "object",
    properties: {
      source,
      section: {
        type: "string",
        enum: [...ANALYSIS_SECTIONS],
        description: "Which part in full; default overview.",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
  read_transcript: {
    type: "object",
    properties: {
      source,
      from: time("Start of the window, seconds of the source (default 0)."),
      to: time("End of the window, seconds of the source (default: the end)."),
    },
    required: ["source"],
    additionalProperties: false,
  },
  save_segments: {
    type: "object",
    properties: {
      source,
      transcriptVersion: str("The transcript version printed by read_transcript.", 200),
      segments: {
        type: "array",
        minItems: 1,
        maxItems: ANALYSIS_LIMITS.segments,
        description: "In time order, contiguous, covering every sentence exactly once.",
        items: {
          type: "object",
          properties: {
            firstSentence: sentenceId("First sentence id of the segment, e.g. s1."),
            lastSentence: sentenceId("Last sentence id of the segment, e.g. s12."),
            title: str("Short title.", ANALYSIS_LIMITS.titleChars),
            summary: str("One sentence about what is said.", ANALYSIS_LIMITS.summaryChars),
            role: { type: "string", enum: [...SEGMENT_ROLES] },
            priority: {
              type: "string",
              enum: [...SEGMENT_PRIORITIES],
              description:
                "must = the meaning depends on it; should; optional = first to go when shortening; drop = leave out.",
            },
          },
          required: ["firstSentence", "lastSentence", "title", "summary", "role", "priority"],
          additionalProperties: false,
        },
      },
    },
    required: ["source", "transcriptVersion", "segments"],
    additionalProperties: false,
  },
  inspect_frames: {
    type: "object",
    properties: {
      source,
      times: {
        type: "array",
        minItems: 1,
        maxItems: ANALYSIS_LIMITS.framesPerRequest,
        description: `Source times in seconds, at most ${ANALYSIS_LIMITS.framesPerRequest}.`,
        items: time("Seconds of the source."),
      },
      width: {
        type: "integer",
        minimum: ANALYSIS_LIMITS.minFrameWidth,
        maximum: ANALYSIS_LIMITS.maxFrameWidth,
        description: "Frame width in pixels (default 512; raise it only to read small text).",
      },
    },
    required: ["source", "times"],
    additionalProperties: false,
  },
  save_vision_notes: {
    type: "object",
    properties: {
      source,
      notes: {
        type: "array",
        minItems: 1,
        maxItems: ANALYSIS_LIMITS.visionNotes,
        items: {
          type: "object",
          properties: {
            start: time("Start of the described range, seconds of the source."),
            end: time("End of the described range (after start)."),
            frames: {
              type: "array",
              maxItems: ANALYSIS_LIMITS.framesPerNote,
              description: "Source times of the frames this note is based on.",
              items: time("Seconds of the source."),
            },
            quality: { type: "string", enum: [...VISION_QUALITIES] },
            tags: {
              type: "array",
              maxItems: ANALYSIS_LIMITS.tags,
              description:
                "Short lowercase tags: speaker_on_camera, slide, black, frozen, slate, b_roll_candidate, ...",
              items: str("A tag.", ANALYSIS_LIMITS.tagChars),
            },
            finding: str(
              "One sentence: what is on screen and what it means for the cut.",
              ANALYSIS_LIMITS.findingChars,
            ),
          },
          required: ["start", "end", "frames", "quality", "tags", "finding"],
          additionalProperties: false,
        },
      },
    },
    required: ["source", "notes"],
    additionalProperties: false,
  },
  plan_cut: {
    type: "object",
    properties: {
      source,
      label: str('Short label, e.g. "rough cut" or "pacing pass".', ANALYSIS_LIMITS.titleChars),
      basedOn: str(
        "A plan id (cut-1) this plan refines: every option you leave out is taken from it.",
        ANALYSIS_LIMITS.idChars,
      ),
      order: idList(
        "Segment ids in playing order; omit for source order. Segments not listed are dropped.",
        ANALYSIS_LIMITS.orderEntries,
      ),
      drop: idList(
        "Segment ids to leave out in addition to those with priority drop.",
        ANALYSIS_LIMITS.orderEntries,
      ),
      allowDropMust: idList(
        'Segments with priority "must" that may be dropped after all (must also be in drop).',
        ANALYSIS_LIMITS.orderEntries,
      ),
      hook: {
        type: ["object", "null"],
        description:
          "Cold open: these sentences play first as a teaser and again at their place. null removes the hook of the base plan.",
        properties: {
          firstSentence: sentenceId("First sentence id of the teaser."),
          lastSentence: sentenceId("Last sentence id of the teaser."),
        },
        required: ["firstSentence", "lastSentence"],
        additionalProperties: false,
      },
      removeIssues: {
        anyOf: [
          { type: "string", enum: ["auto"] },
          idList("Take issue ids (t3) to cut.", ANALYSIS_LIMITS.issueIds),
        ],
        description:
          'Take issues to cut: "auto" (default) = every issue whose action is cut, or a list of issue ids.',
      },
      keepIssues: idList(
        "Take issue ids to keep even though removeIssues would cut them.",
        ANALYSIS_LIMITS.issueIds,
      ),
      removeFillers: { type: "boolean", description: "Remove filler words (default true)." },
      maxPause: {
        type: "number",
        minimum: 0.1,
        maximum: ANALYSIS_LIMITS.maxPause,
        description: "Pauses longer than this many seconds are shortened (default 0.7).",
      },
      pauseKeep: {
        type: "number",
        minimum: 0,
        maximum: ANALYSIS_LIMITS.maxPause,
        description: "What remains of a shortened pause, seconds (default 0.3; at most maxPause).",
      },
      targetDuration: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: ANALYSIS_LIMITS.maxTime,
        description: "Target length in seconds; the plan warns when it misses it by over 10 %.",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
  build_rough_cut: {
    type: "object",
    properties: {
      plan: str("The plan id from plan_cut, e.g. cut-2.", ANALYSIS_LIMITS.idChars),
      composition: str(
        "Project-relative composition path; defaults to the main composition.",
        ANALYSIS_LIMITS.pathChars,
      ),
      track: {
        type: "integer",
        minimum: 0,
        description: "Track for the cut (default 0, the A-roll).",
      },
      captions: str(
        "Optional caption preset name from browse_presets (kind caption): word-synced captions from the transcript are written with the cut in the same edit.",
        ANALYSIS_LIMITS.idChars,
      ),
    },
    required: ["plan"],
    additionalProperties: false,
  },
};

// ── Activity rows ────────────────────────────────────────────────────────────

const count = (value: unknown, noun: string): string => {
  const n = Array.isArray(value) ? value.length : 0;
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
};

/** "raw-talk.mp4", trimmed for a chat row; never throws on malformed arguments. */
function sourceName(args: unknown): string | null {
  if (!isRecord(args) || typeof args.source !== "string" || args.source.length === 0) return null;
  const name = basename(args.source);
  return name.length > 48 ? `${name.slice(0, 47)}…` : name;
}

/** The chat's row label of one call. `planClips` resolves the size of a plan for "Building the rough cut · 143 clips". */
type ActivityLabel = (
  args: unknown,
  planClips: (plan: string) => number | undefined,
) => { category: BackendToolKind; label: string };

const ACTIVITIES: Record<AnalysisToolName, ActivityLabel> = {
  analyze_media: (args) => {
    const name = sourceName(args);
    return { category: "other", label: name ? `Analyzing ${name}` : "Analyzing the media" };
  },
  read_analysis: (args) => {
    const section =
      isRecord(args) && typeof args.section === "string" && args.section !== "overview"
        ? ` · ${args.section}`
        : "";
    return { category: "inspect", label: `Reading the analysis${section}` };
  },
  read_transcript: () => ({ category: "inspect", label: "Reading the transcript" }),
  save_segments: (args) => ({
    category: "other",
    label: `Saving ${count(isRecord(args) ? args.segments : undefined, "segment")}`,
  }),
  inspect_frames: (args) => ({
    category: "inspect",
    label: `Looking at ${count(isRecord(args) ? args.times : undefined, "frame")}`,
  }),
  save_vision_notes: (args) => ({
    category: "other",
    label: `Saving ${count(isRecord(args) ? args.notes : undefined, "visual note")}`,
  }),
  plan_cut: (args) => {
    const label =
      isRecord(args) && typeof args.label === "string" && args.label.trim().length > 0
        ? ` · ${args.label.trim().slice(0, 40)}`
        : "";
    return { category: "other", label: `Planning the cut${label}` };
  },
  build_rough_cut: (args, planClips) => {
    const clips =
      isRecord(args) && typeof args.plan === "string" ? planClips(args.plan) : undefined;
    return {
      category: "edit",
      label:
        clips === undefined ? "Building the rough cut" : `Building the rough cut · ${clips} clips`,
    };
  },
};

/** What the tool builder needs to know about the runtime beyond the agent's role. */
export interface AnalysisToolContext {
  /** The runtime has an editing host: without one there is no timeline to build a rough cut on. */
  editing: boolean;
  /** Ranges (= clips) of a plan this turn has seen, for the activity label of build_rough_cut. */
  planClips?: (plan: string) => number | undefined;
}

/** The analysis tools of one agent; every call goes to `execute` (the running turn's analysis executor). */
export function buildAnalysisTools(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  context: AnalysisToolContext,
  execute: Executor,
): HostTool[] {
  return analysisToolsFor(agent, enabled)
    .filter((name) => name !== ANALYSIS_TOOL_NAMES.build || context.editing)
    .map((name) => ({
      name,
      description: DESCRIPTIONS[name],
      parameters: PARAMETERS[name],
      execute: (args, signal) => execute(name, args, signal),
      activity: (args) => ACTIVITIES[name](args, context.planClips ?? (() => undefined)),
    }));
}
