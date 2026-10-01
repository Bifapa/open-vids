import { useEffect, useState } from "react";

/**
 * The current time, re-read every `intervalMs` while `live` is true (a running timer); frozen otherwise, so
 * finished rows and idle chats never re-render on a clock.
 */
export function useNow(live: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [live, intervalMs]);
  return now;
}
