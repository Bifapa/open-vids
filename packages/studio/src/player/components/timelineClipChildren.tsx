import { useState, type ReactNode } from "react";
import { usePlayerStore, type TimelineElement } from "../store/playerStore";
import type { TimelineTimeRange } from "../lib/timelineClipIndex";
import type { TrackVisualStyle } from "./timelineIcons";
import type { TimelineClipRenderContext } from "./TimelineTypes";

export function resolveClipRenderContext(
  element: TimelineElement,
  visibleTimeRange: TimelineTimeRange,
  interactive: boolean,
): TimelineClipRenderContext {
  // Interaction only reorders loading; `rich` would swap the frames under the pointer.
  if (interactive) return { priority: "interaction", rich: false };
  const visible =
    element.start < visibleTimeRange.end &&
    element.start + element.duration > visibleTimeRange.start;
  return { priority: visible ? "visible" : "overscan", rich: false };
}

function ClipLintDot({ element }: { element: TimelineElement }) {
  const lint = usePlayerStore((s) => s.lintFindingsByElement.get(element.key ?? element.id));
  if (!lint || lint.count === 0) return null;
  return (
    <span
      className="absolute size-1.5 rounded-full bg-warning"
      style={{ top: 7, right: 7 }}
      title={lint.messages.join("\n")}
    />
  );
}

/**
 * Mounts a clip's content only once the timeline is at rest, then keeps it through later scrolls,
 * so a scroll never blanks a picture already on screen and never mounts a screenful of new ones.
 */
export function ClipContentOnceShown({ hold, children }: { hold: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(!hold);
  if (!shown && !hold) setShown(true);
  return shown ? children : null;
}

export function renderClipChildren(
  element: TimelineElement,
  clipStyle: TrackVisualStyle,
  renderClipContent:
    | ((
        element: TimelineElement,
        style: { clip: string; label: string },
        context: TimelineClipRenderContext,
      ) => ReactNode)
    | undefined,
  renderClipOverlay: ((element: TimelineElement) => ReactNode) | undefined,
  context: TimelineClipRenderContext = { priority: "visible", rich: false },
): ReactNode {
  return (
    <>
      {renderClipOverlay?.(element)}
      {!renderClipContent && <ClipLintDot element={element} />}
      {renderClipContent && (
        // borderRadius: inherit — the clip itself is overflow-visible (keyframe
        // diamonds hang outside its bounds), so the thumbnail layer must clip
        // itself to the clip's rounded corners or sharp corners poke out. It
        // starts under the kind strip (`.has-head`, components.css).
        <div
          className="timeline-clip__body absolute inset-0 overflow-hidden"
          style={{ borderRadius: "inherit" }}
        >
          {renderClipContent(element, clipStyle, context)}
        </div>
      )}
    </>
  );
}
