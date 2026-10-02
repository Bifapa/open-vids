import type { ReactNode } from "react";
import type { TimelineElement } from "../store/playerStore";
import type { TimelineTimeRange } from "../store/rangeSelectionSlice";
import type { TimelineDropCallbacks } from "./timelineCallbacks";
import type { TimelineTheme } from "./timelineTheme";
import type { TimelineEditOverrides } from "./useResolvedTimelineEditCallbacks";

export interface TimelineClipRenderContext {
  priority: "overscan" | "visible" | "interaction";
  rich: boolean;
}

export interface TimelineProps extends TimelineDropCallbacks, TimelineEditOverrides {
  /** Project-scoped reset boundary; soft source refreshes retain the same epoch. */
  sessionEpoch?: number;
  /**
   * Read-only timeline: an agent turn is running for this project, so no clip gesture may start (playback, seek,
   * zoom, scroll and selection stay live). The host also refuses the edit callbacks themselves; this flag is what
   * keeps the timeline from arming a drag it would only have to throw away.
   */
  timelineLocked?: boolean;
  /** keepPlaying: true preserves the current play state across the seek. */
  onSeek?: (time: number, options?: { keepPlaying?: boolean }) => void;
  onDrillDown?: (element: TimelineElement) => void;
  renderClipContent?: (
    element: TimelineElement,
    style: { clip: string; label: string },
    context: TimelineClipRenderContext,
  ) => ReactNode;
  renderClipOverlay?: (element: TimelineElement) => ReactNode;
  onDeleteElement?: (element: TimelineElement) => Promise<void> | void;
  onSelectElement?: (element: TimelineElement | null) => void;
  /** Notification only; null when cleared. The value lives in usePlayerStore.rangeSelection. */
  onRangeSelect?: (range: TimelineTimeRange | null) => void;
  onCopyClip?: () => boolean;
  onPasteClip?: () => Promise<void>;
  onDuplicateClip?: () => Promise<boolean>;
  canPasteClip?: () => boolean;
  theme?: Partial<TimelineTheme>;
}
