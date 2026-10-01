import { buildProjectApiPath } from "../../utils/projectRouting";
import { DownloadSimple, Plus } from "@phosphor-icons/react";
import { formatNumber, useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  buildCompositionThumbnailUrl,
  resolveThumbnailSeekTime,
  THUMBNAIL_SEEK_TIME_SECONDS,
} from "../../player/components/CompositionThumbnail";
import { setPreviewMediaMuted } from "../../player/lib/timelineIframeHelpers";
import { usePlayerStore } from "../../player/store/playerStore";
import { thumbnailRevisionOf } from "../../player/store/thumbnailSlice";
import { encodePreviewPath } from "../../player/components/thumbnailUtils";
import { TIMELINE_COMPOSITION_MIME } from "../../utils/timelineCompositionDrop";
import { Tooltip } from "../ui/Tooltip";

interface CompositionsTabProps {
  projectId: string;
  compositions: string[];
  activeComposition: string | null;
  /** The project's root composition (same value App.tsx auto-opens on load), or null if none. */
  masterCompositionPath?: string | null;
  onSelect: (comp: string) => void;
  onRenderComposition?: (comp: string) => void;
  onAddToTimeline?: (comp: string) => void;
  isRendering?: boolean;
  lintFindingsByFile?: Map<string, { count: number; messages: string[] }>;
}

const DEFAULT_PREVIEW_STAGE = { width: 1920, height: 1080 };
const CARD_W = 64;
const CARD_H = 36;
const THUMBNAIL_PLAYBACK_SYNC_ATTEMPTS = 10;

type PreviewWindow = Window & {
  __player?: {
    play?: () => void;
    pause?: () => void;
    seek?: (time: number) => void;
    getDuration?: () => number;
  };
};

export function resolveCompositionPreviewScale(input: {
  cardWidth: number;
  cardHeight: number;
  stageWidth: number;
  stageHeight: number;
}): number {
  const safeStageWidth =
    Number.isFinite(input.stageWidth) && input.stageWidth > 0
      ? input.stageWidth
      : DEFAULT_PREVIEW_STAGE.width;
  const safeStageHeight =
    Number.isFinite(input.stageHeight) && input.stageHeight > 0
      ? input.stageHeight
      : DEFAULT_PREVIEW_STAGE.height;
  const scaleX = input.cardWidth / safeStageWidth;
  const scaleY = input.cardHeight / safeStageHeight;
  return Math.min(scaleX, scaleY);
}

function compositionPreviewUrl(projectId: string, comp: string): string {
  return buildProjectApiPath(projectId, `/preview/comp/${encodePreviewPath(comp)}`);
}

export function compositionCardThumbnailUrl(
  projectId: string,
  comp: string,
  contentRevision: number,
): string {
  return buildCompositionThumbnailUrl({
    previewUrl: compositionPreviewUrl(projectId, comp),
    seekTime: THUMBNAIL_SEEK_TIME_SECONDS,
    duration: 0,
    origin: window.location.origin,
    contentRevision,
  });
}

function parsePositiveNumber(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveIframeDuration(iframe: HTMLIFrameElement | null): number | null {
  try {
    const win = iframe?.contentWindow as PreviewWindow | null;
    const playerDuration = win?.__player?.getDuration?.();
    if (Number.isFinite(playerDuration) && playerDuration != null && playerDuration > 0) {
      return playerDuration;
    }
  } catch {
    /* cross-origin iframe */
  }

  try {
    const doc = iframe?.contentDocument;
    const root = doc?.querySelector("[data-composition-id]") ?? doc?.documentElement ?? null;
    return (
      parsePositiveNumber(root?.getAttribute("data-composition-duration") ?? null) ??
      parsePositiveNumber(root?.getAttribute("data-duration") ?? null)
    );
  } catch {
    return null;
  }
}

export function syncIframePlayback(iframe: HTMLIFrameElement | null, shouldPlay: boolean): boolean {
  try {
    const player = (iframe?.contentWindow as PreviewWindow | null)?.__player;
    if (!player) return false;

    if (shouldPlay) {
      setPreviewMediaMuted(iframe, true);
      player.play?.();
      return true;
    }

    player.pause?.();
    player.seek?.(resolveThumbnailSeekTime(resolveIframeDuration(iframe)));
    return true;
  } catch {
    return false;
  }
}

function CompCard({
  projectId,
  comp,
  isActive,
  isRoot,
  onSelect,
  onRender,
  isRendering,
  lintInfo,
  onAddToTimeline,
  contentRevision,
  previewBooted,
}: {
  projectId: string;
  comp: string;
  isActive: boolean;
  isRoot: boolean;
  onSelect: () => void;
  onRender?: () => void;
  isRendering?: boolean;
  lintInfo?: { count: number; messages: string[] };
  onAddToTimeline?: () => void;
  contentRevision: number;
  previewBooted: boolean;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [stageSize, setStageSize] = useState(DEFAULT_PREVIEW_STAGE);
  const [livePreviewLoaded, setLivePreviewLoaded] = useState(false);
  const [failedThumbnailUrl, setFailedThumbnailUrl] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggedRef = useRef(false);

  const requestIframePlaybackSync = useCallback((shouldPlay: boolean) => {
    if (syncTimer.current) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }

    const sync = (remainingAttempts: number) => {
      if (syncIframePlayback(iframeRef.current, shouldPlay) || remainingAttempts <= 0) return;

      syncTimer.current = setTimeout(() => sync(remainingAttempts - 1), 100);
    };

    sync(THUMBNAIL_PLAYBACK_SYNC_ATTEMPTS);
  }, []);

  const handleEnter = () => {
    hoverTimer.current = setTimeout(() => setHovered(true), 300);
  };
  const handleLeave = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (syncTimer.current) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }
    setHovered(false);
    setLivePreviewLoaded(false);
  };
  const name = comp.replace(/^compositions\//, "").replace(/\.html$/, "");
  const renderLabel = isRendering
    ? t("sidebar.compositions.renderBusy")
    : t("sidebar.compositions.render", { name });
  const previewUrl = compositionPreviewUrl(projectId, comp);
  const thumbnailUrl = compositionCardThumbnailUrl(projectId, comp, contentRevision);
  const thumbnailFailed = failedThumbnailUrl === thumbnailUrl;
  const previewScale = resolveCompositionPreviewScale({
    cardWidth: CARD_W,
    cardHeight: CARD_H,
    stageWidth: stageSize.width,
    stageHeight: stageSize.height,
  });
  const thumbnailOffsetX = (CARD_W - stageSize.width * previewScale) / 2;
  const thumbnailOffsetY = (CARD_H - stageSize.height * previewScale) / 2;

  useEffect(() => {
    if (hovered) requestIframePlaybackSync(true);
  }, [hovered, requestIframePlaybackSync]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, []);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      aria-label={t("sidebar.compositions.open", { name })}
      aria-pressed={isActive}
      onDragStart={(event) => {
        draggedRef.current = true;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(TIMELINE_COMPOSITION_MIME, JSON.stringify({ sourcePath: comp }));
      }}
      onDragEnd={() => {
        window.setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }}
      onClick={() => {
        if (!draggedRef.current) onSelect();
      }}
      onKeyDown={(event) => {
        // Only when the row itself is focused — keydowns bubbling from the
        // inner controls (play button) must keep their native activation.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      onPointerEnter={handleEnter}
      onPointerLeave={handleLeave}
      className={cn(
        "group/card relative flex min-h-row-lg w-full cursor-grab select-none items-center gap-2 rounded-md border px-1 py-[3px] text-left transition-colors duration-hover active:cursor-grabbing",
        "outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
        isActive ? "border-accent-line bg-accent-soft" : "border-transparent hover:bg-surface-1",
      )}
    >
      <div className="relative h-9 w-16 shrink-0 overflow-hidden rounded-xs bg-bg-1 shadow-[inset_0_0_0_1px_var(--color-border-subtle)]">
        {thumbnailFailed ? (
          <div className="absolute inset-0 flex items-center justify-center px-1 text-center text-2xs leading-tight text-fg-3">
            {t("sidebar.compositions.previewUnavailable")}
          </div>
        ) : !previewBooted ? null : (
          <img
            src={thumbnailUrl}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            onError={() => setFailedThumbnailUrl(thumbnailUrl)}
            className={`absolute inset-0 h-full w-full object-contain transition-opacity ${
              livePreviewLoaded ? "opacity-0" : "opacity-100"
            }`}
          />
        )}
        {hovered && (
          <iframe
            ref={iframeRef}
            src={previewUrl}
            sandbox="allow-scripts allow-same-origin"
            className="absolute border-none pointer-events-none"
            style={{
              transformOrigin: "0 0",
              width: stageSize.width,
              height: stageSize.height,
              left: thumbnailOffsetX,
              top: thumbnailOffsetY,
              transform: `scale(${previewScale})`,
            }}
            onLoad={(e) => {
              try {
                const iframe = e.currentTarget;
                const root = iframe.contentDocument?.querySelector("[data-composition-id]");
                const width =
                  Number(root?.getAttribute("data-width")) || DEFAULT_PREVIEW_STAGE.width;
                const height =
                  Number(root?.getAttribute("data-height")) || DEFAULT_PREVIEW_STAGE.height;
                setStageSize({ width, height });
                setLivePreviewLoaded(true);
                requestIframePlaybackSync(true);
              } catch {
                setStageSize(DEFAULT_PREVIEW_STAGE);
              }
            }}
            title={t("sidebar.compositions.previewTitle", { name })}
            tabIndex={-1}
          />
        )}
      </div>
      <div
        className="grid min-w-0 flex-1 gap-0.5"
        title={lintInfo && lintInfo.count > 0 ? lintInfo.messages.join("\n") : undefined}
      >
        <div className="flex min-w-0 items-center gap-[5px] text-base font-medium text-fg">
          <span className="min-w-0 truncate">{name}</span>
          {isRoot && (
            <span
              aria-label={t("sidebar.compositions.rootHint")}
              title={t("sidebar.compositions.rootHint")}
              className="inline-flex h-[15px] shrink-0 items-center rounded-xs bg-surface-3 px-1 text-2xs font-semibold text-fg-2"
            >
              {t("sidebar.compositions.root")}
            </span>
          )}
          {lintInfo && lintInfo.count > 0 && (
            <span
              aria-label={t("sidebar.compositions.lintCount", { count: lintInfo.count })}
              className="inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-pill bg-warning-soft px-1 text-2xs font-semibold tabular-nums text-warning"
            >
              {formatNumber(lintInfo.count)}
            </span>
          )}
        </div>
        <span className="block truncate text-xs text-fg-3">{comp}</span>
      </div>
      {(onAddToTimeline || onRender) && (
        // The prototype's `.cc-acts`: hover/focus actions on a raised chip at the row's end.
        <div
          className={cn(
            "absolute right-1 top-1/2 hidden -translate-y-1/2 gap-0.5 rounded-sm p-0.5 group-hover/card:flex group-focus-within/card:flex",
            isActive
              ? "bg-surface-2"
              : "bg-surface-2 shadow-[-8px_0_8px_-4px_var(--color-surface-1)]",
          )}
        >
          {onAddToTimeline && (
            <Tooltip label={t("sidebar.compositions.addTooltip")}>
              <button
                type="button"
                aria-label={t("sidebar.compositions.addLabel", { name })}
                onClick={(event) => {
                  event.stopPropagation();
                  onAddToTimeline();
                }}
                className="flex h-6 w-6 items-center justify-center rounded-sm text-fg-2 transition-colors duration-hover hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                <Plus size={14} aria-hidden />
              </button>
            </Tooltip>
          )}
          {onRender && (
            <Tooltip label={renderLabel}>
              <button
                type="button"
                aria-label={renderLabel}
                disabled={isRendering}
                onClick={(e) => {
                  e.stopPropagation();
                  onRender();
                }}
                // h-6 w-6 = the 24x24 WCAG 2.2 (2.5.8) minimum target around the 14px glyph.
                className="flex h-6 w-6 items-center justify-center rounded-sm text-fg-2 transition-colors duration-hover enabled:hover:bg-surface-3 enabled:hover:text-fg disabled:cursor-not-allowed disabled:text-fg-disabled focus-visible:outline-2 focus-visible:outline-accent"
              >
                <DownloadSimple size={14} aria-hidden />
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

export const CompositionsTab = memo(function CompositionsTab({
  projectId,
  compositions,
  activeComposition,
  masterCompositionPath = null,
  onSelect,
  onRenderComposition,
  onAddToTimeline,
  isRendering,
  lintFindingsByFile,
}: CompositionsTabProps) {
  const { t } = useTranslation();
  const thumbnailRevisions = usePlayerStore((state) => state.thumbnailRevisions);
  const previewBooted = usePlayerStore((state) => state.previewBooted);
  if (compositions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <p className="text-center text-xs text-fg-3">{t("sidebar.compositions.none")}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-bg-0 pb-1">
      <div className="flex h-list-head items-baseline gap-1.5 px-3 pt-2 text-xs font-semibold text-fg-2">
        {t("sidebar.compositions.title")}
        <span className="font-normal tabular-nums text-fg-3">
          {formatNumber(compositions.length)}
        </span>
      </div>
      <div className="grid gap-px px-1.5">
        {compositions.map((comp) => (
          <CompCard
            key={`${projectId}:${comp}`}
            projectId={projectId}
            comp={comp}
            isActive={activeComposition === comp}
            isRoot={comp === masterCompositionPath}
            onSelect={() => onSelect(comp)}
            onRender={onRenderComposition ? () => onRenderComposition(comp) : undefined}
            onAddToTimeline={onAddToTimeline ? () => onAddToTimeline(comp) : undefined}
            isRendering={isRendering}
            lintInfo={lintFindingsByFile?.get(comp)}
            contentRevision={thumbnailRevisionOf(thumbnailRevisions, comp)}
            previewBooted={previewBooted}
          />
        ))}
      </div>
    </div>
  );
});
