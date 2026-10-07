import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readOpenvidsHomeOrigin } from "../utils/openvidsHost";
import {
  activateTab,
  closeTab,
  fetchTabs,
  forkTab,
  OPENVIDS_TABS_CHANGED_EVENT,
  readOpenvidsTabKey,
  sameTabsSnapshot,
  type ForkTabResult,
  type TabsSnapshot,
} from "../utils/openvidsTabs";

/** Safety net behind the shell's push: how often a visible page re-reads the tab list. */
export const TABS_SAFETY_POLL_MS = 10_000;

export interface ProjectTabs {
  /** This page's own tab key (`openvidsTab`). */
  ownKey: string;
  snapshot: TabsSnapshot;
  /** Bring a tab (`"home"` or a project key) to the front. */
  activate: (key: string) => void;
  /** Close a project tab; one request at a time, answered only after the user settles the shell's dialog. */
  close: (key: string) => void;
  /** The tab whose close request is waiting on the shell, if any. */
  closingKey: string | null;
  /**
   * Fork an open project tab: the shell starts the copy and switches to the Projects page, which shows its
   * progress. One request at a time; null when this one was ignored (another is in flight).
   */
  fork: (key: string) => Promise<ForkTabResult | null>;
  /** The tab whose fork request is waiting on the shell, if any. */
  forkingKey: string | null;
}

interface TabsGate {
  homeOrigin: string;
  ownKey: string;
}

/** Everything the strip needs from the URL: a valid home origin and this page's tab key. */
function readTabsGate(): TabsGate | null {
  const homeOrigin = readOpenvidsHomeOrigin();
  const ownKey = readOpenvidsTabKey();
  return homeOrigin && ownKey ? { homeOrigin, ownKey } : null;
}

const pageIsVisible = () => document.visibilityState === "visible";

/**
 * The project tab strip's data, read from the shell's home server. Null while the strip must draw nothing:
 * the page is outside the desktop or has no tab key, or the shell has not answered yet. The list is re-read
 * when the shell pushes `openvids-tabs-changed`, when the page becomes visible or focused, and every 10 s
 * while visible (never while hidden); a read never overlaps another, and a change that lands mid-read is
 * read again after it.
 */
export function useProjectTabs(): ProjectTabs | null {
  const gate = useMemo(readTabsGate, []);
  const [snapshot, setSnapshot] = useState<TabsSnapshot | null>(null);
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [forkingKey, setForkingKey] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const closingRef = useRef(false);
  const forkingRef = useRef(false);

  useEffect(() => {
    if (!gate) return;
    const { homeOrigin } = gate;
    let disposed = false;
    let reading = false;
    let readAgain = false;
    let stopTimer: (() => void) | null = null;

    const refresh = () => {
      if (disposed) return;
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      void fetchTabs(homeOrigin).then((next) => {
        reading = false;
        if (disposed) return;
        // A failed read keeps what the strip showed; the next trigger tries again.
        if (next) setSnapshot((prev) => (prev && sameTabsSnapshot(prev, next) ? prev : next));
        if (readAgain) {
          readAgain = false;
          refresh();
        }
      });
    };
    const startPolling = () => {
      if (stopTimer) return;
      const timer = setInterval(refresh, TABS_SAFETY_POLL_MS);
      stopTimer = () => clearInterval(timer);
    };
    const stopPolling = () => {
      stopTimer?.();
      stopTimer = null;
    };
    // A hidden page reads again as soon as it is shown (`visibilitychange`), so a push or a focus that
    // reaches it hidden has nothing to do.
    const refreshIfVisible = () => {
      if (pageIsVisible()) refresh();
    };
    const onVisibilityChange = () => {
      if (pageIsVisible()) {
        refresh();
        startPolling();
      } else {
        stopPolling();
      }
    };

    refreshRef.current = refresh;
    window.addEventListener(OPENVIDS_TABS_CHANGED_EVENT, refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (pageIsVisible()) {
      refresh();
      startPolling();
    }
    return () => {
      disposed = true;
      refreshRef.current = () => {};
      stopPolling();
      window.removeEventListener(OPENVIDS_TABS_CHANGED_EVENT, refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [gate]);

  const activate = useCallback(
    (key: string) => {
      if (!gate) return;
      // The shell refuses an unknown or still-opening tab: read the list again to show what it is now.
      void activateTab(gate.homeOrigin, key).then((switched) => {
        if (!switched) refreshRef.current();
      });
    },
    [gate],
  );

  const close = useCallback(
    (key: string) => {
      if (!gate || closingRef.current) return;
      closingRef.current = true;
      setClosingKey(key);
      void closeTab(gate.homeOrigin, key).then(() => {
        closingRef.current = false;
        setClosingKey(null);
        refreshRef.current();
      });
    },
    [gate],
  );

  const fork = useCallback(
    async (key: string): Promise<ForkTabResult | null> => {
      if (!gate || forkingRef.current) return null;
      forkingRef.current = true;
      setForkingKey(key);
      try {
        return await forkTab(gate.homeOrigin, key);
      } finally {
        forkingRef.current = false;
        setForkingKey(null);
      }
    },
    [gate],
  );

  if (!gate || !snapshot) return null;
  return { ownKey: gate.ownKey, snapshot, activate, close, closingKey, fork, forkingKey };
}
