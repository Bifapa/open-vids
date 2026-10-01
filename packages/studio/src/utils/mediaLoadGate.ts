/**
 * Process-wide cap on hidden media elements loading at once.
 *
 * WebKit opens one AVURLAsset (GPU-process byte stream) for every media
 * element with a live `src`. Panels that mount a probe per card (Assets,
 * Renders, Catalog) used to open dozens at the same time, and tearing players
 * down mid-load could deadlock the WebContent process. Every probe that
 * creates a hidden `<video>`/`<audio>` therefore takes a slot here first,
 * creates the element only once the slot is granted, and releases the slot
 * when the probe settles (metadata / frame / error / timeout / unmount).
 */

export const MAX_CONCURRENT_MEDIA_ELEMENT_LOADS = 3;

/**
 * Upper bound on how long one probe may hold a slot. A load that never fires
 * loadedmetadata/error must not starve every other probe.
 */
export const MEDIA_LOAD_SETTLE_TIMEOUT_MS = 15_000;

/** Frees the slot. Safe to call any number of times. */
export type MediaLoadRelease = () => void;

interface Waiter {
  grant: (release: MediaLoadRelease) => void;
}

let inFlight = 0;
const queue: Waiter[] = [];

function createAbortError(): Error {
  const error = new Error("Media load acquisition aborted");
  error.name = "AbortError";
  return error;
}

function createRelease(): MediaLoadRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight--;
    drain();
  };
}

function drain(): void {
  while (inFlight < MAX_CONCURRENT_MEDIA_ELEMENT_LOADS) {
    const waiter = queue.shift();
    if (!waiter) return;
    inFlight++;
    waiter.grant(createRelease());
  }
}

/**
 * Wait for a free media-load slot (FIFO). Resolves with the slot's release
 * function. Aborting `signal` while still queued rejects with an `AbortError`
 * and the waiter never takes a slot; aborting after the grant has no effect —
 * the holder owns the release.
 */
export function acquireMediaLoad(signal?: AbortSignal): Promise<MediaLoadRelease> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise<MediaLoadRelease>((resolve, reject) => {
    const waiter: Waiter = {
      grant: (release) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      },
    };
    const onAbort = () => {
      const index = queue.indexOf(waiter);
      if (index === -1) return;
      queue.splice(index, 1);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(waiter);
    drain();
  });
}
