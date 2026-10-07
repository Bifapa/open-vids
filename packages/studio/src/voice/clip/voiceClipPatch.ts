import type { VoiceTake } from "@hyperframes/agent-protocol";
import {
  encodeAssetUrlPath,
  resolveTimelineAssetSrc,
} from "@hyperframes/core/editing/timeline-asset";
import type { TimelineElement } from "../../player";
import {
  formatTimelineAttributeNumber,
  formatTimelineMediaOffset,
} from "../../player/components/timelineEditing";
import {
  furthestClipEndFromSource,
  playbackStartAttributeForElement,
} from "../../player/lib/timelineElementHelpers";
import { applyPatchByTarget, type PatchTarget } from "../../utils/sourcePatcher";
import { setCompositionDurationToContent } from "../../utils/timelineAssetDrop";

/**
 * What a voiceover take looks like on a timeline clip: the audio file, where in it the line starts, and how long the
 * line is. A take is a range of its file (a scene file serves several lines), so the media in-point moves with it.
 */
export interface VoiceClipAttributes {
  /** `src` as the composition writes it: relative to the composition file, URL-encoded. */
  src: string;
  /** The media in-point, in the attribute the clip already uses; null when the clip starts at 0 and had none. */
  mediaStart: { attribute: "data-media-start" | "data-playback-start"; value: string } | null;
  /** The line's length, seconds, as the timeline writes it (centiseconds). */
  duration: number;
}

/** The clips that speak a line, in timeline order. */
export function voiceClipsOfLine(
  elements: readonly TimelineElement[],
  lineId: string,
): TimelineElement[] {
  return elements
    .filter((element) => element.voiceLine === lineId)
    .sort((a, b) => a.start - b.start || a.track - b.track);
}

/** The take's length as a clip duration, rounded the way every timeline write rounds it. */
export function takeClipDuration(take: Pick<VoiceTake, "start" | "end">): number {
  return Number(formatTimelineAttributeNumber(Math.max(0, take.end - take.start)));
}

/**
 * The attributes that make `clip` play `take`. The in-point is written when the take starts past 0 or the clip
 * already had one (an old in-point must not outlive a take that starts at 0).
 */
export function takeClipAttributes(
  take: Pick<VoiceTake, "file" | "start" | "end">,
  clip: Pick<TimelineElement, "kind" | "playbackStart" | "playbackStartAttr">,
  compositionPath: string,
): VoiceClipAttributes {
  const hasInPoint = clip.playbackStart !== undefined || clip.playbackStartAttr !== undefined;
  return {
    src: encodeAssetUrlPath(resolveTimelineAssetSrc(compositionPath, take.file)),
    mediaStart:
      take.start > 0 || hasInPoint
        ? {
            attribute: playbackStartAttributeForElement(clip),
            value: formatTimelineMediaOffset(Math.max(0, take.start)),
          }
        : null,
    duration: takeClipDuration(take),
  };
}

/**
 * The composition source with one clip switched to `attributes` (and moved to `start` when a ripple pushed it), and
 * the composition's own length following the furthest clip end, like every other clip edit. The same string comes
 * back when the clip already plays that take.
 */
export function patchVoiceClipSource(
  source: string,
  target: PatchTarget,
  attributes: VoiceClipAttributes,
  start?: number,
): string {
  let patched = applyPatchByTarget(source, target, {
    type: "html-attribute",
    property: "src",
    value: attributes.src,
  });
  patched = applyPatchByTarget(patched, target, {
    type: "attribute",
    property: "duration",
    value: formatTimelineAttributeNumber(attributes.duration),
  });
  if (attributes.mediaStart) {
    patched = applyPatchByTarget(patched, target, {
      type: "attribute",
      property: attributes.mediaStart.attribute.slice("data-".length),
      value: attributes.mediaStart.value,
    });
  }
  if (start !== undefined) {
    patched = applyPatchByTarget(patched, target, {
      type: "attribute",
      property: "start",
      value: formatTimelineAttributeNumber(start),
    });
  }
  return setCompositionDurationToContent(patched, furthestClipEndFromSource(patched));
}
