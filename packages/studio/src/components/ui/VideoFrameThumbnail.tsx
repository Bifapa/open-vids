import { useState, useEffect } from "react";
import {
  MEDIA_LOAD_SETTLE_TIMEOUT_MS,
  acquireMediaLoad,
  type MediaLoadRelease,
} from "../../utils/mediaLoadGate";

/**
 * Load `src` into a hidden video and capture one frame. Holds `release` until
 * the probe settles. Returns a teardown that aborts the load and frees the slot.
 */
function extractFrame(
  src: string,
  release: MediaLoadRelease,
  onFrame: (dataUrl: string) => void,
  onFailed: (failed: boolean) => void,
): () => void {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "metadata";

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let timeout: number | undefined;
  let done = false;

  // Clearing src fires one more `error` on the video, so the error handler
  // must be detached first — otherwise error → cleanup → error spins forever.
  const cleanup = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timeout);
    video.removeEventListener("error", onError);
    video.src = "";
    video.load();
    release();
  };
  const onError = () => {
    // Ignore the synthetic error cleanup itself just triggered.
    if (!video.getAttribute("src")) return;
    onFailed(true);
    cleanup();
  };

  video.addEventListener("loadedmetadata", () => {
    video.currentTime = Math.min(2, video.duration * 0.1 || 2);
  });

  video.addEventListener("seeked", () => {
    if (!ctx) {
      onFailed(true);
      cleanup();
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    onFrame(canvas.toDataURL("image/jpeg", 0.7));
    cleanup();
  });

  video.addEventListener("error", onError);
  // A stalled load that never settles must not hold its slot forever.
  timeout = window.setTimeout(onError, MEDIA_LOAD_SETTLE_TIMEOUT_MS);
  video.src = src;
  video.load();

  return cleanup;
}

/**
 * Extracts a representative JPEG frame from a video URL using a hidden
 * video + canvas. Seeks to ~10% of duration to avoid black opening frames.
 * Used by AssetThumbnail (assets tab) and RenderQueueItem (renders tab).
 * The hidden video is only created once a media-load slot is granted, and the
 * slot is released as soon as extraction settles (frame, error, timeout, unmount).
 */
export function VideoFrameThumbnail({
  src,
  fallbackLabel,
}: {
  src: string;
  /** Shown instead of an endless shimmer when the video can't be decoded. */
  fallbackLabel?: string;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    const abort = new AbortController();
    let teardown: (() => void) | null = null;

    acquireMediaLoad(abort.signal).then(
      (release) => {
        if (abort.signal.aborted) {
          release();
          return;
        }
        teardown = extractFrame(src, release, setFrame, setFailed);
      },
      () => {
        // Unmounted or src changed while queued — no slot was taken.
      },
    );

    return () => {
      abort.abort();
      teardown?.();
    };
  }, [src]);

  if (failed && !frame) {
    return (
      <div className="w-full h-full bg-neutral-800 flex items-center justify-center">
        <span className="text-[9px] font-medium text-neutral-600">{fallbackLabel ?? "VIDEO"}</span>
      </div>
    );
  }

  if (!frame) {
    return (
      <div className="w-full h-full bg-neutral-800 animate-pulse motion-reduce:animate-none" />
    );
  }

  return <img src={frame} alt="" draggable={false} className="w-full h-full object-contain" />;
}
