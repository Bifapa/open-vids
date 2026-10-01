import { CaretRight } from "@phosphor-icons/react";
import { TRACK_H } from "./timelineLayout";
import { TrackClipCount } from "./TrackClipCount";
import { TrackCode } from "./TimelineTrackPlainHeader";

/**
 * The caret that shows or hides a row's lanes, first in the track head.
 *
 * Shared, because two layouts need the identical control: the keyframe layer
 * row below, and the plain track header — an audio track with automation keeps
 * its own look and gains this, rather than being re-rendered as a keyframe
 * layer to get at the button. A group's own row has a separate structural
 * caret (member rows); this one only ever means "show this row's lanes".
 */
export function LaneToggleButton({
  name,
  isExpanded,
  lanesId,
  onToggle,
}: {
  name: string;
  isExpanded: boolean;
  lanesId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      // ponytail: No focus id here; keyboard routing belongs to the enclosing logical row.
      tabIndex={-1}
      aria-expanded={isExpanded}
      aria-controls={lanesId}
      aria-label={`${isExpanded ? "Hide" : "Show"} ${name} lanes`}
      title={`${isExpanded ? "Hide" : "Show"} lanes`}
      className={`flex h-ctl-xs w-4 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        isExpanded ? "text-fg" : "text-fg-3"
      }`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <CaretRight
        aria-hidden="true"
        weight="bold"
        className={`size-icon-xs transition-transform duration-120 motion-reduce:transition-none ${
          isExpanded ? "rotate-90" : ""
        }`}
      />
    </button>
  );
}

export function LayerDisclosureRow({
  name,
  code,
  clipCount,
  isExpanded,
  gutterBackground,
  columnWidth,
  lanesId,
  onToggleClipExpanded,
  children,
}: {
  /** What this row is called. The active clip's own name when it is alone on the
   *  track; the track itself once it holds several, since naming a shared row
   *  after one of its clips reads as if the rows under it were that clip's. */
  name: string;
  /** The track's kind code (V1, MOT…), when the lanes know it. */
  code?: string;
  clipCount: number;
  isExpanded: boolean;
  gutterBackground: string;
  /** Same adaptive width the lane rows use: a narrowed header column must not
   *  leave this row hanging over the clips it labels. */
  columnWidth: number;
  /** Id of the CANVAS-side element holding the diamond lanes this row's caret
   *  expands (see TimelinePropertyLanes). The caret also reveals the per-lane
   *  control rows in this column, but the diamonds are what following the
   *  reference should land on. */
  lanesId: string;
  onToggleClipExpanded: () => void;
  /** Trailing controls that act on the LAYER (the visibility eye), not on a lane. */
  children?: React.ReactNode;
}) {
  return (
    <div
      className="absolute left-0 top-0 flex items-center gap-[3px] overflow-hidden pr-1.5 pl-1"
      style={{ width: columnWidth, height: TRACK_H, background: gutterBackground }}
    >
      <LaneToggleButton
        name={name}
        isExpanded={isExpanded}
        lanesId={lanesId}
        onToggle={onToggleClipExpanded}
      />
      <TrackCode code={code} />
      <span title={name} className="min-w-0 flex-1 truncate text-xs text-fg-3">
        {name}
      </span>
      <TrackClipCount clipCount={clipCount} />
      {children}
    </div>
  );
}
