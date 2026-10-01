/**
 * Shared playhead visual used by TimelineCanvas (real playhead) and
 * TimelineEditorNotice (animated illustration): a 1px line with a pentagon
 * head.
 *
 * The line spans the full track height; the HEAD is `position: sticky; top: 0`
 * so it pins to the top of the (vertically) scrolling track area — the ruler is
 * sticky too, so the head stays visible no matter how far the tracks scroll.
 */
import { PLAYHEAD_HEAD_W } from "./timelineLayout";

/** Widest part of the playhead (the head), centred on its line. */
export const PLAYHEAD_VISUAL_W = 13;
const HEAD_H = 16;

interface PlayheadIndicatorProps {
  /** CSS color of the line and head. */
  color?: string;
  /** Whether the playhead is being actively scrubbed — lifts the head. */
  scrubbing?: boolean;
  /**
   * When false, the head chip is rendered in normal flow (top:0) instead of the
   * sticky pin — used by the static illustration where there is no scroll area.
   */
  stickyHead?: boolean;
}

export function PlayheadIndicator({
  color = "var(--color-fg)",
  scrubbing = false,
  stickyHead = true,
}: PlayheadIndicatorProps) {
  return (
    <>
      {/* The line, centred on the wrapper: getTimelinePlayheadLeft shifts the
          wrapper by -PLAYHEAD_HEAD_W/2 so this 1px line lands exactly on the
          ruler ticks' centre x. */}
      <div
        className="absolute top-0 bottom-0"
        style={{
          left: "50%",
          width: 1,
          marginLeft: -0.5,
          background: color,
          boxShadow: "0 0 0 0.5px var(--timeline-playhead-shadow)",
        }}
      />
      <div
        className={stickyHead ? "sticky" : "absolute"}
        style={{
          left: 0,
          top: 0,
          // Zero height keeps it from covering rows (sticky strip trick).
          height: stickyHead ? 0 : undefined,
        }}
      >
        <div
          style={{
            width: PLAYHEAD_VISUAL_W,
            height: HEAD_H,
            marginLeft: (PLAYHEAD_HEAD_W - PLAYHEAD_VISUAL_W) / 2,
            background: color,
            clipPath: "polygon(0 0, 100% 0, 100% 58%, 50% 100%, 0 58%)",
            filter: scrubbing
              ? "drop-shadow(0 1px 2px var(--timeline-playhead-shadow))"
              : undefined,
          }}
        />
      </div>
    </>
  );
}
