import { useEffect, useRef } from "react";
import {
  CornersOut,
  Cursor,
  FilmStrip,
  Magnet,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Metronome,
  Record,
} from "@phosphor-icons/react";
import {
  useEnableKeyframes,
  isPlayheadWithinTween,
  type EnableKeyframesSession,
} from "../hooks/useEnableKeyframes";
import { computeElementPercentage, KEYFRAME_PCT_MATCH } from "../hooks/gsapShared";
import { useKeyframeKeyboard } from "../hooks/useKeyframeKeyboard";
import {
  getNextTimelineZoomPercent,
  getTimelineZoomPercent,
  timelineZoomPercentToSlider,
  timelineSliderToZoomPercent,
} from "../player/components/timelineZoom";
import { useTimelineZoom } from "../player/components/useTimelineZoom";
import { usePlayerStore, type TimelineElement } from "../player";
import { Tooltip } from "./ui";
import { AudioMetersIcon } from "./icons/AudioMetersIcon";
import { RippleEditIcon } from "./icons/RippleEditIcon";
import {
  flatActive,
  flatBtn,
  flatDisabled,
  flatIdle,
  segButton,
  segGroup,
  toolbarSep,
} from "./timelineToolbarStyles";
import { TimelineHistoryButtons, type TimelineHistoryButtonsProps } from "./TimelineHistoryButtons";
import { Scissors } from "../icons/SystemIcons";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "./editor/domEditingTypes";
import { canSplitElement } from "../utils/timelineElementSplit";
import { useAudioMetersVisible } from "../utils/audioMeterVisibility";
import { useProjectHasAudio } from "../utils/audioMeterMath";
import { canAddBeatAt, addBeatAtCompositionTime } from "../utils/beatEditActions";

interface DomEditSessionSlice extends EnableKeyframesSession {
  domEditSelection: DomEditSelection | null;
  selectedGsapAnimations: GsapAnimation[];
}

export interface TimelineToolbarProps {
  domEditSession?: DomEditSessionSlice;
  onSplitElement?: (element: TimelineElement, splitTime: number) => void;
  /** An embedder's own Undo/Redo; Studio shows them in the titlebar instead. */
  history?: TimelineHistoryButtonsProps;
  showAddBeat?: boolean;
}

interface KeyframeToggleState {
  state: "active" | "inactive" | "none";
  isMotionPath: boolean;
  pathEndpoint: boolean;
  willExtend: boolean;
}

const NO_KEYFRAME_TOGGLE: KeyframeToggleState = {
  state: "none",
  isMotionPath: false,
  pathEndpoint: false,
  willExtend: false,
};

function isMotionPathEndpoint(animation: GsapAnimation | undefined, percentage: number): boolean {
  if (!animation?.keyframes) return false;
  const keyframes = animation.keyframes.keyframes;
  return (
    Math.abs((keyframes[0]?.percentage ?? -Infinity) - percentage) <= KEYFRAME_PCT_MATCH ||
    Math.abs((keyframes.at(-1)?.percentage ?? Infinity) - percentage) <= KEYFRAME_PCT_MATCH
  );
}

function resolveKeyframeToggleState(
  session: DomEditSessionSlice | undefined,
  currentTime: number,
): KeyframeToggleState {
  if (!session?.domEditSelection) return NO_KEYFRAME_TOGGLE;
  const arcAnimation = session.selectedGsapAnimations.find(
    (animation) => animation.arcPath && animation.keyframes,
  );
  const animation =
    arcAnimation ??
    session.selectedGsapAnimations.find((candidate) => candidate.keyframes && !candidate.arcPath);
  if (!animation?.keyframes) return NO_KEYFRAME_TOGGLE;

  const isMotionPath = Boolean(arcAnimation);
  if (!isPlayheadWithinTween(animation, currentTime, session.domEditSelection)) {
    return { state: "inactive", isMotionPath, pathEndpoint: false, willExtend: true };
  }

  const percentage = computeElementPercentage(currentTime, session.domEditSelection, animation);
  const pathEndpoint = isMotionPathEndpoint(arcAnimation, percentage);
  const active = animation.keyframes.keyframes.some(
    (keyframe) => Math.abs(keyframe.percentage - percentage) <= KEYFRAME_PCT_MATCH,
  );
  return {
    state: pathEndpoint ? "none" : active ? "active" : "inactive",
    isMotionPath,
    pathEndpoint,
    willExtend: false,
  };
}

/**
 * Can this element be keyframed at all?
 *
 * An audio clip cannot. It has no box on the canvas, so there is nothing to move,
 * scale or fade — and "add a keyframe" on one seeds a tween from the position
 * properties, which produced a position lane on a track that has no position. Audio
 * is automated instead: volume and effect parameters, on their own lanes.
 */
function isKeyframeable(element: TimelineElement | undefined): boolean {
  return element?.tag !== "audio";
}

function useKeyframeToggle(session?: DomEditSessionSlice) {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const selectedElementId = usePlayerStore((s) => s.selectedElementId);
  const elements = usePlayerStore((s) => s.elements);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const onToggle = useEnableKeyframes(
    sessionRef as React.RefObject<EnableKeyframesSession | undefined>,
  );

  const selected = elements.find((element) => (element.key ?? element.id) === selectedElementId);
  if (!isKeyframeable(selected)) return { ...NO_KEYFRAME_TOGGLE, onToggle: undefined };

  const toggleState = resolveKeyframeToggleState(session, currentTime);

  return {
    ...toggleState,
    onToggle: session?.domEditSelection && !toggleState.pathEndpoint ? onToggle : undefined,
  };
}

export function TimelineToolbar({
  domEditSession,
  onSplitElement,
  history,
  showAddBeat = true,
}: TimelineToolbarProps) {
  const activeTool = usePlayerStore((s) => s.activeTool);
  const setActiveTool = usePlayerStore((s) => s.setActiveTool);
  const timelineSnapEnabled = usePlayerStore((s) => s.timelineSnapEnabled);
  const setTimelineSnapEnabled = usePlayerStore((s) => s.setTimelineSnapEnabled);
  const rippleEditEnabled = usePlayerStore((s) => s.rippleEditEnabled);
  const setRippleEditEnabled = usePlayerStore((s) => s.setRippleEditEnabled);
  const autoKeyframeEnabled = usePlayerStore((s) => s.autoKeyframeEnabled);
  const setAutoKeyframeEnabled = usePlayerStore((s) => s.setAutoKeyframeEnabled);
  const thumbnailMode = usePlayerStore((s) => s.thumbnailMode);
  const setThumbnailMode = usePlayerStore((s) => s.setThumbnailMode);
  const thumbnailsVisible = thumbnailMode === "adaptive";
  const audioMetersVisible = useAudioMetersVisible((s) => s.visible);
  const setAudioMetersVisible = useAudioMetersVisible((s) => s.setVisible);
  const projectHasAudio = useProjectHasAudio();
  // Subscribe so the add-beat button reacts to playhead movement and analysis load.
  const currentTime = usePlayerStore((s) => s.currentTime);
  const beatAnalysisReady = usePlayerStore((s) => s.beatAnalysis !== null);
  // Subscribe (not getState) so the split button enables/disables the moment
  // the selection changes, not only on the next playhead tick.
  const selectedElementId = usePlayerStore((s) => s.selectedElementId);
  const elements = usePlayerStore((s) => s.elements);
  const timelineFitPps = usePlayerStore((s) => s.timelineFitPps);
  const { zoomMode, manualZoomPercent, setZoomMode, setManualZoomPercent } = useTimelineZoom();
  const displayedTimelineZoomPercent = getTimelineZoomPercent(
    zoomMode,
    manualZoomPercent,
    timelineFitPps,
  );
  const {
    state: keyframeState,
    isMotionPath: keyframeIsMotionPath,
    pathEndpoint: keyframePathEndpoint,
    willExtend: keyframeWillExtend,
    onToggle: onToggleKeyframe,
  } = useKeyframeToggle(domEditSession);

  // Wire the "Add keyframe (K)" shortcut the toolbar advertises. Active only when
  // there's a keyframeable selection; otherwise K stays JKL-pause in playback.
  useKeyframeKeyboard({
    enabled: Boolean(onToggleKeyframe),
    onAddKeyframe: onToggleKeyframe,
  });

  // "N" toggles timeline snapping (industry convention: Resolve/FCP).
  // Skip when typing in an input/contenteditable.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "n" && e.key !== "N") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.isContentEditable) return;
      const tag = target?.tagName?.toLowerCase() ?? "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const store = usePlayerStore.getState();
      store.setTimelineSnapEnabled(!store.timelineSnapEnabled);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Mirrors the S-key gate: selected clip + playhead strictly inside it.
  const splitTarget = selectedElementId
    ? elements.find((e) => (e.key ?? e.id) === selectedElementId)
    : null;
  const splittable = splitTarget != null && canSplitElement(splitTarget);
  const canSplit =
    splittable &&
    currentTime > splitTarget.start &&
    currentTime < splitTarget.start + splitTarget.duration;
  const canAddBeat = beatAnalysisReady && canAddBeatAt(currentTime);
  const thumbnailsLabel = thumbnailsVisible
    ? "Hide thumbnails — labels only"
    : "Show thumbnails — posters stay visible; richer previews appear on interaction";
  const keyframeTooltip = keyframePathEndpoint
    ? "Motion path endpoints cannot be removed"
    : !onToggleKeyframe
      ? "Select an animated element to add keyframes"
      : keyframeIsMotionPath
        ? keyframeWillExtend
          ? "Extend motion path to playhead (K)"
          : keyframeState === "active"
            ? "Remove waypoint from motion path (K)"
            : "Add waypoint to motion path (K)"
        : keyframeState === "active"
          ? "Remove keyframe at playhead (K)"
          : keyframeState === "inactive"
            ? keyframeWillExtend
              ? "Add keyframe at playhead, extends animation (K)"
              : "Add keyframe at playhead (K)"
            : "Add keyframe (K)";
  const keyframeLabel = keyframePathEndpoint
    ? "Motion path endpoint"
    : keyframeIsMotionPath
      ? keyframeState === "active"
        ? "Remove motion path waypoint"
        : keyframeWillExtend
          ? "Extend motion path to playhead"
          : "Add motion path waypoint"
      : keyframeState === "active"
        ? "Remove keyframe at playhead"
        : "Add keyframe at playhead";

  // Controls stay mounted and fade to disabled rather than unmounting, so the
  // head never shifts under the pointer mid-task.
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {history && (
        <>
          <TimelineHistoryButtons {...history} />
          <span aria-hidden="true" className={toolbarSep} />
        </>
      )}
      <div role="group" aria-label="Tools" className={segGroup}>
        <Tooltip label="Selection tool (V)">
          <button
            type="button"
            onClick={() => setActiveTool("select")}
            aria-label="Selection tool"
            aria-pressed={activeTool === "select"}
            className={segButton}
          >
            <Cursor className="size-icon-sm" aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label="Razor tool (B) — Shift+click splits all tracks">
          <button
            type="button"
            onClick={() => setActiveTool("razor")}
            aria-label="Razor tool"
            aria-pressed={activeTool === "razor"}
            className={segButton}
          >
            <Scissors size={12} />
          </button>
        </Tooltip>
      </div>
      <Tooltip label={timelineSnapEnabled ? "Snapping on (N)" : "Snapping off (N)"}>
        <button
          type="button"
          onClick={() => setTimelineSnapEnabled(!timelineSnapEnabled)}
          aria-label="Toggle timeline snapping"
          aria-pressed={timelineSnapEnabled}
          className={timelineSnapEnabled ? flatActive : flatIdle}
        >
          <Magnet className="size-icon-md" weight="bold" aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip
        label={
          rippleEditEnabled
            ? "Ripple on — keeps the main track gapless"
            : "Ripple off — deleting a main-track clip leaves a gap"
        }
      >
        <button
          type="button"
          onClick={() => setRippleEditEnabled(!rippleEditEnabled)}
          aria-label="Toggle ripple edit"
          aria-pressed={rippleEditEnabled}
          className={rippleEditEnabled ? flatActive : flatIdle}
        >
          <RippleEditIcon size={14} />
        </button>
      </Tooltip>
      <span aria-hidden="true" className={toolbarSep} />
      <div role="group" aria-label="Edit at playhead" className="flex items-center gap-0.5">
        {onSplitElement && (
          <Tooltip
            label={
              canSplit
                ? "Split at playhead (S)"
                : splittable
                  ? "Move the playhead inside the clip to split"
                  : "Select a clip to split"
            }
          >
            <button
              type="button"
              disabled={!canSplit}
              aria-label="Split at playhead"
              onClick={() => {
                if (canSplit && splitTarget) onSplitElement(splitTarget, currentTime);
              }}
              className={canSplit ? flatIdle : flatDisabled}
            >
              {/* "][" split glyph: two outward-facing brackets with a center gap */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 3 L7 3 L7 13 L5 13" />
                <path d="M11 3 L9 3 L9 13 L11 13" />
              </svg>
            </button>
          </Tooltip>
        )}
        <Tooltip label={keyframeTooltip}>
          <button
            type="button"
            disabled={!onToggleKeyframe}
            onClick={onToggleKeyframe}
            aria-label={keyframeLabel}
            className={
              !onToggleKeyframe
                ? flatDisabled
                : `${flatIdle} ${keyframeState === "active" ? "text-kf hover:text-kf" : ""}`
            }
          >
            <svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              {keyframeState === "active" ? (
                <path d="M5 0.5L9.5 5L5 9.5L0.5 5Z" />
              ) : (
                <path
                  d="M5 1.2L8.8 5L5 8.8L1.2 5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              )}
            </svg>
          </button>
        </Tooltip>
        <Tooltip
          label={
            autoKeyframeEnabled
              ? "Auto-record manual edits as keyframes (click to turn off)"
              : "Manual edits will not be recorded as keyframes (click to turn on)"
          }
        >
          <button
            type="button"
            onClick={() => setAutoKeyframeEnabled(!autoKeyframeEnabled)}
            aria-label="Auto-record manual edits as keyframes"
            aria-pressed={autoKeyframeEnabled}
            className={autoKeyframeEnabled ? `${flatBtn} bg-error-soft text-error` : flatIdle}
          >
            <Record
              className="size-icon-md"
              weight={autoKeyframeEnabled ? "fill" : "regular"}
              aria-hidden="true"
            />
          </button>
        </Tooltip>
        {showAddBeat && (
          <Tooltip
            label={
              !beatAnalysisReady
                ? "Add a music track with beat analysis to place beats"
                : canAddBeat
                  ? "Add beat at playhead"
                  : "A beat already exists at the playhead"
            }
          >
            <button
              type="button"
              disabled={!canAddBeat}
              aria-label="Add beat at playhead"
              onClick={() => {
                if (canAddBeat) addBeatAtCompositionTime(currentTime);
              }}
              className={canAddBeat ? flatIdle : flatDisabled}
            >
              <Metronome className="size-icon-md" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {projectHasAudio && (
          <Tooltip label={audioMetersVisible ? "Hide audio meters" : "Show audio meters"}>
            <button
              type="button"
              onClick={() => setAudioMetersVisible(!audioMetersVisible)}
              aria-label="Toggle audio meters"
              aria-pressed={audioMetersVisible}
              className={audioMetersVisible ? flatActive : flatIdle}
            >
              <AudioMetersIcon size={14} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={thumbnailsLabel}>
          <button
            type="button"
            aria-label={thumbnailsLabel}
            aria-pressed={thumbnailsVisible}
            onClick={() => setThumbnailMode(thumbnailsVisible ? "hidden" : "adaptive")}
            className={thumbnailsVisible ? flatActive : flatIdle}
          >
            <FilmStrip className="size-icon-md" aria-hidden="true" />
          </button>
        </Tooltip>
        <span aria-hidden="true" className={toolbarSep} />
        <Tooltip label="Zoom out">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => {
              setZoomMode("manual");
              setManualZoomPercent(
                getNextTimelineZoomPercent("out", zoomMode, manualZoomPercent, timelineFitPps),
              );
            }}
            className={flatIdle}
          >
            <MagnifyingGlassMinus className="size-icon-md" aria-hidden="true" />
          </button>
        </Tooltip>
        <input
          type="range"
          min="0"
          max="100"
          value={timelineZoomPercentToSlider(displayedTimelineZoomPercent, timelineFitPps)}
          title={zoomMode === "fit" ? "Fit" : `${displayedTimelineZoomPercent}%`}
          aria-label="Timeline zoom"
          aria-valuetext={zoomMode === "fit" ? "Fit" : `${displayedTimelineZoomPercent}%`}
          onChange={(e) => {
            setZoomMode("manual");
            setManualZoomPercent(
              timelineSliderToZoomPercent(Number(e.target.value), timelineFitPps),
            );
          }}
          // h-6 is the 24x24 pointer target; the visible track stays 3px.
          className="mx-0.5 h-6 w-[84px] cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-surface-3 [&::-webkit-slider-thumb]:-mt-[4.5px] [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-bg-0 [&::-webkit-slider-thumb]:bg-fg [&::-webkit-slider-thumb:active]:cursor-grabbing"
        />
        <Tooltip label="Zoom in">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => {
              setZoomMode("manual");
              setManualZoomPercent(
                getNextTimelineZoomPercent("in", zoomMode, manualZoomPercent, timelineFitPps),
              );
            }}
            className={flatIdle}
          >
            <MagnifyingGlassPlus className="size-icon-md" aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label="Fit timeline to width">
          <button
            type="button"
            aria-label="Fit timeline to width"
            aria-pressed={zoomMode === "fit"}
            onClick={() => setZoomMode("fit")}
            className={zoomMode === "fit" ? flatActive : flatIdle}
          >
            <CornersOut className="size-icon-md" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
