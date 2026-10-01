/**
 * CapCut-style asset preview overlay rendered inside PreviewPane.
 *
 * Shown when the user clicks an asset card that has NOT yet been added to the
 * timeline. Displays the media (image / video / audio) as the prototype's
 * floating preview card over the canvas — the canvas stays visible behind a
 * barely-tinted click-catcher — without modifying the composition (no undo
 * entry, no file mutation) unless the user chooses Insert at Playhead.
 *
 * Dismiss: X button, Escape key, click outside the card, or any playhead
 * activity (starting playback / seeking) — the canvas refocuses.
 * Switching to another not-added asset replaces the current preview.
 */
import { useEffect, useCallback, useRef, useState } from "react";
import { Pause, Play, SpeakerHigh, SpeakerSlash, Waveform, X } from "@phosphor-icons/react";
import { VIDEO_EXT, IMAGE_EXT } from "@hyperframes/core/media-types";
import { Button, IconButton, cn } from "../ui";
import { useAssetPreviewStore } from "../../utils/assetPreviewStore";
import { usePlayerStore } from "../../player/store/playerStore";
import { shouldDismissAssetPreview } from "../../utils/assetPreviewDismiss";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

type AssetKind = "image" | "video" | "audio";

const KIND_LABELS: Record<AssetKind, string> = { image: "Image", video: "Video", audio: "Audio" };

function resolveAssetKind(path: string): AssetKind {
  if (VIDEO_EXT.test(path)) return "video";
  if (IMAGE_EXT.test(path)) return "image";
  return "audio";
}

/** MM:SS(.t) for the preview transport; empty until the media reports a length. */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Play / pause, scrub and mute for the previewed video or audio element. */
function Transport({ media }: { media: HTMLMediaElement }) {
  const [playing, setPlaying] = useState(!media.paused);
  const [time, setTime] = useState(media.currentTime);
  const [duration, setDuration] = useState(media.duration);
  const [muted, setMuted] = useState(media.muted);

  useEffect(() => {
    const sync = () => {
      setPlaying(!media.paused);
      setTime(media.currentTime);
      setDuration(media.duration);
      setMuted(media.muted);
    };
    const events = [
      "play",
      "pause",
      "timeupdate",
      "durationchange",
      "loadedmetadata",
      "volumechange",
      "ended",
    ];
    for (const name of events) media.addEventListener(name, sync);
    sync();
    return () => {
      for (const name of events) media.removeEventListener(name, sync);
    };
  }, [media]);

  const known = Number.isFinite(duration) && duration > 0;
  const fraction = known ? Math.min(1, time / duration) : 0;
  return (
    <div className="flex items-center gap-2 border-t border-border-subtle py-1.5 pr-3 pl-1.5">
      <IconButton
        size="sm"
        aria-label={playing ? "Pause preview" : "Play preview"}
        icon={playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
        onClick={() => {
          if (media.paused) void media.play().catch(() => {});
          else media.pause();
        }}
      />
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(fraction * 1000)}
        disabled={!known}
        aria-label="Scrub preview"
        onChange={(e) => {
          media.currentTime = (Number(e.target.value) / 1000) * duration;
        }}
        style={{ backgroundSize: `${fraction * 100}% 100%` }}
        className={cn(
          "h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-pill bg-surface-3 bg-no-repeat",
          "bg-[linear-gradient(var(--color-fg-2),var(--color-fg-2))]",
          "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-fg",
          "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          "disabled:cursor-not-allowed",
        )}
      />
      <span className="shrink-0 font-mono text-num text-fg-3 tabular-nums">
        {clock(time)} / {known ? clock(duration) : "--:--"}
      </span>
      <IconButton
        size="sm"
        aria-label={muted ? "Unmute preview" : "Mute preview"}
        aria-pressed={!muted}
        icon={muted ? <SpeakerSlash size={14} /> : <SpeakerHigh size={14} />}
        onClick={() => {
          media.muted = !media.muted;
        }}
      />
    </div>
  );
}

/** The media for a previewed asset, chosen by kind, plus its transport and size readout. */
function AssetPreviewMedia({
  kind,
  serveUrl,
  name,
  onMeta,
}: {
  kind: AssetKind;
  serveUrl: string;
  name: string;
  onMeta: (meta: { width: number; height: number; duration: number }) => void;
}) {
  const [media, setMedia] = useState<HTMLMediaElement | null>(null);
  if (kind === "image") {
    return (
      <div className="relative flex aspect-video min-h-0 items-center justify-center overflow-hidden bg-stage">
        <img
          src={serveUrl}
          alt={name}
          className="max-h-full max-w-full object-contain"
          onLoad={(e) =>
            onMeta({
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
              duration: 0,
            })
          }
        />
      </div>
    );
  }
  return (
    <>
      <div className="relative flex aspect-video min-h-0 items-center justify-center overflow-hidden bg-stage">
        {kind === "video" ? (
          <video
            ref={setMedia}
            src={serveUrl}
            autoPlay
            muted
            playsInline
            loop
            className="size-full object-contain"
            onLoadedMetadata={(e) =>
              onMeta({
                width: e.currentTarget.videoWidth,
                height: e.currentTarget.videoHeight,
                duration: e.currentTarget.duration,
              })
            }
          />
        ) : (
          <>
            <Waveform size={40} className="text-wave" aria-hidden="true" />
            <audio
              ref={setMedia}
              src={serveUrl}
              onLoadedMetadata={(e) =>
                onMeta({ width: 0, height: 0, duration: e.currentTarget.duration })
              }
            />
          </>
        )}
      </div>
      {media && <Transport media={media} />}
    </>
  );
}

export function AssetPreviewOverlay() {
  const previewAsset = useAssetPreviewStore((s) => s.previewAsset);
  const previewProjectId = useAssetPreviewStore((s) => s.previewProjectId);
  const previewInsert = useAssetPreviewStore((s) => s.previewInsert);
  const clearPreviewAsset = useAssetPreviewStore((s) => s.clearPreviewAsset);
  const [meta, setMeta] = useState<{ width: number; height: number; duration: number } | null>(
    null,
  );
  const metaFor = useRef<string | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") clearPreviewAsset();
    },
    [clearPreviewAsset],
  );

  useEffect(() => {
    if (!previewAsset) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewAsset, handleKeyDown]);

  // The canvas refocuses on any playhead activity: starting playback or a
  // seek/scrub away from where the playhead sat when the preview opened
  // dismisses it. openedTime is captured per preview open (previewAsset dep),
  // so a stale render can never dismiss against the wrong reference time.
  useEffect(() => {
    if (!previewAsset) return;
    const opened = usePlayerStore.getState();
    const openedTime = opened.currentTime;
    // Level-triggered, not edge-triggered: a preview opened while playback is
    // ALREADY running (the RAF loop bypasses the store) or while a seek is
    // already in flight gets no store change to react to, so evaluate the
    // current state once, through the same shared predicate the subscription
    // uses. openedTime is this snapshot's own currentTime, so the
    // time-diverged branch can't false-positive at open — only the
    // isPlaying / requestedSeekTime branches can fire here.
    if (shouldDismissAssetPreview(openedTime, opened)) {
      clearPreviewAsset();
      return;
    }
    return usePlayerStore.subscribe((state) => {
      if (shouldDismissAssetPreview(openedTime, state)) clearPreviewAsset();
    });
  }, [previewAsset, clearPreviewAsset]);

  if (!previewAsset || !previewProjectId) return null;

  const serveUrl = resolveMediaPreviewUrl(previewAsset, previewProjectId);
  const name = basename(previewAsset);
  const kind = resolveAssetKind(previewAsset);
  // Size and length belong to the asset they were read from, not a previous preview.
  const current = metaFor.current === previewAsset ? meta : null;
  const extension = name.includes(".") ? (name.split(".").pop() ?? "").toUpperCase() : "";
  const facts = [
    extension,
    current && current.width > 0 ? `${current.width} × ${current.height}` : "",
  ].filter(Boolean);
  const length =
    kind !== "image" && current && Number.isFinite(current.duration) && current.duration > 0
      ? clock(current.duration)
      : "";

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-scrim/20"
      onClick={clearPreviewAsset}
      role="dialog"
      aria-label={`Preview: ${name}`}
    >
      {/* Floating preview card — compact, canvas stays visible around it */}
      <div
        className="flex max-h-[calc(100%-24px)] w-[min(420px,calc(100%-32px))] flex-col overflow-hidden rounded-lg border border-border bg-bg-1 text-sm text-fg shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-head shrink-0 items-center gap-1.5 border-b border-border-subtle pr-1 pl-3 select-none">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={previewAsset}>
            {name}
          </h3>
          <span className="shrink-0 text-xs whitespace-nowrap text-fg-3 tabular-nums">
            {KIND_LABELS[kind]}
            {length && ` · ${length}`}
          </span>
          <IconButton
            size="sm"
            aria-label="Close preview"
            title="Close (Esc)"
            icon={<X size={14} />}
            onClick={(e) => {
              e.stopPropagation();
              clearPreviewAsset();
            }}
          />
        </header>

        <AssetPreviewMedia
          key={previewAsset}
          kind={kind}
          serveUrl={serveUrl}
          name={name}
          onMeta={(next) => {
            metaFor.current = previewAsset;
            setMeta(next);
          }}
        />

        <footer className="flex min-h-11 shrink-0 items-center gap-1.5 border-t border-border-subtle py-2 pr-2.5 pl-3">
          <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{facts.join(" · ")}</span>
          {previewInsert && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                previewInsert(previewAsset);
                clearPreviewAsset();
              }}
            >
              Insert at Playhead
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
