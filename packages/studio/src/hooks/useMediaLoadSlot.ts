import { useCallback, useEffect, useRef, useState } from "react";
import {
  MEDIA_LOAD_SETTLE_TIMEOUT_MS,
  acquireMediaLoad,
  type MediaLoadRelease,
} from "../utils/mediaLoadGate";

/**
 * Holds one media-load slot while `enabled`. `granted` flips true once the slot
 * is available — render the media element only then. Call `release` when the
 * element has loaded or failed; unmounting or disabling releases/cancels too.
 * A slot never outlives MEDIA_LOAD_SETTLE_TIMEOUT_MS: a stalled element is
 * dropped (`granted` back to false) so it cannot starve the rest of the queue.
 */
export function useMediaLoadSlot(enabled: boolean): { granted: boolean; release: () => void } {
  const [granted, setGranted] = useState(false);
  const releaseRef = useRef<MediaLoadRelease | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timeout: number | undefined;
    acquireMediaLoad(controller.signal).then(
      (release) => {
        if (controller.signal.aborted) {
          release();
          return;
        }
        // Settling (by the caller or the timeout) must also disarm the timeout,
        // or it would later unmount an element that loaded fine.
        releaseRef.current = () => {
          window.clearTimeout(timeout);
          release();
        };
        timeout = window.setTimeout(() => {
          releaseRef.current?.();
          releaseRef.current = null;
          setGranted(false);
        }, MEDIA_LOAD_SETTLE_TIMEOUT_MS);
        setGranted(true);
      },
      () => {
        // Aborted while queued — nothing was taken.
      },
    );
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
      releaseRef.current?.();
      releaseRef.current = null;
      setGranted(false);
    };
  }, [enabled]);

  const release = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  return { granted, release };
}
