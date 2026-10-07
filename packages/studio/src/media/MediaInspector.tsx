import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  ArrowSquareOut,
  ChartBarHorizontal,
  FilmStrip,
  Image as ImageIcon,
  LinkBreak,
  MagicWand,
  MusicNotes,
  ShieldCheck,
  Sparkle,
  SquaresFour,
  TextAa,
  TreeStructure,
} from "@phosphor-icons/react";
import type { LicenseStatus, TakeIssueKind } from "@hyperframes/agent-protocol";
import { Badge, Button, Menu, MenuItem, cn, type StatusTone } from "../components/ui";
import { Trans, formatBytes, formatDate, useTranslation, type TranslationKey } from "../i18n";
import { usePlayerStore } from "../player/store/playerStore";
import { deriveUsedPaths } from "../components/sidebar/AssetsTab";
import { studioStoryStore } from "../story/storyContext";
import {
  KIND_LABELS,
  KIND_SINGULAR_LABELS,
  clock,
  fileExtension,
  needsAnalysis,
  resolutionLabel,
  type MediaItem,
} from "./mediaLibrary";
import { chaptersInOrder } from "./mediaStoryDrop";
import {
  AnalysisRows,
  Kv,
  MediaPreview,
  Section,
  TimedList,
  TranscriptList,
} from "./MediaInspectorParts";
import { AssetRangeEditor } from "./AssetRangeEditor";
import { useAssetAnalysis } from "./useAssetAnalysis";
import { RemoveBackgroundDialog, type RemoveBackground } from "./RemoveBackgroundDialog";

const KIND_ICON: Record<MediaItem["kind"], ReactNode> = {
  video: <FilmStrip className="size-icon-md" />,
  image: <ImageIcon className="size-icon-md" />,
  audio: <MusicNotes className="size-icon-md" />,
  font: <TextAa className="size-icon-md" />,
};

const KIND_TINT: Record<MediaItem["kind"], string> = {
  video: "bg-k-video-h border-k-video-l",
  image: "bg-k-image-h border-k-image-l",
  audio: "bg-k-audio-h border-k-audio-l",
  font: "bg-k-caption-h border-k-caption-l",
};

const LICENSE_LOOK: Record<LicenseStatus, { tone: StatusTone; text: TranslationKey }> = {
  clear: { tone: "success", text: "media.license.clear" },
  attribution: { tone: "success", text: "media.license.attribution" },
  restricted: { tone: "warning", text: "media.license.restricted" },
  unknown: { tone: "neutral", text: "media.license.unknown" },
};

const TAKE_KIND_LABELS = {
  retake: "media.inspector.takeKind.retake",
  false_start: "media.inspector.takeKind.false_start",
  restart_cue: "media.inspector.takeKind.restart_cue",
  stutter: "media.inspector.takeKind.stutter",
  filler: "media.inspector.takeKind.filler",
  black: "media.inspector.takeKind.black",
  frozen: "media.inspector.takeKind.frozen",
} as const satisfies Record<TakeIssueKind, TranslationKey>;

function Head({
  icon,
  tint,
  name,
  sub,
}: {
  icon: ReactNode;
  tint: string;
  name: string;
  sub: string;
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <div
        className={cn(
          "flex size-7 flex-none items-center justify-center rounded-sm border text-clip-ink",
          tint,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="truncate text-md font-semibold tracking-[-0.005em]" title={name}>
          {name}
        </div>
        <div className="mt-px truncate text-xs text-fg-3 tabular-nums">{sub}</div>
      </div>
    </div>
  );
}

export interface MediaInspectorProps {
  projectId: string;
  item: MediaItem | null;
  items: readonly MediaItem[];
  waitingCount: number;
  onAnalyze: (paths: readonly string[]) => void;
  onAddToTimeline?: (path: string) => void;
  onAddToStory: (item: MediaItem, chapterId: string | null) => void;
  onOpenSources: (path: string) => void;
  removeBackground: RemoveBackground;
}

function Overview({ items, waitingCount }: Pick<MediaInspectorProps, "items" | "waitingCount">) {
  const { t } = useTranslation();
  const count = (kind: MediaItem["kind"]) => items.filter((item) => item.kind === kind).length;
  const external = items.filter((item) => item.provenance);
  const attention = external.filter((item) => (item.provenance?.issues.length ?? 0) > 0).length;
  const notAnalyzed = items.filter(needsAnalysis).length;
  let analysis = t("media.inspector.upToDate");
  if (waitingCount) analysis = t("media.inspector.waiting", { count: waitingCount });
  else if (notAnalyzed) analysis = t("media.inspector.notAnalyzed", { count: notAnalyzed });
  if (items.length === 0) {
    return (
      <div className="p-3 text-sm leading-[17px] text-fg-3">
        {t("media.inspector.emptyLibrary")}
      </div>
    );
  }
  return (
    <>
      <div className="border-b border-border-subtle">
        <Head
          icon={<SquaresFour className="size-icon-md" />}
          tint={KIND_TINT.video}
          name={t("media.inspector.overviewTitle")}
          sub={t("media.inspector.overviewSub", { count: items.length })}
        />
      </div>
      <Section title={t("media.inspector.section.library")}>
        <Kv
          rows={[
            [t(KIND_LABELS.video), count("video")],
            [t(KIND_LABELS.image), count("image")],
            [t(KIND_LABELS.audio), count("audio")],
            [t(KIND_LABELS.font), count("font")],
            [t("media.inspector.row.analysis"), analysis],
            [
              t("media.inspector.row.external"),
              <>
                {external.length}
                {attention > 0 && (
                  <span className="text-warning">
                    {" "}
                    {t("media.inspector.externalNeedCheck", { count: attention })}
                  </span>
                )}
              </>,
            ],
          ]}
        />
      </Section>
      <div className="p-3 text-sm leading-[17px] text-fg-3">{t("media.inspector.selectHint")}</div>
    </>
  );
}

function SourceSection({
  item,
  onOpenSources,
}: {
  item: MediaItem;
  onOpenSources: (path: string) => void;
}) {
  const { t } = useTranslation();
  const record = item.provenance;
  if (!record) {
    return (
      <Section title={t("media.inspector.section.source")}>
        <Kv
          rows={[
            [t("media.inspector.row.origin"), t("media.origin.imported")],
            [t("media.inspector.row.location"), item.path, "mono"],
          ]}
        />
      </Section>
    );
  }
  const look = LICENSE_LOOK[record.licenseStatus];
  const retrievedAt = formatDate(new Date(record.retrievedAt));
  const found =
    item.origin === "generated"
      ? t("media.inspector.generatedBy", { date: retrievedAt })
      : record.retrievedBy.agent === "user"
        ? t("media.inspector.downloadedBy", { date: retrievedAt })
        : t("media.inspector.foundBy", { date: retrievedAt });
  return (
    <Section title={t("media.inspector.section.sourceLicense")}>
      <div className="flex items-center gap-2">
        {look && <Badge tone={look.tone}>{t(look.text)}</Badge>}
        <span className="truncate text-sm text-fg-3">{found}</span>
      </div>
      <Kv
        rows={[
          [t("media.inspector.row.source"), record.source.name],
          [t("media.inspector.row.author"), record.author ?? "—"],
          [t("media.inspector.row.license"), record.license],
        ]}
      />
      {record.issues.length > 0 && (
        <p className="m-0 text-sm text-warning">{record.issues.join(" · ")}</p>
      )}
      <div className="flex gap-1.5">
        {record.pageUrl && (
          <Button
            size="sm"
            className="min-w-0 flex-1"
            icon={<ArrowSquareOut />}
            onClick={() => window.open(record.pageUrl ?? "", "_blank", "noopener,noreferrer")}
          >
            {t("media.inspector.openOriginal")}
          </Button>
        )}
        <Button
          size="sm"
          className="min-w-0 flex-1"
          icon={<ShieldCheck />}
          onClick={() => onOpenSources(item.path)}
        >
          {t("media.inspector.licenseDetails")}
        </Button>
      </div>
    </Section>
  );
}

function UsageSection({ item }: { item: MediaItem }) {
  const { t } = useTranslation();
  const elements = usePlayerStore((state) => state.elements);
  const graph = useStore(studioStoryStore, (state) => state.graph);
  const clips = elements.filter((element) => deriveUsedPaths([element]).has(item.path));
  const nodes = (graph?.nodes ?? []).filter((node) => "asset" in node && node.asset === item.path);
  const chapterTitles = (nodeId: string) =>
    (graph?.attachments ?? [])
      .filter((attachment) => attachment.node === nodeId)
      .map((attachment) => graph?.nodes.find((node) => node.id === attachment.chapter)?.title)
      .filter(Boolean)
      .join(", ");
  const compositions = item.provenance?.usedIn ?? [];
  const empty = clips.length === 0 && nodes.length === 0 && compositions.length === 0;
  return (
    <Section title={t("media.inspector.section.usedIn")}>
      {empty && <p className="m-0 text-sm text-fg-3">{t("media.inspector.notUsed")}</p>}
      {clips.length > 0 && (
        <div className="flex min-h-ctl-sm items-center gap-2 text-sm">
          <ChartBarHorizontal className="size-icon-sm flex-none text-fg-3" />
          <span className="min-w-0 flex-1 truncate">
            {t("media.inspector.usedTimeline", { count: clips.length })}
          </span>
          <span className="font-mono text-num text-fg-3">
            {clock(Math.min(...clips.map((clip) => clip.start)))}
          </span>
        </div>
      )}
      {nodes.map((node) => (
        <div key={node.id} className="flex min-h-ctl-sm items-center gap-2 text-sm">
          <TreeStructure className="size-icon-sm flex-none text-fg-3" />
          <span className="min-w-0 flex-1 truncate">
            {chapterTitles(node.id) || t("media.inspector.usedUnconnected")}
          </span>
          <span className="text-xs text-fg-3">{node.title}</span>
        </div>
      ))}
      {clips.length === 0 &&
        compositions.map((path) => (
          <div key={path} className="flex min-h-ctl-sm items-center gap-2 text-sm">
            <ChartBarHorizontal className="size-icon-sm flex-none text-fg-3" />
            <span className="min-w-0 flex-1 truncate">{path}</span>
          </div>
        ))}
    </Section>
  );
}

function AssetInspector(props: MediaInspectorProps & { item: MediaItem }) {
  const { t } = useTranslation();
  const { item, projectId } = props;
  const analysis = useAssetAnalysis(projectId, item);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const graph = useStore(studioStoryStore, (state) => state.graph);
  const chapters = useMemo(() => (graph ? chaptersInOrder(graph) : []), [graph]);

  const seek = (next: number) => {
    setTime(next);
    if (mediaRef.current) mediaRef.current.currentTime = next;
  };
  const togglePlay = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) void media.play();
    else media.pause();
  };
  const toggleRef = useRef(togglePlay);
  toggleRef.current = togglePlay;
  // Space plays the selected asset while focus is in the Media workspace (not in a field or on a button).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest("[data-studio-media]")) return;
      if (target.closest("input, textarea, button, [contenteditable='true']")) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const resolution = resolutionLabel(item.width, item.height);
  const sub = [
    t(KIND_SINGULAR_LABELS[item.kind]),
    item.duration != null && item.kind !== "image" ? clock(item.duration) : null,
    item.kind === "font"
      ? fileExtension(item.path)
      : item.width
        ? `${item.width}×${item.height}`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const overview = analysis.overview;
  const segments = overview?.segments?.segments ?? [];
  const takes = overview?.takes?.issues ?? [];
  const canRemoveBackground = (item.kind === "video" || item.kind === "image") && !item.offline;

  return (
    <>
      <MediaPreview
        item={item}
        projectId={projectId}
        mediaRef={mediaRef}
        time={time}
        playing={playing}
        onTime={setTime}
        onSeek={seek}
        onPlayingChange={setPlaying}
        onTogglePlay={togglePlay}
        analysis={analysis}
      />
      <Head icon={KIND_ICON[item.kind]} tint={KIND_TINT[item.kind]} name={item.name} sub={sub} />
      {item.offline && (
        <div
          role="status"
          className="mx-3 mb-3 grid gap-1.5 rounded-md border border-warning/35 bg-warning-soft px-2.5 py-2 text-sm leading-[17px] text-fg-2"
        >
          <div className="flex items-center gap-1.5 font-semibold text-fg">
            <LinkBreak className="size-icon-sm text-warning" />
            {t("media.status.offline")}
          </div>
          <p className="m-0">{t("media.inspector.offlineHint")}</p>
        </div>
      )}
      {item.kind !== "font" && !item.offline && (
        <div className="flex gap-1.5 border-b border-border-subtle px-3 pb-3">
          <Button
            size="sm"
            className="min-w-0 flex-1"
            icon={<ChartBarHorizontal />}
            disabled={!props.onAddToTimeline}
            onClick={() => props.onAddToTimeline?.(item.path)}
          >
            {t("media.inspector.addAtPlayhead")}
          </Button>
          {graph && (
            <Menu
              aria-label={t("media.inspector.addToStoryMenu")}
              trigger={
                <Button size="sm" className="min-w-0 flex-1" icon={<TreeStructure />}>
                  {t("media.inspector.addToStory")}
                </Button>
              }
            >
              {chapters.map((chapter) => (
                <MenuItem key={chapter.id} onClick={() => props.onAddToStory(item, chapter.id)}>
                  {chapter.title || t("media.chapter.untitled")}
                </MenuItem>
              ))}
              <MenuItem onClick={() => props.onAddToStory(item, null)}>
                {t("media.drop.unconnected")}
              </MenuItem>
            </Menu>
          )}
        </div>
      )}
      {(canRemoveBackground || needsAnalysis(item)) && (
        <div className="flex gap-1.5 border-b border-border-subtle px-3 py-2.5">
          {needsAnalysis(item) && (
            <Button
              size="sm"
              className="min-w-0 flex-1"
              icon={<Sparkle />}
              onClick={() => props.onAnalyze([item.path])}
            >
              {t("media.inspector.analyze")}
            </Button>
          )}
          {canRemoveBackground && (
            <Button
              size="sm"
              className="min-w-0 flex-1"
              icon={<MagicWand />}
              onClick={() => setRemoving(true)}
            >
              {t("media.inspector.removeBackground")}
            </Button>
          )}
        </div>
      )}
      {(item.kind === "video" || item.kind === "audio") &&
        !item.offline &&
        (item.duration ?? 0) > 0 && (
          <AssetRangeEditor
            item={item}
            projectId={projectId}
            mediaRef={mediaRef}
            time={time}
            playing={playing}
            onSeek={seek}
            shotStarts={analysis.shots.slice(1).map((shot) => shot.start)}
          />
        )}
      {item.kind !== "font" && <SourceSection item={item} onOpenSources={props.onOpenSources} />}
      {item.analysis && (
        <Section title={t("media.inspector.section.analysis")}>
          <AnalysisRows item={item} analysis={analysis} />
        </Section>
      )}
      {analysis.sentences.length > 0 && (
        <Section title={t("media.inspector.section.transcript")}>
          <TranscriptList analysis={analysis} onSeek={seek} />
        </Section>
      )}
      {takes.length > 0 && (
        <Section title={t("media.inspector.section.takeIssues")}>
          <TimedList
            time={time}
            onSeek={seek}
            rows={takes.map((issue, index) => ({
              id: `${issue.kind}-${index}`,
              start: issue.start,
              end: issue.end,
              body: (
                <>
                  <Trans
                    i18nKey="media.inspector.takeLine"
                    values={{
                      kind: t(TAKE_KIND_LABELS[issue.kind]),
                      action:
                        issue.action === "cut"
                          ? t("media.inspector.takeAction.cut")
                          : t("media.inspector.takeAction.review"),
                    }}
                    components={{ b: <b className="font-semibold" /> }}
                  />
                  <span className="block text-xs leading-[15px] text-fg-3">{issue.note}</span>
                </>
              ),
            }))}
          />
        </Section>
      )}
      {segments.length > 0 && (
        <Section title={t("media.inspector.section.scenes")}>
          <TimedList
            time={time}
            onSeek={seek}
            rows={segments.map((segment) => ({
              id: segment.id,
              start: segment.start,
              end: segment.end,
              body: segment.title,
            }))}
          />
        </Section>
      )}
      {item.kind !== "font" && <UsageSection item={item} />}
      <Section title={t("media.inspector.section.file")}>
        <Kv
          rows={[
            [t("media.inspector.row.file"), item.name, "wrap"],
            [t("media.inspector.row.location"), item.path, "mono"],
            [t("media.inspector.row.format"), fileExtension(item.path)],
            resolution && item.kind !== "audio"
              ? [t("media.inspector.row.resolution"), resolution]
              : null,
            item.duration != null && item.kind !== "image"
              ? [t("media.inspector.row.duration"), clock(item.duration)]
              : null,
            item.kind === "video" && item.hasAudio != null
              ? [
                  t("media.inspector.row.audio"),
                  item.hasAudio ? t("media.inspector.hasAudio") : t("media.inspector.noAudio"),
                ]
              : null,
            [t("media.inspector.row.size"), item.bytes == null ? "—" : formatBytes(item.bytes)],
          ]}
        />
      </Section>
      {removing && (
        <RemoveBackgroundDialog
          item={item}
          onClose={() => setRemoving(false)}
          removeBackground={props.removeBackground}
        />
      )}
    </>
  );
}

export function MediaInspector(props: MediaInspectorProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="media-inspector">
      {props.item ? (
        <AssetInspector key={props.item.path} {...props} item={props.item} />
      ) : (
        <Overview items={props.items} waitingCount={props.waitingCount} />
      )}
    </div>
  );
}
