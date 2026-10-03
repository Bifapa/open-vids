import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { AssetRange } from "@hyperframes/agent-protocol";
import { useTranslation } from "../i18n";
import { AudioWaveform } from "../player/components/AudioWaveform";
import { encodePreviewPath, resolveMediaPreviewUrl } from "../player/components/thumbnailUtils";
import { usePlayerStore } from "../player/store/playerStore";
import { buildProjectApiPath } from "../utils/projectRouting";
import {
  dragRange,
  formatRangeTime,
  nudgeHandle,
  percentAt,
  timeAtPointer,
  type RangeDragMode,
  type RangeHandle,
} from "./assetRange";
import type { MediaItem } from "./mediaLibrary";

/** `drag`: still moving (preview only), `release`: the pointer let go, `key`: an arrow-key step. */
export type RangeChangePhase = "drag" | "release" | "key";

interface Drag {
  mode: RangeDragMode | "scrub";
  originX: number;
  origin: AssetRange;
  moved: boolean;
}

/** Pointer travel (px) that turns a press on the selection into a drag rather than a seek. */
const DRAG_THRESHOLD_PX = 3;

const handleBar =
  "absolute inset-y-1 left-1/2 w-1 -translate-x-1/2 rounded-xs bg-accent shadow-[0_0_0_1px_var(--color-bg-0)] group-focus-visible:outline-solid group-focus-visible:outline-2 group-focus-visible:outline-offset-1 group-focus-visible:outline-accent group-hover:bg-accent-hover";

export interface AssetRangeStripProps {
  item: MediaItem;
  projectId: string;
  /** The range shown (the draft while editing, else the stored pick or the whole file). */
  range: AssetRange;
  duration: number;
  /** The media's playhead. */
  time: number;
  /** Where the shots start (a video's scene map): faint ticks over the bar. */
  markers: readonly number[];
  onChange: (range: AssetRange, phase: RangeChangePhase) => void;
  onSeek: (time: number) => void;
}

/**
 * The strip a fragment is picked on: the media's waveform (or a plain bar), the area outside the pick dimmed, a
 * handle at each end and the playhead. Handles and the selection take pointer drags; handles are sliders that
 * Left/Right nudge by 0.1 s (Shift: 1 s); a press elsewhere moves the playhead.
 */
export function AssetRangeStrip({
  item,
  projectId,
  range,
  duration,
  time,
  markers,
  onChange,
  onSeek,
}: AssetRangeStripProps) {
  const { t } = useTranslation();
  const sessionEpoch = usePlayerStore((state) => state.timelineSessionEpoch);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const hasSound = item.kind === "audio" || item.hasAudio !== false;
  const audioUrl = resolveMediaPreviewUrl(item.path, projectId);
  const waveformUrl = buildProjectApiPath(projectId, `/waveform/${encodePreviewPath(item.path)}`);

  const secondsPerPixel = () => {
    const width = trackRef.current?.getBoundingClientRect().width ?? 0;
    return width > 0 ? duration / width : 0;
  };

  const begin = (event: PointerEvent<HTMLElement>, mode: Drag["mode"]) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { mode, originX: event.clientX, origin: range, moved: false };
    if (mode === "scrub") seekTo(event.clientX);
  };

  const seekTo = (clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (box) onSeek(timeAtPointer(clientX, box.left, box.width, duration));
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    if (current.mode === "scrub") {
      seekTo(event.clientX);
      return;
    }
    const travel = event.clientX - current.originX;
    if (!current.moved && Math.abs(travel) < DRAG_THRESHOLD_PX) return;
    current.moved = true;
    onChange(dragRange(current.mode, current.origin, travel * secondsPerPixel(), duration), "drag");
  };

  const end = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (current.mode === "scrub") return;
    if (!current.moved) {
      // A press on the selection that did not move is a click: it seeks.
      if (current.mode === "move") seekTo(event.clientX);
      return;
    }
    const travel = event.clientX - current.originX;
    onChange(
      dragRange(current.mode, current.origin, travel * secondsPerPixel(), duration),
      "release",
    );
  };

  const cancel = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    drag.current = null;
    if (current && current.mode !== "scrub" && current.moved) onChange(current.origin, "drag");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLElement>, handle: RangeHandle) => {
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -1
          : 0;
    if (direction === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(nudgeHandle(handle, range, direction, event.shiftKey, duration), "key");
  };

  const startAt = percentAt(range.start, duration);
  const endAt = percentAt(range.end, duration);
  const handles: Array<{ handle: RangeHandle; at: string; label: string; value: number }> = [
    { handle: "start", at: startAt, label: t("media.range.startHandle"), value: range.start },
    { handle: "end", at: endAt, label: t("media.range.endHandle"), value: range.end },
  ];

  return (
    <div className="mx-2 select-none" data-testid="media-range-strip">
      <div
        ref={trackRef}
        className="relative h-[52px] touch-none cursor-pointer"
        onPointerDown={(event) => begin(event, "scrub")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={cancel}
      >
        <div className="pointer-events-none absolute inset-0 isolate overflow-hidden rounded-sm border border-border bg-surface-1">
          {hasSound && (
            <AudioWaveform
              audioUrl={audioUrl}
              waveformUrl={waveformUrl}
              label=""
              labelColor="transparent"
              projectId={projectId}
              sessionEpoch={sessionEpoch}
              priority="visible"
            />
          )}
          {markers.map((marker) => (
            <i
              key={marker}
              className="absolute inset-y-0 w-px bg-fg-3/40"
              style={{ left: percentAt(marker, duration) }}
            />
          ))}
        </div>
        <div
          className="pointer-events-none absolute inset-y-0 left-0 rounded-l-sm bg-bg-0/70"
          style={{ width: startAt }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 rounded-r-sm bg-bg-0/70"
          style={{ left: endAt }}
        />
        <div
          role="group"
          aria-label={t("media.range.selection")}
          title={t("media.range.selection")}
          className="absolute inset-y-0 cursor-grab border-y-2 border-accent active:cursor-grabbing"
          style={{ left: startAt, width: `calc(${endAt} - ${startAt})` }}
          onPointerDown={(event) => begin(event, "move")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={cancel}
        />
        {handles.map(({ handle, at, label, value }) => (
          <div
            key={handle}
            role="slider"
            tabIndex={0}
            aria-label={label}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={value}
            aria-valuetext={formatRangeTime(value)}
            data-handle={handle}
            className="group absolute inset-y-0 z-10 -ml-2 w-4 cursor-ew-resize outline-hidden"
            style={{ left: at }}
            onPointerDown={(event) => begin(event, handle)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={cancel}
            onKeyDown={(event) => keyDown(event, handle)}
          >
            <span aria-hidden="true" className={handleBar} />
          </div>
        ))}
        <i
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-20 -ml-px w-0.5 rounded-[1px] bg-fg shadow-[0_0_0_1px_var(--color-bg-0)]"
          style={{ left: percentAt(time, duration) }}
        />
      </div>
    </div>
  );
}
