import {
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Clock,
  DownloadSimple,
  Eye,
  FilmStrip,
  Globe,
  LinkBreak,
  MusicNotes,
  Subtitles,
  Image as ImageIcon,
} from "@phosphor-icons/react";
import { cn } from "../components/ui";
import { t as translate, useTranslation } from "../i18n";
import { VideoFrameThumbnail } from "../components/ui/VideoFrameThumbnail";
import { resolveMediaPreviewUrl } from "../player/components/thumbnailUtils";
import { fontFamilyFromAssetPath } from "../components/editor/fontAssets";
import {
  analysisRunning,
  clock,
  fileExtension,
  itemSpec,
  needsAnalysis,
  resolutionLabel,
  stageReady,
  type MediaItem,
  type MediaMatch,
} from "./mediaLibrary";

export interface TileHandlers {
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onDragStart: (event: DragEvent, item: MediaItem) => void;
  onDragEnd: () => void;
  onContextMenu: (event: MouseEvent, item: MediaItem) => void;
}

/** The text of a search hit shown in place of the card's spec line. */
function hitText(match: MediaMatch | null): string | null {
  if (!match || match.where === "name") return null;
  if (match.where === "transcript")
    return translate("media.match.transcript", { text: match.text });
  if (match.where === "vision") return translate("media.match.vision", { detail: match.text });
  return match.text;
}

/** The tile picture: a video frame, the image, or a kind glyph; hatched with a warning when the file is offline. */
export function MediaThumb({
  item,
  projectId,
  className,
  glyph = 20,
  children,
}: {
  item: MediaItem;
  projectId: string;
  className?: string;
  glyph?: number;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [imageFailed, setImageFailed] = useState(false);
  const url = resolveMediaPreviewUrl(item.path, projectId);
  let body: ReactNode;
  if (item.offline) {
    body = (
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs font-medium text-warning">
        <LinkBreak size={glyph} />
        {glyph >= 16 && <span>{t("media.status.offline")}</span>}
      </span>
    );
  } else if (item.kind === "video") {
    body = <VideoFrameThumbnail src={url} />;
  } else if (item.kind === "image" && !imageFailed) {
    body = (
      <img
        src={url}
        alt=""
        loading="lazy"
        draggable={false}
        className="absolute inset-0 size-full object-contain"
        onError={() => setImageFailed(true)}
      />
    );
  } else if (item.kind === "font") {
    body = (
      <span
        className="absolute inset-0 flex items-center justify-center bg-surface-1 text-fg"
        style={{
          fontFamily: `"${fontFamilyFromAssetPath(item.path)}", var(--font-ui)`,
          fontSize: glyph >= 16 ? 34 : 13,
        }}
      >
        Aa
      </span>
    );
  } else {
    body = (
      <span className="absolute inset-0 flex items-center justify-center bg-surface-1 text-fg-3">
        {item.kind === "audio" ? <MusicNotes size={glyph} /> : <ImageIcon size={glyph} />}
      </span>
    );
  }
  return (
    <div className={cn("hf-media-thumb", item.offline && "hf-media-offline", className)}>
      {body}
      {children}
    </div>
  );
}

function Flag({ title, warn, children }: { title: string; warn?: boolean; children: ReactNode }) {
  return (
    <span title={title} aria-label={title} className={cn("inline-flex", warn && "text-warning")}>
      {children}
    </span>
  );
}

/** Small monochrome analysis and origin marks on the meta line. */
export function MediaFlags({ item, showAnalysis }: { item: MediaItem; showAnalysis: boolean }) {
  const { t } = useTranslation();
  const record = item.provenance;
  const needsCheck = (record?.issues.length ?? 0) > 0;
  return (
    <span className="inline-flex flex-none items-center gap-1 text-fg-3">
      {showAnalysis && stageReady(item, "transcript") && (
        <Flag title={t("media.flag.transcribed")}>
          <Subtitles className="size-icon-sm" />
        </Flag>
      )}
      {showAnalysis && stageReady(item, "vision") && (
        <Flag title={t("media.flag.vision")}>
          <Eye className="size-icon-sm" />
        </Flag>
      )}
      {showAnalysis && stageReady(item, "shots") && (
        <Flag title={t("media.flag.scenes")}>
          <FilmStrip className="size-icon-sm" />
        </Flag>
      )}
      {showAnalysis && (analysisRunning(item) || needsAnalysis(item)) && (
        <Flag
          title={analysisRunning(item) ? t("media.flag.analyzing") : t("media.flag.notAnalyzed")}
        >
          <Clock className="size-icon-sm" />
        </Flag>
      )}
      {record && item.origin === "research" && (
        <Flag
          warn={needsCheck}
          title={
            needsCheck
              ? t("media.flag.researchIssues", {
                  source: record.source.name,
                  license: record.license,
                  issues: record.issues.join(", "),
                })
              : t("media.flag.research", { source: record.source.name, license: record.license })
          }
        >
          <Globe className="size-icon-sm" />
        </Flag>
      )}
      {record && item.origin === "download" && (
        <Flag
          warn={needsCheck}
          title={t("media.flag.download", { source: record.source.name, license: record.license })}
        >
          <DownloadSimple className="size-icon-sm" />
        </Flag>
      )}
    </span>
  );
}

function tileKeyDown(event: KeyboardEvent, item: MediaItem, handlers: TileHandlers) {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter") {
    event.preventDefault();
    handlers.onOpen(item.path);
  }
}

interface TileProps {
  item: MediaItem;
  projectId: string;
  selected: boolean;
  dragging: boolean;
  match: MediaMatch | null;
  showAnalysis: boolean;
  handlers: TileHandlers;
}

const selItem =
  "rounded-md border border-transparent outline-hidden select-none hover:border-border-subtle hover:bg-surface-1 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-selected:border-accent-line aria-selected:bg-accent-soft";

export function MediaCard({
  item,
  projectId,
  selected,
  dragging,
  match,
  showAnalysis,
  handlers,
}: TileProps) {
  const { t } = useTranslation();
  const hit = hitText(match);
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={item.offline ? t("media.card.offlineLabel", { name: item.name }) : item.name}
      tabIndex={selected ? 0 : -1}
      draggable={item.kind !== "font" && !item.offline}
      data-media-path={item.path}
      data-testid="media-card"
      onClick={() => handlers.onSelect(item.path)}
      onDoubleClick={() => handlers.onOpen(item.path)}
      onKeyDown={(event) => tileKeyDown(event, item, handlers)}
      onDragStart={(event) => handlers.onDragStart(event, item)}
      onDragEnd={handlers.onDragEnd}
      onContextMenu={(event) => handlers.onContextMenu(event, item)}
      className={cn(
        selItem,
        "flex min-w-0 cursor-grab flex-col gap-[5px] px-1 pt-1 pb-1.5",
        dragging && "opacity-50",
      )}
    >
      <MediaThumb item={item} projectId={projectId}>
        {item.duration != null && item.kind !== "image" && item.kind !== "font" && (
          <span className="absolute right-1 bottom-1 rounded-xs bg-on-media-bg px-[5px] text-num leading-[14px] font-medium text-on-media tabular-nums">
            {clock(item.duration)}
          </span>
        )}
        {item.used && (
          <span
            title={t("media.card.used")}
            className="absolute top-[5px] right-[5px] size-1.5 rounded-full bg-on-media shadow-[0_0_0_1.5px_var(--color-on-media-bg)]"
          />
        )}
      </MediaThumb>
      <div className="flex min-w-0 items-center gap-[5px] px-0.5 text-sm leading-[15px] font-medium text-fg">
        <span title={item.name} className={cn("truncate", item.offline && "text-fg-2")}>
          {item.name}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 px-0.5 text-xs leading-[14px] text-fg-3 tabular-nums">
        <span className="min-w-0 flex-1 truncate" title={hit ?? undefined}>
          {hit ?? itemSpec(item)}
        </span>
        <MediaFlags item={item} showAnalysis={showAnalysis} />
      </div>
    </div>
  );
}

export const LIST_COLUMNS =
  "grid grid-cols-[minmax(200px,1fr)_56px_92px_64px_92px_84px_52px] items-center gap-x-2.5 pr-2 pl-1";

function originLabel(item: MediaItem): ReactNode {
  if (item.offline)
    return <span className="text-warning">{translate("media.status.offline")}</span>;
  if (item.origin === "imported") return translate("media.origin.imported");
  const warn = (item.provenance?.issues.length ?? 0) > 0;
  return (
    <span className={cn(warn && "text-warning")}>
      {item.origin === "research"
        ? translate("media.origin.research")
        : translate("media.origin.download")}
    </span>
  );
}

export function MediaRow({
  item,
  projectId,
  selected,
  dragging,
  match,
  showAnalysis,
  handlers,
}: TileProps) {
  const { t } = useTranslation();
  const hit = hitText(match);
  const detail =
    item.kind === "audio" || item.kind === "font"
      ? item.kind === "font"
        ? fontFamilyFromAssetPath(item.path)
        : item.hasAudio === false
          ? "—"
          : t("media.row.audio")
      : (resolutionLabel(item.width, item.height) ?? "—");
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={item.name}
      tabIndex={selected ? 0 : -1}
      draggable={item.kind !== "font" && !item.offline}
      data-media-path={item.path}
      data-testid="media-row"
      onClick={() => handlers.onSelect(item.path)}
      onDoubleClick={() => handlers.onOpen(item.path)}
      onKeyDown={(event) => tileKeyDown(event, item, handlers)}
      onDragStart={(event) => handlers.onDragStart(event, item)}
      onDragEnd={handlers.onDragEnd}
      onContextMenu={(event) => handlers.onContextMenu(event, item)}
      className={cn(
        selItem,
        LIST_COLUMNS,
        "mt-px h-row cursor-grab text-xs text-fg-3 tabular-nums",
        dragging && "opacity-50",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <MediaThumb
          item={item}
          projectId={projectId}
          glyph={12}
          className="w-11 flex-none rounded-xs"
        />
        <span className="min-w-0 truncate text-sm text-fg" title={item.name}>
          {item.name}
        </span>
        {hit && <span className="min-w-0 truncate text-xs text-fg-3">{hit}</span>}
      </span>
      <span className="justify-self-end">
        {item.duration != null && item.kind !== "image" ? clock(item.duration) : "—"}
      </span>
      <span className="truncate">{detail}</span>
      <span className="truncate">{fileExtension(item.path)}</span>
      <span className="truncate">{originLabel(item)}</span>
      <MediaFlags item={item} showAnalysis={showAnalysis} />
      <span className="truncate">{item.used ? t("media.row.used") : "—"}</span>
    </div>
  );
}
