import { VOICEOVER_AUDIO_GROUP } from "@hyperframes/agent-protocol";
import { classifyAudioName } from "@hyperframes/core/audio-carve";
import { spansOverlap } from "@hyperframes/core/clip-facts";
import type { TimelineElement } from "../../player";
import { isAudioTimelineElement, isMusicTrack } from "../../utils/timelineInspector";

/** The track a clip is written on: the authored `data-track-index`, not the display lane. */
const authoredTrackOf = (element: TimelineElement) => element.authoredTrack ?? element.track;

/** Whether a clip belongs to the project's voiceover (a placed line, or any member of the voiceover group). */
export function isVoiceoverClip(element: TimelineElement): boolean {
  return element.voiceLine !== undefined || element.audioGroup === VOICEOVER_AUDIO_GROUP;
}

/**
 * The track a voiceover line lands on at `start`: a track that already carries voiceover and is free for the line's
 * length, else any other audio-only track that is free, else a new track below everything. Never a track holding
 * a picture: a voice does not belong among the visuals.
 */
export function resolveVoiceLineTrack(
  elements: readonly TimelineElement[],
  span: { start: number; duration: number },
): number {
  const byTrack = new Map<number, TimelineElement[]>();
  for (const element of elements) {
    const track = authoredTrackOf(element);
    byTrack.set(track, [...(byTrack.get(track) ?? []), element]);
  }
  const end = span.start + span.duration;
  const free = (clips: readonly TimelineElement[]) =>
    clips.every((clip) => !spansOverlap(span.start, end, clip.start, clip.start + clip.duration));
  const audioOnly = [...byTrack.entries()]
    .filter(([, clips]) => clips.every(isAudioTimelineElement))
    .sort(([a], [b]) => a - b);
  const withVoice = audioOnly.filter(([, clips]) => clips.some(isVoiceoverClip));
  const others = audioOnly.filter(([, clips]) => !clips.some(isVoiceoverClip));
  const chosen = [...withVoice, ...others].find(([, clips]) => free(clips));
  if (chosen) return chosen[0];
  const tracks = [...byTrack.keys()];
  return tracks.length === 0 ? 0 : Math.max(...tracks) + 1;
}

export type CarveAvailability =
  | { kind: "ready"; beds: TimelineElement[] }
  /** Nothing on the timeline speaks the script yet: there is no voice to make room for. */
  | { kind: "no-voice" }
  | { kind: "no-music" };

/** An audio clip this long that is neither named a voice nor an effect is taken for a music bed. */
const UNNAMED_BED_MIN_SECONDS = 8;

/**
 * Whether a clip is a music bed: tagged music, or named like one, and not part of the voiceover. A Story build names
 * clips after their file ("parallel-universe-cc0"), so a long audio clip with a name that says nothing counts too.
 */
export function isMusicBed(element: TimelineElement): boolean {
  if (!isAudioTimelineElement(element) || isVoiceoverClip(element)) return false;
  if (element.timelineRole !== undefined && element.timelineRole !== "music") return false;
  if (isMusicTrack(element)) return true;
  // Only the file's own name: the preview URL carries the project's name, which may say "voice" itself.
  const file = element.src?.split(/[?#]/)[0]?.split("/").pop();
  const kind = classifyAudioName(element.domId ?? element.id, file);
  return kind === "music" || (kind === "unknown" && element.duration >= UNNAMED_BED_MIN_SECONDS);
}

/** What the "carve music under the voiceover" action can run on right now. */
export function resolveCarveAvailability(elements: readonly TimelineElement[]): CarveAvailability {
  if (!elements.some(isVoiceoverClip)) return { kind: "no-voice" };
  const beds = elements.filter(isMusicBed);
  return beds.length === 0 ? { kind: "no-music" } : { kind: "ready", beds };
}
