import { useEffect, useRef } from "react";
import { formatNumber, useTranslation, type TranslationKey } from "../i18n";
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

type KeyframeToggle = ReturnType<typeof resolveKeyframeToggleState>;

function keyframeTooltipKey(toggle: KeyframeToggle, enabled: boolean): TranslationKey {
  const P = "shell.timelineToolbar.keyframe.tooltip.";
  if (toggle.pathEndpoint) return `${P}endpoint`;
  if (!enabled) return `${P}select`;
  if (toggle.isMotionPath) {
    if (toggle.willExtend) return `${P}extendPath`;
    return toggle.state === "active" ? `${P}removeWaypoint` : `${P}addWaypoint`;
  }
  if (toggle.state === "active") return `${P}remove`;
  if (toggle.state === "inactive") return toggle.willExtend ? `${P}addExtend` : `${P}add`;
  return `${P}default`;
}

function keyframeLabelKey(toggle: KeyframeToggle): TranslationKey {
  const P = "shell.timelineToolbar.keyframe.label.";
  if (toggle.pathEndpoint) return `${P}endpoint`;
  if (toggle.isMotionPath) {
    if (toggle.state === "active") return `${P}removeWaypoint`;
    return toggle.willExtend ? `${P}extendPath` : `${P}addWaypoint`;
  }
  return toggle.state === "active" ? `${P}remove` : `${P}add`;
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
  const { t } = useTranslation();
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
  const { onToggle: onToggleKeyframe, ...keyframeToggle } = useKeyframeToggle(domEditSession);
  const keyframeState = keyframeToggle.state;

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
    ? t("shell.timelineToolbar.thumbnails.hide")
    : t("shell.timelineToolbar.thumbnails.show");
  const keyframeTooltip = t(keyframeTooltipKey(keyframeToggle, Boolean(onToggleKeyframe)), {
    key: "K",
  });
  const keyframeLabel = t(keyframeLabelKey(keyframeToggle));
  const zoomValueText =
    zoomMode === "fit"
      ? t("shell.timelineToolbar.zoomFit")
      : t("shell.timelineToolbar.zoomPercent", {
          percent: formatNumber(displayedTimelineZoomPercent),
        });

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
      <div role="group" aria-label={t("shell.timelineToolbar.toolsLabel")} className={segGroup}>
        <Tooltip label={t("shell.timelineToolbar.select.tooltip", { key: "V" })}>
          <button
            type="button"
            onClick={() => setActiveTool("select")}
            aria-label={t("shell.timelineToolbar.select.label")}
            aria-pressed={activeTool === "select"}
            className={segButton}
          >
            <Cursor className="size-icon-sm" aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label={t("shell.timelineToolbar.razor.tooltip", { key: "B" })}>
          <button
            type="button"
            onClick={() => setActiveTool("razor")}
            aria-label={t("shell.timelineToolbar.razor.label")}
            aria-pressed={activeTool === "razor"}
            className={segButton}
          >
            <Scissors size={12} />
          </button>
        </Tooltip>
      </div>
      <Tooltip
        label={t(
          timelineSnapEnabled ? "shell.timelineToolbar.snap.on" : "shell.timelineToolbar.snap.off",
          { key: "N" },
        )}
      >
        <button
          type="button"
          onClick={() => setTimelineSnapEnabled(!timelineSnapEnabled)}
          aria-label={t("shell.timelineToolbar.snap.label")}
          aria-pressed={timelineSnapEnabled}
          className={timelineSnapEnabled ? flatActive : flatIdle}
        >
          <Magnet className="size-icon-md" weight="bold" aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip
        label={
          rippleEditEnabled
            ? t("shell.timelineToolbar.ripple.on")
            : t("shell.timelineToolbar.ripple.off")
        }
      >
        <button
          type="button"
          onClick={() => setRippleEditEnabled(!rippleEditEnabled)}
          aria-label={t("shell.timelineToolbar.ripple.label")}
          aria-pressed={rippleEditEnabled}
          className={rippleEditEnabled ? flatActive : flatIdle}
        >
          <RippleEditIcon size={14} />
        </button>
      </Tooltip>
      <span aria-hidden="true" className={toolbarSep} />
      <div
        role="group"
        aria-label={t("shell.timelineToolbar.editGroupLabel")}
        className="flex items-center gap-0.5"
      >
        {onSplitElement && (
          <Tooltip
            label={
              canSplit
                ? t("shell.timelineToolbar.split.tooltip", { key: "S" })
                : splittable
                  ? t("shell.timelineToolbar.split.moveInside")
                  : t("shell.timelineToolbar.split.selectClip")
            }
          >
            <button
              type="button"
              disabled={!canSplit}
              aria-label={t("shell.timelineToolbar.split.label")}
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
              ? t("shell.timelineToolbar.autoRecord.on")
              : t("shell.timelineToolbar.autoRecord.off")
          }
        >
          <button
            type="button"
            onClick={() => setAutoKeyframeEnabled(!autoKeyframeEnabled)}
            aria-label={t("shell.timelineToolbar.autoRecord.label")}
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
                ? t("shell.timelineToolbar.beat.noAnalysis")
                : canAddBeat
                  ? t("shell.timelineToolbar.beat.add")
                  : t("shell.timelineToolbar.beat.exists")
            }
          >
            <button
              type="button"
              disabled={!canAddBeat}
              aria-label={t("shell.timelineToolbar.beat.add")}
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
          <Tooltip
            label={t(
              audioMetersVisible
                ? "shell.timelineToolbar.meters.hide"
                : "shell.timelineToolbar.meters.show",
            )}
          >
            <button
              type="button"
              onClick={() => setAudioMetersVisible(!audioMetersVisible)}
              aria-label={t("shell.timelineToolbar.meters.label")}
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
        <Tooltip label={t("shell.timelineToolbar.zoomOut")}>
          <button
            type="button"
            aria-label={t("shell.timelineToolbar.zoomOut")}
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
          title={zoomValueText}
          aria-label={t("shell.timelineToolbar.zoomLabel")}
          aria-valuetext={zoomValueText}
          onChange={(e) => {
            setZoomMode("manual");
            setManualZoomPercent(
              timelineSliderToZoomPercent(Number(e.target.value), timelineFitPps),
            );
          }}
          // h-6 is the 24x24 pointer target; the visible track stays 3px.
          className="mx-0.5 h-6 w-[84px] cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-surface-3 [&::-webkit-slider-thumb]:-mt-[4.5px] [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-bg-0 [&::-webkit-slider-thumb]:bg-fg [&::-webkit-slider-thumb:active]:cursor-grabbing"
        />
        <Tooltip label={t("shell.timelineToolbar.zoomIn")}>
          <button
            type="button"
            aria-label={t("shell.timelineToolbar.zoomIn")}
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
        <Tooltip label={t("shell.timelineToolbar.fitToWidth")}>
          <button
            type="button"
            aria-label={t("shell.timelineToolbar.fitToWidth")}
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
