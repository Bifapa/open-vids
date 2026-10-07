import type { ReactNode } from "react";
import {
  CheckCircle,
  Circle,
  Clock,
  DownloadSimple,
  FilmStrip,
  Globe,
  Image as ImageIcon,
  LinkBreak,
  MagnifyingGlass,
  Microphone,
  MusicNotes,
  ShieldCheck,
  SquaresFour,
  TextAa,
  Tray,
} from "@phosphor-icons/react";
import { isBetaFeatureEnabled } from "../betaFeatures";
import { Meter, cn } from "../components/ui";
import { formatNumber, useTranslation, type TranslationKey } from "../i18n";
import {
  analysisRunning,
  inCollection,
  needsAnalysis,
  type MediaCollection,
  type MediaItem,
} from "./mediaLibrary";
import { openVoiceoverTab } from "../voice/openVoiceoverTab";
import type { AnalysisQueueState } from "./useMediaLibrary";

type NavKey = MediaCollection | "sources";

const GROUPS: ReadonlyArray<{
  label: TranslationKey;
  items: ReadonlyArray<{ key: NavKey; name: TranslationKey; icon: ReactNode }>;
}> = [
  {
    label: "media.nav.group.library",
    items: [
      { key: "all", name: "media.collection.all", icon: <SquaresFour /> },
      { key: "video", name: "media.kind.video", icon: <FilmStrip /> },
      { key: "image", name: "media.kind.image", icon: <ImageIcon /> },
      { key: "audio", name: "media.kind.audio", icon: <MusicNotes /> },
      { key: "font", name: "media.kind.font", icon: <TextAa /> },
    ],
  },
  {
    label: "media.nav.group.origin",
    items: [
      { key: "imported", name: "media.collection.imported", icon: <Tray /> },
      { key: "research", name: "media.collection.research", icon: <Globe /> },
      { key: "download", name: "media.collection.download", icon: <DownloadSimple /> },
    ],
  },
  {
    label: "media.nav.group.voice",
    items: [{ key: "voice", name: "media.collection.voice", icon: <Microphone /> }],
  },
  {
    label: "media.nav.group.smart",
    items: [
      { key: "unused", name: "media.collection.unused", icon: <Circle /> },
      { key: "analysis", name: "media.collection.analysis", icon: <Clock /> },
      { key: "offline", name: "media.status.offline", icon: <LinkBreak /> },
    ],
  },
  {
    label: "media.nav.group.project",
    items: [{ key: "sources", name: "media.nav.sources", icon: <ShieldCheck /> }],
  },
];

export const COLLECTION_LABELS = {
  all: "media.collection.all",
  video: "media.kind.video",
  image: "media.kind.image",
  audio: "media.kind.audio",
  font: "media.kind.font",
  imported: "media.collection.imported",
  research: "media.collection.research",
  download: "media.collection.download",
  voice: "media.collection.voice",
  unused: "media.collection.unused",
  analysis: "media.collection.analysis",
  offline: "media.status.offline",
} as const satisfies Record<MediaCollection, TranslationKey>;

const STAGE_LABELS: Partial<Record<string, TranslationKey>> = {
  transcript: "media.analysis.stage.transcript",
  speakers: "media.analysis.stage.speakers",
  silence: "media.analysis.stage.silence",
  shots: "media.analysis.stage.shots",
  takes: "media.analysis.stage.takes",
  segments: "media.analysis.stage.segments",
};

const fileOf = (path: string) => path.split("/").pop() ?? path;

function AnalysisCard({
  items,
  queue,
  onAnalyzeAll,
}: {
  items: readonly MediaItem[];
  queue: AnalysisQueueState;
  onAnalyzeAll: () => void;
}) {
  const { t } = useTranslation();
  const following = queue.job ?? null;
  const pending = queue.waiting.length + (following || queue.starting ? 1 : 0);
  const external = items.find(analysisRunning);
  const notAnalyzed = items.filter(needsAnalysis).length;
  let head: ReactNode;
  let body: ReactNode = null;
  if (pending > 0) {
    const source = following?.source ?? queue.starting ?? "";
    const stageKey = following?.stage ? STAGE_LABELS[following.stage] : undefined;
    head = (
      <span className="font-normal text-fg-3">
        {t("media.analysis.waiting", { count: formatNumber(pending) })}
      </span>
    );
    body = (
      <>
        <p className="m-0 truncate text-fg-3" title={source}>
          {following?.stage
            ? t("media.analysis.stageFile", {
                stage: stageKey ? t(stageKey) : following.stage,
                file: fileOf(source),
              })
            : t("media.analysis.startingFile", { file: fileOf(source) })}
        </p>
        <Meter value={(following?.progress ?? 0) / 100} label={t("media.analysis.progress")} />
      </>
    );
  } else if (external) {
    head = <span className="font-normal text-fg-3">{t("media.analysis.running")}</span>;
    body = (
      <p className="m-0 truncate text-fg-3" title={external.path}>
        {external.name}
      </p>
    );
  } else if (notAnalyzed > 0) {
    head = (
      <span className="font-normal text-fg-3">
        {t("media.analysis.notAnalyzed", { count: formatNumber(notAnalyzed) })}
      </span>
    );
    body = (
      <button
        type="button"
        onClick={onAnalyzeAll}
        className="justify-self-start text-fg-2 underline underline-offset-2 hover:text-fg"
      >
        {t("media.analysis.analyzeAll")}
      </button>
    );
  } else if (items.length === 0) {
    body = <p className="m-0 text-fg-3">{t("media.analysis.empty")}</p>;
  } else {
    head = <span className="font-normal text-fg-3">{t("media.analysis.upToDate")}</span>;
  }
  return (
    <div
      className="mx-2 mb-2 grid flex-none gap-1.5 rounded-md border border-border-subtle bg-bg-1 px-2.5 py-2 text-sm leading-[17px] text-fg-2"
      data-testid="media-analysis-status"
    >
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-semibold text-fg">
        {pending || external ? (
          <MagnifyingGlass className="size-icon-sm flex-none self-center text-fg-3" />
        ) : (
          <CheckCircle className="size-icon-sm flex-none self-center text-fg-3" />
        )}
        {t("media.analysis.title")}
        {head}
      </div>
      {body}
      {queue.error && <p className="m-0 text-xs text-error">{queue.error}</p>}
    </div>
  );
}

export function MediaLibraryNav({
  items,
  current,
  onSelect,
  queue,
  onAnalyzeAll,
}: {
  items: readonly MediaItem[];
  current: NavKey;
  onSelect: (key: NavKey) => void;
  queue: AnalysisQueueState;
  onAnalyzeAll: () => void;
}) {
  const { t } = useTranslation();
  const external = items.filter((item) => item.provenance);
  const attention = external.filter((item) => (item.provenance?.issues.length ?? 0) > 0).length;
  const empty = items.length === 0;
  return (
    <>
      <nav
        aria-label={t("media.nav.label")}
        className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pt-1 pb-2.5"
        data-testid="media-library-nav"
      >
        {GROUPS.filter(
          (group) => group.label !== "media.nav.group.voice" || isBetaFeatureEnabled("voiceover"),
        ).map((group, index) => (
          <div key={group.label} className="contents">
            <div
              className={cn(
                "px-2 pb-1 text-xs leading-[14px] font-semibold text-fg-3",
                index === 0 ? "pt-1" : "pt-3",
              )}
            >
              {t(group.label)}
            </div>
            {group.items.map((entry) => {
              const key = entry.key;
              const count =
                key === "sources"
                  ? external.length
                  : items.filter((item) => inCollection(item, key)).length;
              const warn =
                (entry.key === "offline" && count > 0) ||
                (entry.key === "sources" && attention > 0);
              const selected = current === entry.key;
              return (
                <button
                  key={entry.key}
                  type="button"
                  aria-current={selected || undefined}
                  disabled={empty && entry.key !== "all"}
                  onClick={() => onSelect(entry.key)}
                  className={cn(
                    "flex h-nav w-full flex-none items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 outline-hidden hover:bg-surface-1 hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent disabled:pointer-events-none disabled:text-fg-disabled",
                    "[&_svg]:size-icon-md [&_svg]:flex-none [&_svg]:text-fg-3",
                    selected && "bg-surface-3 text-fg [&_svg]:text-fg",
                  )}
                >
                  {entry.icon}
                  <span className="min-w-0 flex-1 truncate">{t(entry.name)}</span>
                  {warn ? (
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-warning-soft px-[5px] text-2xs leading-none font-semibold text-warning tabular-nums">
                      {formatNumber(entry.key === "sources" ? attention : count)}
                    </span>
                  ) : (
                    <span
                      className={cn("text-xs tabular-nums", selected ? "text-fg" : "text-fg-3")}
                    >
                      {formatNumber(count)}
                    </span>
                  )}
                </button>
              );
            })}
            {group.label === "media.nav.group.voice" && (
              <button
                type="button"
                data-testid="media-open-voiceover"
                onClick={openVoiceoverTab}
                className="flex h-nav w-full flex-none items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 outline-hidden hover:bg-surface-1 hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent"
              >
                <span className="min-w-0 flex-1 truncate">{t("media.nav.openVoiceover")}</span>
              </button>
            )}
          </div>
        ))}
      </nav>
      <AnalysisCard items={items} queue={queue} onAnalyzeAll={onAnalyzeAll} />
    </>
  );
}

export type { NavKey };
