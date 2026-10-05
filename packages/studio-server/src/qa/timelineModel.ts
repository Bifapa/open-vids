import type {
  CaptionCue,
  StoryGraph,
  TimelineClip,
  TimelineSnapshot,
  TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { isCaptionsFile } from "../editing/captions.js";

/** Everything the timeline-derived checks, the layout mapping and the sample planner read, gathered once per check. */
export interface QaTimeline {
  snapshot: TimelineSnapshot;
  /** Playback rate of each media clip (1 when the clip has none). */
  rates: ReadonlyMap<string, number>;
  /** Project-relative media paths the timeline uses that are not on disk. */
  missing: ReadonlySet<string>;
  /** Whether each used media file carries an audio stream (null: not known). */
  hasAudio: ReadonlyMap<string, boolean | null>;
  /** Fresh cached transcripts of the media files clips play. */
  transcripts: ReadonlyMap<string, TranscriptArtifact>;
  /**
   * Measured silences (source seconds, from the level-based silence map) of those files. Word timestamps stretch over
   * pauses, so a cut that lands in measured silence is not inside a word whatever the word timings say. Optional:
   * absent means no silence map is known.
   */
  silences?: ReadonlyMap<string, readonly { start: number; end: number }[]>;
  /** Caption text and timing on the composition's timeline. */
  cues: readonly CaptionCue[];
  graph: StoryGraph | null;
}

export const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export function rateOf(timeline: QaTimeline, clip: TimelineClip): number {
  return timeline.rates.get(clip.id) ?? 1;
}

/** Picture-carrying clips: everything but audio. */
export function isVisual(clip: TimelineClip): boolean {
  return clip.kind !== "audio";
}

/** Clips that fill the frame with footage or a picture (overlays such as text, captions and graphics do not). */
export function isContent(clip: TimelineClip): boolean {
  return clip.kind === "video" || clip.kind === "image";
}

export function isCaptionsHost(clip: TimelineClip): boolean {
  return isCaptionsFile(clip.compositionSrc ?? null);
}

/** The clip's id, as issues and humans name it. */
export function clipName(clip: TimelineClip): string {
  return clip.id || clip.domId || clip.label;
}

/** Whether the clip can be heard: playing, not muted, with a volume and a source. */
export function isAudible(timeline: QaTimeline, clip: TimelineClip): boolean {
  if (clip.kind !== "video" && clip.kind !== "audio") return false;
  if (clip.muted || (clip.volume !== null && clip.volume <= 0) || clip.src === null) return false;
  return timeline.hasAudio.get(clip.src) !== false;
}

export function activeAt(clips: readonly TimelineClip[], time: number): TimelineClip[] {
  return clips.filter((clip) => clip.start <= time && time < clip.end);
}

/** The picture at `time` is this clip's: the topmost content clip (highest z-index, else track). */
export function topContentAt(clips: readonly TimelineClip[], time: number): TimelineClip | null {
  let top: TimelineClip | null = null;
  for (const clip of activeAt(clips, time)) {
    if (!isContent(clip)) continue;
    if (!top || (clip.zIndex ?? clip.track) >= (top.zIndex ?? top.track)) top = clip;
  }
  return top;
}

/** Clip ids of the clips overlapping `[start, end]` (with a small margin), at most the protocol's limit. */
export function clipIdsOverlapping(
  clips: readonly TimelineClip[],
  start: number,
  end: number,
  margin = 0,
): string[] {
  return clips
    .filter((clip) => clip.start < end + margin && clip.end > start - margin)
    .map(clipName)
    .slice(0, 32);
}

/** The words of a transcript between two source times. */
export function wordsBetween(
  transcript: TranscriptArtifact,
  from: number,
  to: number,
): TranscriptArtifact["words"] {
  return transcript.words.filter((word) => word.end > from && word.start < to);
}

/** Source second of the file `clip` plays at timeline second `time`. */
export function sourceTime(timeline: QaTimeline, clip: TimelineClip, time: number): number {
  return (clip.mediaStart ?? 0) + (time - clip.start) * rateOf(timeline, clip);
}
