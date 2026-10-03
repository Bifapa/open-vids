/**
 * Manages motion-path recording state and commit logic for the Studio.
 * Extracted from App.tsx to keep file sizes under the 600-line limit.
 *
 * Flow: the button / R key ARMS the recording (nothing plays yet), a pointer
 * press on the canvas starts it (the delta is anchored at that point), the
 * pointer release — or R, or the element's end — commits it, Esc cancels it.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import {
  useGestureRecording,
  type GestureRecording,
  type GestureSample,
  type Modifiers,
} from "./useGestureRecording";
import { simplifyGestureSamples } from "../utils/rdpSimplify";
import { fitEasesFromVelocity } from "../utils/velocityEaseFitter";
import { smoothGestureKeyframes } from "../utils/gestureSmoother";
import { usePlayerStore } from "../player";
import type { DomEditSelection } from "../components/editor/domEditing";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { CommitMutationOptions } from "./gsapScriptCommitTypes";
import { roundTo3 } from "../utils/rounding";
import { classifyPropertyGroup } from "@hyperframes/core/gsap-parser";
import { isInstantHold, idSelector, writeTargetSelector, tweenTargetsElement } from "./gsapShared";
import { t } from "../i18n";

type RecordedKeyframe = {
  percentage: number;
  properties: Record<string, number | string>;
  ease?: string;
};

/**
 * Split recorded keyframes into one keyframe-set per property group (position /
 * scale / rotation / …), each keyframe carrying only that group's props.
 *
 * A mixed-prop gesture (e.g. x/y + opacity) emitted as ONE add-with-keyframes
 * mutation parses back as an untagged legacy mixed tween, which breaks the
 * position-only drag intercept (it can't find a pure position tween to edit).
 * Emitting one tween per group keeps the position tween tagged and editable.
 * Keyframes with no prop in a group are dropped from that group's set.
 */
function partitionKeyframesByGroup(keyframes: RecordedKeyframe[]): RecordedKeyframe[][] {
  // Preserve first-seen group order for deterministic, stable mutation ordering.
  const groupOrder: string[] = [];
  const byGroup = new Map<string, RecordedKeyframe[]>();
  for (const kf of keyframes) {
    const perGroup = new Map<string, Record<string, number | string>>();
    for (const [key, value] of Object.entries(kf.properties)) {
      const group = classifyPropertyGroup(key);
      let props = perGroup.get(group);
      if (!props) {
        props = {};
        perGroup.set(group, props);
      }
      props[key] = value;
    }
    for (const [group, props] of perGroup) {
      let set = byGroup.get(group);
      if (!set) {
        set = [];
        byGroup.set(group, set);
        groupOrder.push(group);
      }
      set.push({
        percentage: kf.percentage,
        properties: props,
        ...(kf.ease ? { ease: kf.ease } : {}),
      });
    }
  }
  return groupOrder.map((group) => byGroup.get(group)!);
}

// Minimal subset of the session used by gesture commit
interface GestureSessionRef {
  domEditSelection: DomEditSelection | null;
  selectedGsapAnimations?: GsapAnimation[];
  commitMutation?: (
    mutation: Record<string, unknown>,
    options: CommitMutationOptions,
  ) => Promise<void>;
}

/** Only the LAST group in a per-group commit loop reloads the preview; the
 *  earlier ones skip it, so a multi-group gesture recording is one reload. */
function reloadOnlyLast(index: number, count: number): Partial<CommitMutationOptions> {
  return index === count - 1 ? { softReload: true } : { skipReload: true };
}

/** True when any sampled property ever left its first value — a press that was
 *  released without moving records nothing worth committing. */
function samplesHaveMotion(samples: GestureSample[]): boolean {
  const first = samples[0];
  if (!first) return false;
  return samples.some((sample) => {
    const keys = new Set([...Object.keys(first.properties), ...Object.keys(sample.properties)]);
    return [...keys].some((key) => sample.properties[key] !== first.properties[key]);
  });
}

let gestureRecordingCommitCounter = 0;

interface UseGestureCommitParams {
  domEditSessionRef: React.MutableRefObject<GestureSessionRef>;
  previewIframeRef: React.RefObject<HTMLIFrameElement | null>;
  showToast: (message: string, tone?: "error" | "info") => void;
  isGestureRecordingRef: React.MutableRefObject<boolean>;
  readOnlyPreview: boolean;
}

export type GestureRecordingState = "idle" | "armed" | "recording";

export interface UseGestureCommitResult {
  gestureState: GestureRecordingState;
  gestureRecording: GestureRecording;
  /** Button / R key: arm when idle, disarm when armed, stop and commit when recording. */
  handleToggleRecording: () => void;
  /** Pointer press on the armed canvas: start playback + recording from this point. */
  beginRecording: (startPointer: { x: number; y: number }, modifiers: Modifiers) => void;
  /** Pointer release: stop and commit the recording. */
  finishRecording: () => void;
  /** Esc: drop an armed or running recording without committing. True when there was one. */
  cancelRecording: () => boolean;
}

export function useGestureCommit({
  domEditSessionRef,
  previewIframeRef,
  showToast,
  isGestureRecordingRef,
  readOnlyPreview,
}: UseGestureCommitParams): UseGestureCommitResult {
  const gestureRecording = useGestureRecording();
  const [gestureState, setGestureState] = useState<GestureRecordingState>("idle");
  const gestureStateRef = useRef<GestureRecordingState>("idle");
  const recordingAutoStopRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const recordingStartTimeRef = useRef(0);
  const commitInFlightRef = useRef(false);
  // Capture selection at recording start so commit always targets the recorded element,
  // even if the user's selection changes mid-recording.
  const capturedSelectionRef = useRef<DomEditSelection | null>(null);

  // Unmount: clear auto-stop interval
  useEffect(() => () => clearInterval(recordingAutoStopRef.current), []);

  const cancelRecording = useCallback((): boolean => {
    const previous = gestureStateRef.current;
    if (previous === "idle") return false;
    clearInterval(recordingAutoStopRef.current);
    if (previous === "recording") {
      gestureRecording.stopRecording();
      gestureRecording.clearSamples();
      // The recording drove the playhead; put it back where the user pressed.
      usePlayerStore.getState().requestSeek(recordingStartTimeRef.current);
    }
    gestureStateRef.current = "idle";
    isGestureRecordingRef.current = false;
    capturedSelectionRef.current = null;
    setGestureState("idle");
    return true;
  }, [gestureRecording, isGestureRecordingRef]);

  useEffect(() => {
    if (readOnlyPreview) cancelRecording();
  }, [cancelRecording, readOnlyPreview]);

  const stopAndCommitRecording = useCallback(async () => {
    clearInterval(recordingAutoStopRef.current);
    if (commitInFlightRef.current) {
      return;
    }
    commitInFlightRef.current = true;
    const coalesceOptions = {
      coalesceKey: `gesture-recording:${++gestureRecordingCommitCounter}`,
      coalesceMs: Number.POSITIVE_INFINITY,
    };
    gestureStateRef.current = "idle";
    isGestureRecordingRef.current = false;
    const frozenSamples = gestureRecording.stopRecording();
    const store = usePlayerStore.getState();
    store.setIsPlaying(false);
    try {
      const liveSession = domEditSessionRef.current;
      const sel = capturedSelectionRef.current;
      if (!sel) {
        if (frozenSamples.length > 2) {
          showToast(t("gesture.toast.selectionLost"), "error");
        }
        return;
      }
      const duration =
        frozenSamples.length > 0 ? (frozenSamples[frozenSamples.length - 1]?.time ?? 0) : 0;

      if (frozenSamples.length <= 2 || !samplesHaveMotion(frozenSamples)) {
        showToast(t("gesture.toast.noGesture"), "error");
        return;
      }
      if (duration <= 0) {
        showToast(t("gesture.toast.tooShort"), "error");
        return;
      }

      // Per-property epsilon: small-range properties (opacity 0–1, scale ~0.01–10)
      // need a much tighter tolerance than positional properties (x/y in px).
      const simplified = simplifyGestureSamples(frozenSamples, duration, (key) => {
        if (key === "opacity") return 0.01;
        if (key === "scale" || key === "scaleX" || key === "scaleY") return 0.01;
        return 5;
      });
      const sortedPcts = Array.from(simplified.keys()).sort((a, b) => a - b);

      // Ensure a 0% keyframe exists with the element's start-of-recording position
      if (!simplified.has(0) && frozenSamples.length > 0) {
        simplified.set(0, frozenSamples[0]!.properties);
        if (!sortedPcts.includes(0)) sortedPcts.unshift(0);
      }

      // Two different jobs, two different selectors. `selector` is the string an
      // ALREADY-AUTHORED tween is matched against (and retargeted with, so a
      // tween aimed at a whole group stays aimed at it). `writeSelector` is what
      // a NEW tween is authored with: the bare class the id-less case yields here
      // would record the gesture onto every sibling sharing it.
      const selector = sel.id ? idSelector(sel.id) : sel.selector;
      if (!selector) {
        showToast(t("gesture.toast.noSelector"), "error");
        return;
      }
      // A recorded gesture becomes a NEW tween, so its target must address one
      // element; the selection's own selector would record the motion onto
      // every sibling sharing its class (see writeTargetSelector).
      const writeSelector = writeTargetSelector(sel);
      if (!writeSelector) {
        showToast(t("gesture.toast.noUniqueSelector"), "error");
        return;
      }
      if (liveSession.commitMutation) {
        const recStart = recordingStartTimeRef.current;
        const rawKeyframes = sortedPcts.map((pct) => ({
          percentage: pct,
          properties: simplified.get(pct) as Record<string, number | string>,
        }));
        const smoothed = smoothGestureKeyframes(rawKeyframes, 3);
        const keyframes = fitEasesFromVelocity(smoothed, frozenSamples, duration);
        const hasPositionProps = keyframes.some((kf) =>
          Object.keys(kf.properties).some((k) => classifyPropertyGroup(k) === "position"),
        );
        const allAnims = liveSession.selectedGsapAnimations ?? [];
        const existingPositionTween = hasPositionProps
          ? allAnims.find(
              (a) =>
                a.propertyGroup === "position" &&
                tweenTargetsElement(a.targetSelector, selector, sel.element),
            )
          : undefined;
        if (existingPositionTween) {
          if (isInstantHold(existingPositionTween)) {
            // An instant hold is not a tween to merge into — replace it with the
            // recorded motion (which already starts from the held position).
            await liveSession.commitMutation(
              {
                type: "replace-with-keyframes",
                animationId: existingPositionTween.id,
                targetSelector: selector,
                position: roundTo3(recStart),
                duration: roundTo3(duration),
                keyframes,
              },
              { label: t("gesture.history.replaceSet"), softReload: true },
            );
          } else {
            const tweenStart = existingPositionTween.resolvedStart ?? 0;
            const tweenDur = existingPositionTween.duration ?? duration;
            const tweenEnd = tweenStart + tweenDur;
            const recEnd = recStart + duration;

            // Only merge if the recording overlaps the existing tween's time range.
            // No overlap → fall through to add-with-keyframes (creates a separate tween).
            const overlaps = recStart < tweenEnd + 0.05 && recEnd > tweenStart - 0.05;

            if (overlaps) {
              const existingKfs = existingPositionTween.keyframes?.keyframes ?? [];
              const rangeStartPct =
                tweenDur > 0 ? Math.max(0, ((recStart - tweenStart) / tweenDur) * 100) : 0;
              const rangeEndPct =
                tweenDur > 0 ? Math.min(100, ((recEnd - tweenStart) / tweenDur) * 100) : 100;

              const preserved = existingKfs
                .filter(
                  (kf) => kf.percentage < rangeStartPct - 0.5 || kf.percentage > rangeEndPct + 0.5,
                )
                .map((kf) => ({
                  percentage: kf.percentage,
                  properties: kf.properties,
                  ...(kf.ease ? { ease: kf.ease } : {}),
                }));

              const mapped = keyframes.map((kf) => ({
                percentage: rangeStartPct + (kf.percentage / 100) * (rangeEndPct - rangeStartPct),
                properties: kf.properties,
                ...(kf.ease ? { ease: kf.ease } : {}),
              }));

              const merged = [...preserved, ...mapped].sort((a, b) => a.percentage - b.percentage);

              await liveSession.commitMutation(
                {
                  type: "replace-with-keyframes",
                  animationId: existingPositionTween.id,
                  targetSelector: selector,
                  position:
                    typeof existingPositionTween.position === "number"
                      ? existingPositionTween.position
                      : tweenStart,
                  duration: tweenDur,
                  keyframes: merged,
                },
                { label: t("gesture.history.merge"), softReload: true },
              );
            } else {
              // Emit one tween per property group so a mixed-prop gesture (e.g.
              // x/y + opacity) doesn't collapse into an untagged legacy mixed
              // tween that the position-only drag intercept can't edit.
              const keyframeGroups = partitionKeyframesByGroup(keyframes);
              for (const [index, groupKfs] of keyframeGroups.entries()) {
                await liveSession.commitMutation(
                  {
                    type: "add-with-keyframes",
                    targetSelector: writeSelector,
                    position: roundTo3(recStart),
                    duration: roundTo3(duration),
                    keyframes: groupKfs,
                    // Linear fallback: the velocity fitter assigns a per-keyframe
                    // ease to non-constant segments and intentionally leaves
                    // constant-speed segments undefined → they must stay linear,
                    // not inherit a sigmoid.
                    easeEach: "none",
                  },
                  {
                    label: t("gesture.history.newRange"),
                    ...coalesceOptions,
                    ...reloadOnlyLast(index, keyframeGroups.length),
                  },
                );
              }
            }
          }
        } else {
          // No existing tween — same per-group split as the new-range branch above.
          const keyframeGroups = partitionKeyframesByGroup(keyframes);
          for (const [index, groupKfs] of keyframeGroups.entries()) {
            await liveSession.commitMutation(
              {
                type: "add-with-keyframes",
                targetSelector: writeSelector,
                position: roundTo3(recStart),
                duration: roundTo3(duration),
                keyframes: groupKfs,
                // Linear fallback (see above) — constant-speed segments stay linear.
                easeEach: "none",
              },
              {
                label: t("gesture.history.recording"),
                ...coalesceOptions,
                ...reloadOnlyLast(index, keyframeGroups.length),
              },
            );
          }
        }
      }
      showToast(t("gesture.toast.recorded", { count: sortedPcts.length }), "info");
    } catch (err) {
      console.error("[GR:error]", err);
      showToast(t("gesture.toast.commitFailed", { error: String(err) }), "error");
    } finally {
      store.requestSeek(recordingStartTimeRef.current);
      gestureRecording.clearSamples();
      setGestureState("idle");
      commitInFlightRef.current = false;
    }
  }, [gestureRecording, showToast, isGestureRecordingRef, domEditSessionRef]);

  const handleToggleRecording = useCallback(() => {
    const state = gestureStateRef.current;
    if (state === "recording") {
      if (readOnlyPreview) {
        cancelRecording();
        return;
      }
      void stopAndCommitRecording();
      return;
    }
    if (state === "armed") {
      cancelRecording();
      return;
    }
    if (readOnlyPreview || commitInFlightRef.current) return;
    const sel = domEditSessionRef.current.domEditSelection;
    if (!sel) {
      showToast(t("gesture.toast.selectFirst"), "error");
      return;
    }
    if (!previewIframeRef.current) {
      showToast(t("gesture.toast.previewNotReady"), "error");
      return;
    }
    capturedSelectionRef.current = sel;
    gestureStateRef.current = "armed";
    isGestureRecordingRef.current = true;
    setGestureState("armed");
  }, [
    showToast,
    stopAndCommitRecording,
    cancelRecording,
    previewIframeRef,
    domEditSessionRef,
    isGestureRecordingRef,
    readOnlyPreview,
  ]);

  const beginRecording = useCallback(
    (startPointer: { x: number; y: number }, modifiers: Modifiers) => {
      if (gestureStateRef.current !== "armed") return;
      // The element the user sees named on the overlay: selection may have moved on since arming.
      const sel = domEditSessionRef.current.domEditSelection;
      const iframe = previewIframeRef.current;
      if (!sel || !iframe) {
        cancelRecording();
        showToast(t(sel ? "gesture.toast.previewNotReady" : "gesture.toast.selectFirst"), "error");
        return;
      }
      recordingStartTimeRef.current = usePlayerStore.getState().currentTime;
      const elStart = Number.parseFloat(sel.dataAttributes?.start ?? "0") || 0;
      const elDur = Number.parseFloat(sel.dataAttributes?.duration ?? "0") || 0;
      const elementEnd = elDur > 0 ? elStart + elDur : undefined;
      capturedSelectionRef.current = sel;
      gestureRecording.startRecording(sel.element, iframe, {
        elementEndTime: elementEnd,
        startPointer,
        modifiers,
      });
      gestureStateRef.current = "recording";
      setGestureState("recording");

      clearInterval(recordingAutoStopRef.current);
      const autoStopAt = elementEnd ?? Infinity;
      recordingAutoStopRef.current = setInterval(() => {
        const { currentTime: t, duration: d } = usePlayerStore.getState();
        const limit = Math.min(autoStopAt, d);
        if (limit > 0 && t >= limit - 0.05) {
          void stopAndCommitRecording();
        }
      }, 100);
    },
    [
      gestureRecording,
      showToast,
      stopAndCommitRecording,
      cancelRecording,
      previewIframeRef,
      domEditSessionRef,
    ],
  );

  const finishRecording = useCallback(() => {
    if (gestureStateRef.current === "recording") void stopAndCommitRecording();
  }, [stopAndCommitRecording]);

  return {
    gestureState,
    gestureRecording,
    handleToggleRecording,
    beginRecording,
    finishRecording,
    cancelRecording,
  };
}
