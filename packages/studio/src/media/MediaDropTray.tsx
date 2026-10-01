import { useState, type DragEvent } from "react";
import { ChartBarHorizontal, LockSimple, TreeStructure } from "@phosphor-icons/react";
import type { StoryGraph } from "@hyperframes/agent-protocol";
import { cn } from "../components/ui";
import { useTranslation, type TranslationKey } from "../i18n";
import { TIMELINE_ASSET_MIME } from "../utils/timelineAssetDrop";
import { clock, type MediaItem } from "./mediaLibrary";
import { chaptersInOrder } from "./mediaStoryDrop";

export type DropTarget = { kind: "timeline" } | { kind: "story"; chapterId: string | null };

const CONNECTS = {
  video: "media.drop.connects.video",
  image: "media.drop.connects.image",
  audio: "media.drop.connects.audio",
  font: "media.drop.connects.font",
} as const satisfies Record<MediaItem["kind"], TranslationKey>;

function Zone({
  id,
  title,
  sub,
  locked,
  onDrop,
}: {
  id: string;
  title: string;
  sub: string;
  locked?: boolean;
  onDrop: () => void;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const accept = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(TIMELINE_ASSET_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setOver(true);
  };
  return (
    <div
      data-testid={`media-drop-${id}`}
      onDragEnter={accept}
      onDragOver={accept}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onDrop();
      }}
      className={cn(
        "flex h-row-lg min-w-0 flex-1 flex-col justify-center gap-px rounded-md border border-dashed border-border-strong bg-bg-0 px-2.5 text-left text-sm text-fg",
        over && "border-solid border-accent bg-accent-soft",
      )}
    >
      <b className="flex items-center gap-1 truncate font-medium">
        {locked && (
          <LockSimple className="size-icon-xs text-fg-3" aria-label={t("media.drop.locked")} />
        )}
        {title}
      </b>
      <span className={cn("truncate text-xs text-fg-3 tabular-nums", over && "text-fg-2")}>
        {sub}
      </span>
    </div>
  );
}

/**
 * Shown while a Media item is dragged: drop zones for the Timeline (added at the playhead, like the asset menu's
 * "Add at playhead") and for each Story chapter (a material node attached to it) plus an unconnected node.
 */
export function MediaDropTray({
  item,
  graph,
  playhead,
  onDrop,
}: {
  item: MediaItem;
  graph: StoryGraph | null;
  playhead: number;
  onDrop: (target: DropTarget) => void;
}) {
  const { t } = useTranslation();
  const chapters = graph ? chaptersInOrder(graph) : [];
  return (
    <div
      aria-label={t("media.drop.targets")}
      data-testid="media-drop-tray"
      className="hf-media-tray absolute right-2.5 bottom-2.5 left-2.5 z-30 grid grid-cols-[168px_minmax(0,1fr)] gap-3 rounded-lg border border-border bg-menu-bg px-2.5 pt-2 pb-2.5 shadow-pop backdrop-blur-md"
    >
      <div className="grid min-w-0 content-start gap-1.5">
        <div className="flex items-center gap-1.5 px-0.5 text-xs font-semibold text-fg-2">
          <ChartBarHorizontal className="size-icon-sm text-fg-3" />
          {t("media.drop.timeline")}
        </div>
        <Zone
          id="timeline"
          title={t("media.drop.atPlayhead")}
          sub={clock(playhead)}
          onDrop={() => onDrop({ kind: "timeline" })}
        />
      </div>
      {graph && (
        <div className="grid min-w-0 content-start gap-1.5">
          <div className="flex items-baseline gap-1.5 px-0.5 text-xs font-semibold text-fg-2">
            <TreeStructure className="size-icon-sm self-center text-fg-3" />
            {t("media.drop.storyGraph")}
            <span className="font-normal text-fg-3">{t(CONNECTS[item.kind])}</span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {chapters.map((chapter) => (
              <Zone
                key={chapter.id}
                id={`chapter-${chapter.id}`}
                title={chapter.title || t("media.chapter.untitled")}
                sub={
                  chapter.estimatedDuration > 0
                    ? clock(chapter.estimatedDuration)
                    : t("media.drop.chapter")
                }
                locked={chapter.locked}
                onDrop={() => onDrop({ kind: "story", chapterId: chapter.id })}
              />
            ))}
            <Zone
              id="unconnected"
              title={t("media.drop.unconnected")}
              sub={t("media.drop.placeLater")}
              onDrop={() => onDrop({ kind: "story", chapterId: null })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
