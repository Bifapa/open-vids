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
 * Keeps a scroller pinned to its newest content while it grows or while its own box changes height (the pinned plan
 * dock above it opening, the composer below it growing), until the user scrolls up; scrolling back to the bottom
 * (or `jumpToLatest`) pins it again. `signal` is anything that changes when content is added or grows.
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

  // A box that gets shorter keeps its scrollTop, so the newest content would slip below the fold with no scroll
  // event to say so: follow the size, not only the content.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollToEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollToEnd]);

  const jumpToLatest = useCallback(() => {
    pinned.current = true;
    setDetached(false);
    scrollToEnd();
  }, [scrollToEnd]);

  return { ref, onScroll, detached, jumpToLatest };
}
