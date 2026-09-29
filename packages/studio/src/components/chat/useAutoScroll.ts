import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

const NEAR_BOTTOM_PX = 48;

export interface AutoScroll {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** True once the user has scrolled away from the newest content. */
  detached: boolean;
  jumpToLatest: () => void;
}

/**
 * Keeps a scroller pinned to its newest content while it grows, until the user scrolls up;
 * scrolling back to the bottom (or `jumpToLatest`) pins it again. `signal` is anything that
 * changes when content is added or grows.
 */
export function useAutoScroll(signal: unknown): AutoScroll {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [detached, setDetached] = useState(false);

  const scrollToEnd = useCallback(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = distance <= NEAR_BOTTOM_PX;
    pinned.current = nearBottom;
    setDetached(!nearBottom);
  }, []);

  useLayoutEffect(() => {
    if (pinned.current) scrollToEnd();
  }, [signal, scrollToEnd]);

  const jumpToLatest = useCallback(() => {
    pinned.current = true;
    setDetached(false);
    scrollToEnd();
  }, [scrollToEnd]);

  return { ref, onScroll, detached, jumpToLatest };
}
