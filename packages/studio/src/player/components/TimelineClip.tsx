import { memo, type CSSProperties, type ReactNode } from "react";
import {
  FilmStrip,
  Image as ImageIcon,
  Shapes,
  Stack,
  Subtitles,
  Waveform,
} from "@phosphor-icons/react";
import { formatNumber, useTranslation } from "../../i18n";
import type { TimelineElement } from "../store/playerStore";
import {
  clipWidthLadder,
  defaultTimelineTheme,
  getClipHandleOpacity,
  type TimelineTheme,
} from "./timelineTheme";
import type { TimelineEditCapabilities } from "./timelineEditing";
import { isAudioTimelineElement } from "../../utils/timelineInspector";
import { timelineClipFocusId } from "./timelineNavigationIdentity";
import { TimelineClipFades } from "./TimelineClipFades";
import { timelineClipKind, type TimelineClipKind } from "./timelineTrackIdentity";

const CLIP_KIND_ICON: Record<TimelineClipKind, typeof FilmStrip> = {
  video: FilmStrip,
  image: ImageIcon,
  audio: Waveform,
  motion: Shapes,
  caption: Subtitles,
};

interface TimelineClipProps {
  el: TimelineElement;
  pps: number;
  clipY: number;
  clipHeight?: number;
  isSelected: boolean;
  isHovered: boolean;
  isDragging?: boolean;
  isGestureActor?: boolean;
  isActive?: boolean;
  hasCustomContent: boolean;
  capabilities: TimelineEditCapabilities;
  theme?: TimelineTheme;
  isComposition: boolean;
  tabIndex?: 0 | -1;
  onHoverStart: () => void;
  onHoverEnd: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onResizeStart?: (edge: "start" | "end", e: React.PointerEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children?: ReactNode;
}

export const TimelineClip = memo(function TimelineClip({
  el,
  pps,
  clipY,
  clipHeight,
  isSelected,
  isHovered,
  isDragging = false,
  isGestureActor = false,
  isActive = false,
  hasCustomContent,
  capabilities,
  theme = defaultTimelineTheme,
  isComposition,
  tabIndex = -1,
  onHoverStart,
  onHoverEnd,
  onPointerDown,
  onResizeStart,
  onClick,
  onDoubleClick,
  onContextMenu,
  children,
}: TimelineClipProps) {
  const { t } = useTranslation();
  const leftPx = el.start * pps;
  const widthPx = Math.max(el.duration * pps, 4);
  const handleOpacity = getClipHandleOpacity({ isHovered, isSelected, isDragging });
  const displayLabel = el.label || el.id || el.tag;
  const ladder = clipWidthLadder(widthPx);
  const showHandles = handleOpacity > 0.01 && (widthPx >= 32 || isSelected);
  const kind = timelineClipKind(el);
  // The kind strip names the clip; a caption is nothing but its strip.
  const showHead = ladder === "labeled" || (kind === "caption" && ladder === "picture");
  const showDefaultText = !hasCustomContent && ladder === "labeled" && kind !== "caption";
  const KindIcon = CLIP_KIND_ICON[kind];
  const oneDecimal = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  const startLabel = formatNumber(el.start, oneDecimal);
  const endLabel = formatNumber(el.start + el.duration, oneDecimal);
  const themeVariables = {
    "--clip-bg": theme.clipBackground,
    "--clip-bg-active": theme.clipBackgroundActive,
    "--clip-bg-hover": theme.clipBackgroundHover,
    "--clip-bg-dragging": theme.clipBackgroundDragging,
    "--clip-border": theme.clipBorder,
    "--clip-border-hover": theme.clipBorderHover,
    "--clip-border-active": theme.clipBorderActive,
    "--clip-handle": theme.handleColor,
  } as CSSProperties;
  const isAudioClip = isAudioTimelineElement(el);
  const clipClassName = [
    "timeline-clip",
    `k-${kind}`,
    "absolute",
    hasCustomContent ? "overflow-visible" : "overflow-hidden",
    showHead ? "has-head" : "",
    isSelected ? "is-selected" : "",
    isHovered ? "is-hovered" : "",
    isDragging ? "is-dragging" : "",
    isAudioClip ? "is-audio" : "",
  ]
    .filter((className) => className.length > 0)
    .join(" ");
  const style: CSSProperties = {
    left: leftPx,
    width: widthPx,
    top: clipY,
    ...(clipHeight === undefined ? { bottom: clipY } : { height: clipHeight }),
    borderRadius: isAudioClip ? theme.audioClipRadius : theme.clipRadius,
    ...themeVariables,
    zIndex: isDragging ? 20 : isSelected ? 10 : isHovered ? 5 : 1,
    // Regular cursor over clips (CapCut-style, user preference) — no grab hand.
    // While an agent turn runs the timeline is read-only, so the cursor says so.
    cursor: capabilities.timelineLocked ? "not-allowed" : "default",
    appearance: "none",
    color: "inherit",
    font: "inherit",
    padding: 0,
    textAlign: "left",
    transform: isDragging ? "translateY(-1px)" : undefined,
  };

  return (
    <button
      type="button"
      data-clip={isGestureActor ? undefined : "true"}
      data-el-id={isGestureActor ? undefined : (el.key ?? el.id)}
      data-timeline-focus-id={isGestureActor ? undefined : timelineClipFocusId(el.key ?? el.id)}
      data-clip-start={el.start}
      data-clip-end={el.start + el.duration}
      data-clip-hidden={el.hidden ? "true" : undefined}
      data-ladder={ladder}
      data-active={isActive ? "" : undefined}
      aria-hidden={isGestureActor ? "true" : undefined}
      tabIndex={isGestureActor ? undefined : tabIndex}
      aria-label={t("player.clip.aria", { label: displayLabel, start: startLabel, end: endLabel })}
      aria-pressed={isGestureActor ? undefined : isSelected}
      className={clipClassName}
      style={style}
      title={
        isComposition
          ? t("player.clip.titleComposition", { src: el.compositionSrc ?? "" })
          : t("player.clip.titleRange", { label: displayLabel, start: startLabel, end: endLabel })
      }
      onPointerEnter={onHoverStart}
      onPointerLeave={onHoverEnd}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {/* Trim handles: a 14px hit area, drawn as the 7px edge strip. */}
      {showHandles && capabilities.canTrimStart && (
        <div
          aria-hidden="true"
          onPointerDown={(e) => onResizeStart?.("start", e)}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 14,
            cursor: "col-resize",
            zIndex: 4,
          }}
        >
          <div className="timeline-clip__handle-bar" style={{ left: 0 }} />
        </div>
      )}
      {showHandles && capabilities.canTrimEnd && (
        <div
          aria-hidden="true"
          onPointerDown={(e) => onResizeStart?.("end", e)}
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            bottom: 0,
            width: 14,
            cursor: "col-resize",
            zIndex: 4,
          }}
        >
          <div className="timeline-clip__handle-bar" style={{ right: 0 }} />
        </div>
      )}
      {showHead && (
        <span className="timeline-clip__head" aria-hidden="true">
          <KindIcon className="timeline-clip__icon" weight="bold" />
          <span className="timeline-clip__label">{displayLabel}</span>
          {isComposition && <Stack className="timeline-clip__icon ml-auto" weight="bold" />}
        </span>
      )}
      {showDefaultText && (
        <span className="timeline-clip__timecode">
          {t("player.clip.range", { start: startLabel, end: endLabel })}
        </span>
      )}
      {children}
      {/* Fade handles + ramps for anything the mixer hears — audio clips and
          videos marked data-has-audio. They write data-fade-in/out on the clip
          and are the timeline half of the inspector's Fade rows. */}
      {(isAudioClip || el.hasAudio) && !isGestureActor && (
        <TimelineClipFades
          el={el}
          pps={pps}
          widthPx={widthPx}
          showHandles={(isHovered || isSelected) && !isDragging}
        />
      )}
    </button>
  );
});
