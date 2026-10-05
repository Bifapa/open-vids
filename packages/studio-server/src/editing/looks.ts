import type { TimelineClip } from "@hyperframes/agent-protocol";
import { HF_AUDIO_AUTOMATION_ATTR, parseAutomation } from "@hyperframes/core/audio-automation";
import { HF_AUDIO_FX_ATTR, parseAudioFxChain } from "@hyperframes/core/audio-fx";
import { HF_COLOR_GRADING_ATTR, normalizeHfColorGrading } from "@hyperframes/core/color-grading";
import { parseStyleDecls } from "../helpers/sourceStyleMutation.js";

type Looks = Pick<
  TimelineClip,
  "playbackRate" | "opacity" | "colorGrade" | "audioFx" | "automation"
>;

/**
 * What a clip carries beyond timing, as the wire reports it: playback rate, opacity, colour grade, audio FX and
 * automation lanes. Only what differs from the default is present; an attribute that cannot be read is left out.
 */
export function clipLooks(element: Element, playbackRate: number): Looks {
  const looks: Looks = {};
  if (Math.abs(playbackRate - 1) > 1e-6) looks.playbackRate = playbackRate;
  const opacity = Number.parseFloat(
    parseStyleDecls(element.getAttribute("style") ?? "").props.get("opacity") ?? "",
  );
  if (Number.isFinite(opacity) && opacity < 1) looks.opacity = opacity;
  const grade = element.getAttribute(HF_COLOR_GRADING_ATTR);
  if (grade) {
    const normalized = normalizeHfColorGrading(grade);
    if (normalized) looks.colorGrade = normalized.preset ?? "custom";
  }
  const chain = element.getAttribute(HF_AUDIO_FX_ATTR);
  if (chain) {
    try {
      looks.audioFx = parseAudioFxChain(chain).nodes.length;
    } catch {
      // An unreadable chain is reported by the operations that need it.
    }
  }
  const automation = element.getAttribute(HF_AUDIO_AUTOMATION_ATTR);
  if (automation) {
    try {
      const targets = parseAutomation(automation).lanes.map((lane) => lane.target);
      if (targets.length > 0) looks.automation = targets;
    } catch {
      // Same: not readable here, refused where it matters.
    }
  }
  return looks;
}
