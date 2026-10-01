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
  MusicNotes,
  ShieldCheck,
  SquaresFour,
  TextAa,
  Tray,
} from "@phosphor-icons/react";
import { Meter, cn } from "../components/ui";
import {
  analysisRunning,
  inCollection,
  needsAnalysis,
  type MediaCollection,
  type MediaItem,
} from "./mediaLibrary";
import type { AnalysisQueueState } from "./useMediaLibrary";

type NavKey = MediaCollection | "sources";

const GROUPS: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ key: NavKey; name: string; icon: ReactNode }>;
}> = [
  {
    label: "Library",
    items: [
      { key: "all", name: "All Media", icon: <SquaresFour /> },
      { key: "video", name: "Video", icon: <FilmStrip /> },
      { key: "image", name: "Images", icon: <ImageIcon /> },
      { key: "audio", name: "Audio", icon: <MusicNotes /> },
      { key: "font", name: "Fonts", icon: <TextAa /> },
    ],
  },
  {
    label: "Origin",
    items: [
      { key: "imported", name: "Imported", icon: <Tray /> },
      { key: "research", name: "Found by Research", icon: <Globe /> },
      { key: "download", name: "Downloaded", icon: <DownloadSimple /> },
    ],
  },
  {
    label: "Smart Collections",
    items: [
      { key: "unused", name: "Not Used Yet", icon: <Circle /> },
      { key: "analysis", name: "Not Analyzed", icon: <Clock /> },
      { key: "offline", name: "Offline", icon: <LinkBreak /> },
    ],
  },
  {
    label: "Project",
    items: [{ key: "sources", name: "Sources & Licenses", icon: <ShieldCheck /> }],
  },
];

export const COLLECTION_NAMES: Record<MediaCollection, string> = {
  all: "All Media",
  video: "Video",
  image: "Images",
  audio: "Audio",
  font: "Fonts",
  imported: "Imported",
  research: "Found by Research",
  download: "Downloaded",
  unused: "Not Used Yet",
  analysis: "Not Analyzed",
  offline: "Offline",
};

const STAGE_LABEL: Record<string, string> = {
  transcript: "Transcript",
  speakers: "Speakers",
  silence: "Silence",
  shots: "Scene map",
  takes: "Take issues",
  segments: "Scenes",
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
  const following = queue.job ?? null;
  const pending = queue.waiting.length + (following || queue.starting ? 1 : 0);
  const external = items.find(analysisRunning);
  const notAnalyzed = items.filter(needsAnalysis).length;
  let head: ReactNode;
  let body: ReactNode = null;
  if (pending > 0) {
    const source = following?.source ?? queue.starting ?? "";
    head = <span className="font-normal text-fg-3">· {pending} waiting</span>;
    body = (
      <>
        <p className="m-0 truncate text-fg-3" title={source}>
          {following?.stage ? (STAGE_LABEL[following.stage] ?? following.stage) : "Starting"} ·{" "}
          {fileOf(source)}
        </p>
        <Meter value={(following?.progress ?? 0) / 100} label="Analysis progress" />
      </>
    );
  } else if (external) {
    head = <span className="font-normal text-fg-3">· running</span>;
    body = (
      <p className="m-0 truncate text-fg-3" title={external.path}>
        {external.name}
      </p>
    );
  } else if (notAnalyzed > 0) {
    head = <span className="font-normal text-fg-3">· {notAnalyzed} not analyzed</span>;
    body = (
      <button
        type="button"
        onClick={onAnalyzeAll}
        className="justify-self-start text-fg-2 underline underline-offset-2 hover:text-fg"
      >
        Analyze all
      </button>
    );
  } else if (items.length === 0) {
    body = <p className="m-0 text-fg-3">Import video or audio, then analyze it here.</p>;
  } else {
    head = <span className="font-normal text-fg-3">· up to date</span>;
  }
  return (
    <div
      className="mx-2 mb-2 grid flex-none gap-1.5 rounded-md border border-border-subtle bg-bg-1 px-2.5 py-2 text-sm leading-[17px] text-fg-2"
      data-testid="media-analysis-status"
    >
      <div className="flex items-center gap-1.5 font-semibold text-fg">
        {pending || external ? (
          <MagnifyingGlass className="size-icon-sm text-fg-3" />
        ) : (
          <CheckCircle className="size-icon-sm text-fg-3" />
        )}
        Analysis
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
  const external = items.filter((item) => item.provenance);
  const attention = external.filter((item) => (item.provenance?.issues.length ?? 0) > 0).length;
  const empty = items.length === 0;
  return (
    <>
      <nav
        aria-label="Collections"
        className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pt-1 pb-2.5"
        data-testid="media-library-nav"
      >
        {GROUPS.map((group, index) => (
          <div key={group.label} className="contents">
            <div
              className={cn(
                "px-2 pb-1 text-xs leading-[14px] font-semibold text-fg-3",
                index === 0 ? "pt-1" : "pt-3",
              )}
            >
              {group.label}
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
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {warn ? (
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-warning-soft px-[5px] text-2xs leading-none font-semibold text-warning tabular-nums">
                      {entry.key === "sources" ? attention : count}
                    </span>
                  ) : (
                    <span
                      className={cn("text-xs tabular-nums", selected ? "text-fg" : "text-fg-3")}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <AnalysisCard items={items} queue={queue} onAnalyzeAll={onAnalyzeAll} />
    </>
  );
}

export type { NavKey };
