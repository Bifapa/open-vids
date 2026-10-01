/**
 * AssetCard and FontRow — the Media panel's asset tile / row components.
 * Extracted from AssetsTab.tsx to keep that file under the 600-line CI gate.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { FilmStrip, Image } from "@phosphor-icons/react";
import { VideoFrameThumbnail } from "../ui/VideoFrameThumbnail";
import { Badge, cn } from "../ui";
import { VIDEO_EXT, IMAGE_EXT } from "@hyperframes/core/media-types";
import { TIMELINE_ASSET_MIME } from "../../utils/timelineAssetDrop";
import { ContextMenu } from "./AssetContextMenu";
import { usePlayerStore } from "../../player/store/playerStore";
import { timelineClipFocusId } from "../../player/components/timelineNavigationIdentity";
import { useAssetPreviewStore } from "../../utils/assetPreviewStore";
import { findClipForAsset, isPointerClick } from "../../utils/assetClickBehavior";
import {
  ASSET_ITEM_CLASS,
  ASSET_NAME_CLASS,
  ASSET_THUMB_CLASS,
  basename,
  ext,
  filename,
  formatDuration,
  type CopyFeedback,
} from "./assetHelpers";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";
import {
  MEDIA_LOAD_SETTLE_TIMEOUT_MS,
  acquireMediaLoad,
  type MediaLoadRelease,
} from "../../utils/mediaLoadGate";

/** Drag payload writer shared by the asset tile and the font row: copy effect
 *  plus the timeline-asset MIME and a plain-text path fallback. */
export function writeAssetDragData(e: React.DragEvent, asset: string): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(TIMELINE_ASSET_MIME, JSON.stringify({ path: asset }));
  e.dataTransfer.setData("text/plain", asset);
}

/** Copy-path outcome chip. Copying is a context-menu action, so this is pure
 *  feedback — it renders only once a copy has succeeded or failed, and never
 *  as an idle affordance for something the tile itself does not do. */
export function CopyChip({ feedback, asset }: { feedback: CopyFeedback; asset: string }) {
  if (feedback?.path !== asset) return null;
  return (
    <Badge role="status" size="sm" tone={feedback.ok ? "success" : "error"}>
      {feedback.ok ? "Copied" : "Copy failed"}
    </Badge>
  );
}

/** The "in use" mark of a row: a quiet dot, named for assistive tech. */
export function UsedDot() {
  return (
    <span title="In use" className="inline-flex shrink-0">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-fg-3" />
      <span className="sr-only">In use</span>
    </span>
  );
}

/** Open the row/tile context menu at the pointer, shared by asset tile + font row. */
export function openAssetContextMenu(
  e: React.MouseEvent,
  setContextMenu: (menu: { x: number; y: number }) => void,
): void {
  e.preventDefault();
  setContextMenu({ x: e.clientX, y: e.clientY });
}

/**
 * Lazily probe a video/audio URL for its duration via a hidden HTMLVideoElement
 * (`preload="metadata"`). The manifest only covers ~/.media assets, so project
 * assets in assets/ have no manifest entry — this fills the gap.
 * Returns `undefined` until the probe completes; `null` if it failed.
 */
function useProbedDuration(src: string, skip: boolean): number | null | undefined {
  const [duration, setDuration] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    const abort = new AbortController();
    // The in-flight probe element, so unmount cleanup can abort its network
    // fetch (clearing `src`) instead of leaving it to finish in the background.
    let liveVid: HTMLVideoElement | null = null;
    // The media-load slot held by the in-flight probe; freed when it settles.
    let releaseSlot: MediaLoadRelease | null = null;
    let settleTimer: number | undefined;

    function teardown(vid: HTMLVideoElement) {
      window.clearTimeout(settleTimer);
      vid.onloadedmetadata = null;
      vid.onerror = null;
      vid.src = "";
      releaseSlot?.();
      releaseSlot = null;
    }

    function probe(attempt: number) {
      if (cancelled) return;
      acquireMediaLoad(abort.signal).then(
        (release) => {
          if (cancelled) {
            release();
            return;
          }
          releaseSlot = release;
          const vid = document.createElement("video");
          liveVid = vid;
          vid.preload = "metadata";
          vid.muted = true;
          vid.onloadedmetadata = () => {
            const d = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : null;
            teardown(vid);
            if (!cancelled) setDuration(d);
          };
          vid.onerror = () => {
            teardown(vid);
            if (!cancelled) {
              if (attempt < 1) retryTimer = window.setTimeout(() => probe(attempt + 1), 50);
              else setDuration(null);
            }
          };
          // A stalled probe must not hold its slot forever.
          settleTimer = window.setTimeout(() => {
            teardown(vid);
            if (!cancelled) setDuration(null);
          }, MEDIA_LOAD_SETTLE_TIMEOUT_MS);
          vid.src = src;
        },
        () => {
          // Unmounted while queued — no slot was taken.
        },
      );
    }

    probe(0);
    return () => {
      cancelled = true;
      abort.abort();
      window.clearTimeout(retryTimer);
      if (liveVid) teardown(liveVid);
    };
  }, [src, skip]);
  return duration;
}

/**
 * Reveal the asset's clip when it is already on the timeline, otherwise open the
 * preview overlay. Shared by every asset tile/row so pointer and keyboard
 * activation do the same thing however the asset is operated.
 */
export function useAssetActivation(
  asset: string,
  projectId: string,
  used: boolean,
  onAddAssetToTimeline?: (path: string) => void,
) {
  const setSelectedElementId = usePlayerStore((s) => s.setSelectedElementId);
  const requestTimelineFocus = usePlayerStore((s) => s.requestTimelineFocus);
  const elements = usePlayerStore((s) => s.elements);
  const setPreviewAsset = useAssetPreviewStore((s) => s.setPreviewAsset);
  const clearPreviewAsset = useAssetPreviewStore((s) => s.clearPreviewAsset);
  // Drag-threshold click gate: track pointer-down position so we can ignore
  // pointer-up events that followed a real drag gesture.
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  const activate = useCallback(() => {
    if (used) {
      const clip = findClipForAsset(elements, asset);
      if (clip) {
        // Dismiss any open preview overlay (from another asset) — the reveal
        // must not leave a stale preview card floating over the canvas.
        clearPreviewAsset();
        const clipKey = clip.key ?? clip.id;
        setSelectedElementId(clipKey);
        // Scroll the timeline so the selected clip is actually visible.
        requestTimelineFocus(timelineClipFocusId(clipKey));
        return;
      }
    }
    // Not added (or no matching clip found) → preview overlay
    setPreviewAsset(asset, projectId, onAddAssetToTimeline);
  }, [
    used,
    elements,
    asset,
    projectId,
    onAddAssetToTimeline,
    setSelectedElementId,
    requestTimelineFocus,
    setPreviewAsset,
    clearPreviewAsset,
  ]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const origin = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!origin) return;
      // A press on an inner control (the audio play button) is that control's.
      if (
        e.target instanceof Element &&
        e.target !== e.currentTarget &&
        e.target.closest("button")
      ) {
        return;
      }
      if (!isPointerClick(e.clientX - origin.x, e.clientY - origin.y)) return;
      activate();
    },
    [activate],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Only when the item itself is focused — keydowns bubbling from inner
      // controls (the play button) keep their native activation.
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    },
    [activate],
  );

  return { onPointerDown, onPointerUp, onKeyDown };
}

export type AssetLayout = "grid" | "list";

export interface AssetCardProps {
  projectId: string;
  asset: string;
  used: boolean;
  duration?: number;
  /** `grid` tiles (default) or `list` rows. */
  layout?: AssetLayout;
  onCopy: (path: string) => void;
  copyFeedback: CopyFeedback;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newPath: string) => void;
  onAddAssetToTimeline?: (path: string) => void;
}

/** Image / first frame of the asset, with the hover playback of a video. */
function ThumbMedia({
  serveUrl,
  name,
  isImage,
  isVideo,
  hovered,
}: {
  serveUrl: string;
  name: string;
  isImage: boolean;
  isVideo: boolean;
  hovered: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  if (isImage && !imgError) {
    return (
      <img
        src={serveUrl}
        alt={name}
        loading="lazy"
        draggable={false}
        className="absolute inset-0 size-full object-cover"
        onError={() => setImgError(true)}
      />
    );
  }
  if (isVideo) {
    return (
      <>
        <VideoFrameThumbnail src={serveUrl} />
        {hovered && (
          <video
            src={serveUrl}
            autoPlay
            muted
            loop
            playsInline
            className="absolute inset-0 size-full object-cover"
          />
        )}
      </>
    );
  }
  return null;
}

/**
 * Thumbnail tile (grid) or row (list) for images and video assets.
 *
 * Click behaviour (CapCut-style):
 *   - Already added  → selects the clip on the timeline (setSelectedElementId).
 *   - Not yet added  → opens the asset preview overlay over the canvas.
 * Drag behaviour is preserved: a pointer movement exceeding DRAG_THRESHOLD_PX
 * before pointerup is treated as drag-start, not a click.
 */
export function AssetCard({
  projectId,
  asset,
  used,
  duration,
  layout = "grid",
  onCopy,
  copyFeedback,
  onDelete,
  onRename,
  onAddAssetToTimeline,
}: AssetCardProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const isCopied = copyFeedback?.path === asset && copyFeedback.ok;
  const fullName = filename(asset);
  const name = basename(asset);
  const serveUrl = resolveMediaPreviewUrl(asset, projectId);
  const isVideo = VIDEO_EXT.test(asset);
  const isImage = IMAGE_EXT.test(asset);
  const probedDuration = useProbedDuration(serveUrl, !isVideo || duration != null);
  const durationLabel = isVideo ? formatDuration(duration ?? probedDuration ?? 0) : "";
  const activation = useAssetActivation(asset, projectId, used, onAddAssetToTimeline);
  const KindIcon = isVideo ? FilmStrip : Image;
  const media = (
    <ThumbMedia
      serveUrl={serveUrl}
      name={name}
      isImage={isImage}
      isVideo={isVideo}
      hovered={hovered}
    />
  );
  const fallback = !isImage && !isVideo && (
    <span className="absolute inset-0 flex items-center justify-center text-2xs font-medium text-fg-3">
      {ext(asset)}
    </span>
  );

  return (
    <>
      <div
        draggable
        role="button"
        tabIndex={0}
        title={fullName}
        aria-label={`${name} — open, drag to timeline, right-click for actions`}
        {...activation}
        onDragStart={(e) => writeAssetDragData(e, asset)}
        onContextMenu={(e) => openAssetContextMenu(e, setContextMenu)}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        className={cn(
          ASSET_ITEM_CLASS,
          "min-w-0 cursor-grab active:cursor-grabbing",
          layout === "grid"
            ? "flex flex-col gap-1 px-[3px] pt-[3px] pb-1"
            : "flex h-row items-center gap-2 pr-1.5 pl-1",
          isCopied && "border-accent-line bg-accent-soft",
        )}
      >
        {layout === "grid" ? (
          <>
            <div className={ASSET_THUMB_CLASS}>
              {media}
              {fallback}
              <span
                aria-hidden="true"
                className="absolute bottom-[3px] left-[3px] flex h-3.5 w-4 items-center justify-center rounded-xs bg-on-media-bg text-on-media-2"
              >
                <KindIcon size={10} />
              </span>
              {durationLabel && (
                <span className="absolute right-[3px] bottom-[3px] rounded-xs bg-on-media-bg px-1 text-2xs leading-[13px] font-medium text-on-media tabular-nums">
                  {durationLabel}
                </span>
              )}
              {used && (
                <span
                  title="In use"
                  className="absolute top-[5px] right-[5px] size-1.5 rounded-full bg-on-media shadow-[0_0_0_1.5px_var(--color-on-media-bg)]"
                >
                  <span className="sr-only">In use</span>
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <span className={cn(ASSET_NAME_CLASS, "flex-1 px-px text-xs")}>{fullName}</span>
              <CopyChip feedback={copyFeedback} asset={asset} />
            </div>
          </>
        ) : (
          <>
            <div className={cn(ASSET_THUMB_CLASS, "w-11 shrink-0")}>
              {media}
              {fallback}
            </div>
            <KindIcon size={12} aria-hidden="true" className="shrink-0 text-fg-3" />
            <span className={cn(ASSET_NAME_CLASS, "flex-1 text-base")}>{fullName}</span>
            {used && <UsedDot />}
            <CopyChip feedback={copyFeedback} asset={asset} />
            <span className="shrink-0 text-xs text-fg-3 tabular-nums">{durationLabel || "—"}</span>
          </>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          asset={asset}
          onClose={() => setContextMenu(null)}
          onCopy={onCopy}
          onDelete={onDelete}
          onRename={onRename}
          onAddAtPlayhead={onAddAssetToTimeline}
        />
      )}
    </>
  );
}

export interface FontRowProps {
  asset: string;
  used: boolean;
  onCopy: (path: string) => void;
  copyFeedback: CopyFeedback;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newPath: string) => void;
  onAddAssetToTimeline?: (path: string) => void;
}

/**
 * Compact row for font assets: the format chip, the family name, and whether the
 * composition uses it. Clicking copies the path.
 */
export function FontRow({
  asset,
  used,
  onCopy,
  copyFeedback,
  onDelete,
  onRename,
  onAddAssetToTimeline,
}: FontRowProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const name = basename(asset);
  const isCopied = copyFeedback?.path === asset && copyFeedback.ok;

  return (
    <>
      <div
        draggable
        role="button"
        tabIndex={0}
        title={filename(asset)}
        aria-label={`${name} — copy path, drag to timeline, right-click for actions`}
        onClick={() => onCopy(asset)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCopy(asset);
          }
        }}
        onDragStart={(e) => writeAssetDragData(e, asset)}
        onContextMenu={(e) => openAssetContextMenu(e, setContextMenu)}
        className={cn(
          ASSET_ITEM_CLASS,
          "flex h-row min-w-0 cursor-pointer items-center gap-2 pr-1.5 pl-1",
          isCopied && "border-accent-line bg-accent-soft",
        )}
      >
        <span className="inline-flex h-[18px] min-w-10 shrink-0 items-center justify-center rounded-xs border border-border px-1 font-mono text-2xs leading-none font-semibold text-fg-3">
          {ext(asset)}
        </span>
        <span className={cn(ASSET_NAME_CLASS, "flex-1 text-base")}>{name}</span>
        <CopyChip feedback={copyFeedback} asset={asset} />
        <span className="shrink-0 text-xs text-fg-3">{used ? "In use" : "Unused"}</span>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          asset={asset}
          onClose={() => setContextMenu(null)}
          onCopy={onCopy}
          onDelete={onDelete}
          onRename={onRename}
          onAddAtPlayhead={onAddAssetToTimeline}
        />
      )}
    </>
  );
}
