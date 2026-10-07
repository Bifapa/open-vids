import type { VoiceTake } from "@hyperframes/agent-protocol";
import type { TimelineElement } from "../../player";
import { resolveDurationRipple } from "../../player/components/timelineDurationRipple";
import { takeClipAttributes, voiceClipsOfLine, type VoiceClipAttributes } from "./voiceClipPatch";

/** An element's identity in the store. */
const keyOf = (element: TimelineElement) => element.key ?? element.id;

/** A line's selected take, to be played by every clip that speaks the line. */
export interface TakeApplication {
  lineId: string;
  take: VoiceTake;
}

export interface PlannedVoiceClip {
  element: TimelineElement;
  lineId: string;
  attributes: VoiceClipAttributes;
  /** Where the clip starts when an earlier take's new length pushed it; absent when it stays. */
  start?: number;
}

export type SkippedVoiceLine =
  /** No clip on the timeline speaks the line: nothing to update (the line may simply not be placed yet). */
  | { lineId: string; reason: "no-clips" }
  /** Every clip of the line is locked: a locked clip is not changed by hand. */
  | { lineId: string; reason: "locked" };

export interface VoiceTakePlan {
  clips: PlannedVoiceClip[];
  skipped: SkippedVoiceLine[];
  /** Other clips the ripple moves, for the same undo entry as the take change. */
  shifts: Array<{ element: TimelineElement; start: number }>;
  /**
   * Ripple is on and a later clip on a track the change touches is locked: the whole change is refused (no clip is
   * planned, nothing moves), the way the delete ripple refuses. The locked clips, for the message.
   */
  blockedBy: TimelineElement[];
  /** The lines whose clips the refusal kept as they were. */
  blockedLines: string[];
}

/**
 * What switching lines to their takes does on the timeline: each clip gets the take's file, in-point and length, and,
 * while ripple is on, the clips after it on its track move by the length difference. Pure: the caller writes it.
 */
export function planVoiceTakes(
  elements: readonly TimelineElement[],
  applications: readonly TakeApplication[],
  options: {
    rippleEnabled: boolean;
    /** The composition file a clip is written to (its own file, else the active one). */
    compositionPathOf: (element: TimelineElement) => string;
  },
): VoiceTakePlan {
  const clips: PlannedVoiceClip[] = [];
  const skipped: SkippedVoiceLine[] = [];
  for (const { lineId, take } of applications) {
    const onTimeline = voiceClipsOfLine(elements, lineId);
    if (onTimeline.length === 0) {
      skipped.push({ lineId, reason: "no-clips" });
      continue;
    }
    const editable = onTimeline.filter((element) => element.timelineLocked !== true);
    if (editable.length === 0) {
      skipped.push({ lineId, reason: "locked" });
      continue;
    }
    for (const element of editable) {
      clips.push({
        element,
        lineId,
        attributes: takeClipAttributes(take, element, options.compositionPathOf(element)),
      });
    }
  }

  const ripple = resolveDurationRipple(
    elements,
    clips.map(({ element, attributes }) => ({ element, duration: attributes.duration })),
    options.rippleEnabled,
  );
  if (ripple.kind !== "shift") {
    if (ripple.kind === "locked") {
      const locked = new Set(ripple.lockedKeys);
      return {
        clips: [],
        skipped,
        shifts: [],
        blockedBy: elements.filter((element) => locked.has(keyOf(element))),
        blockedLines: [...new Set(clips.map((clip) => clip.lineId))],
      };
    }
    return { clips, skipped, shifts: [], blockedBy: [], blockedLines: [] };
  }
  const moved = clips.map((clip) => {
    const start = ripple.starts.get(keyOf(clip.element));
    return start === undefined ? clip : { ...clip, start };
  });
  const shifts = elements.flatMap((element) => {
    const start = ripple.starts.get(keyOf(element));
    return start !== undefined && ripple.shiftedKeys.includes(keyOf(element))
      ? [{ element, start }]
      : [];
  });
  return { clips: moved, skipped, shifts, blockedBy: [], blockedLines: [] };
}

/**
 * The timeline's elements as the written plan leaves them, so the clips are where the file says before the preview
 * reloads. The shifted clips follow only when the ripple was saved.
 */
export function applyPlanToElements(
  elements: readonly TimelineElement[],
  plan: VoiceTakePlan,
  withShifts: boolean,
): TimelineElement[] {
  const patches = new Map<string, Partial<TimelineElement>>();
  for (const { element, attributes, start } of plan.clips) {
    patches.set(keyOf(element), {
      duration: attributes.duration,
      ...(start !== undefined && { start }),
      ...(attributes.mediaStart && {
        playbackStart: Number(attributes.mediaStart.value),
        playbackStartAttr:
          attributes.mediaStart.attribute === "data-playback-start"
            ? "playback-start"
            : "media-start",
      }),
    });
  }
  if (withShifts) {
    for (const { element, start } of plan.shifts) patches.set(keyOf(element), { start });
  }
  return elements.map((element) => {
    const patch = patches.get(keyOf(element));
    return patch ? { ...element, ...patch } : element;
  });
}
