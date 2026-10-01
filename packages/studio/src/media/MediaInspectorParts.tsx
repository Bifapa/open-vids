import { useState, type ReactNode, type RefObject } from "react";
import {
  CaretDown,
  Eye,
  FilmStrip,
  Pause,
  Play,
  Scissors,
  SpeakerSimpleSlash,
  Subtitles,
  Users,
} from "@phosphor-icons/react";
import type { AnalysisStage, StageState } from "@hyperframes/agent-protocol";
import { StatusDot, cn, type StatusDotTone } from "../components/ui";
import { resolveMediaPreviewUrl } from "../player/components/thumbnailUtils";
import { fontFamilyFromAssetPath } from "../components/editor/fontAssets";
import { MediaThumb } from "./MediaTiles";
import { clock, stageOf, type MediaItem } from "./mediaLibrary";
import type { AssetAnalysis } from "./useAssetAnalysis";

export function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border-subtle">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-[30px] w-full items-center gap-1 pr-2.5 pl-2 text-left text-sm leading-4 font-semibold text-fg outline-hidden hover:bg-surface-1 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <CaretDown
          className={cn("size-icon-sm text-fg-3 transition-transform", !open && "-rotate-90")}
        />
        {title}
      </button>
      {open && <div className="grid gap-1.5 px-3 pt-0.5 pb-3">{children}</div>}
    </section>
  );
}

type KvRow = readonly [label: string, value: ReactNode, style?: "mono" | "wrap"];

export function Kv({ rows }: { rows: ReadonlyArray<KvRow | null> }) {
  return (
    <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-sm">
      {rows.flatMap((row) =>
        row
          ? [
              <dt key={`${row[0]}-t`} className="text-fg-3">
                {row[0]}
              </dt>,
              <dd
                key={`${row[0]}-d`}
                className={cn(
                  "m-0 truncate text-fg tabular-nums",
                  row[2] === "mono" && "font-mono text-num leading-4 text-fg-2",
                  row[2] && "break-all whitespace-normal",
                )}
              >
                {row[1]}
              </dd>,
            ]
          : [],
      )}
    </dl>
  );
}

/** Preview of the selected asset: playable video/audio with a scrub bar marking shots and long pauses. */
export function MediaPreview({
  item,
  projectId,
  mediaRef,
  time,
  playing,
  onTime,
  onSeek,
  onPlayingChange,
  onTogglePlay,
  analysis,
}: {
  item: MediaItem;
  projectId: string;
  mediaRef: RefObject<HTMLVideoElement | null>;
  time: number;
  playing: boolean;
  onTime: (time: number) => void;
  onSeek: (time: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onTogglePlay: () => void;
  analysis: AssetAnalysis;
}) {
  const url = resolveMediaPreviewUrl(item.path, projectId);
  const timed = (item.kind === "video" || item.kind === "audio") && !item.offline;
  const duration = item.duration ?? 0;
  const pct = (seconds: number) => `${duration > 0 ? (seconds / duration) * 100 : 0}%`;
  let picture: ReactNode;
  if (item.kind === "font" && !item.offline) {
    picture = (
      <div
        className="flex aspect-video flex-col items-center justify-center gap-2 bg-surface-1 px-3 text-center text-fg"
        style={{ fontFamily: `"${fontFamilyFromAssetPath(item.path)}", var(--font-ui)` }}
      >
        <span className="text-[48px] leading-none font-medium">Aa</span>
        <span className="text-md text-fg-2">The quick brown fox jumps over the lazy dog</span>
      </div>
    );
  } else if (timed) {
    picture = (
      <div className="relative flex aspect-video items-center justify-center bg-stage">
        {/* A still frame until the clip has played or been scrubbed: a metadata-only video paints nothing. */}
        {(item.kind === "audio" || (!playing && time === 0)) && (
          <MediaThumb item={item} projectId={projectId} className="absolute inset-0 rounded-none" />
        )}
        <video
          ref={mediaRef}
          src={url}
          preload="metadata"
          playsInline
          className={cn(
            "absolute inset-0 size-full object-contain",
            (item.kind === "audio" || (!playing && time === 0)) && "opacity-0",
          )}
          onTimeUpdate={(event) => onTime(event.currentTarget.currentTime)}
          onPlay={() => onPlayingChange(true)}
          onPause={() => onPlayingChange(false)}
          onEnded={() => onPlayingChange(false)}
        />
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={onTogglePlay}
          className="absolute bottom-2 left-2 inline-flex size-ctl items-center justify-center rounded-full bg-on-media-bg text-on-media focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {playing ? (
            <Pause className="size-icon-md" weight="fill" />
          ) : (
            <Play className="size-icon-md" weight="fill" />
          )}
        </button>
      </div>
    );
  } else {
    picture = <MediaThumb item={item} projectId={projectId} glyph={20} className="rounded-none" />;
  }
  return (
    <div
      className="relative mx-3 mt-2.5 overflow-hidden rounded-md border border-border-subtle bg-stage"
      data-testid="media-inspector-preview"
    >
      {picture}
      {timed && duration > 0 && (
        <div className="flex h-[26px] items-center gap-2 border-t border-border-subtle bg-bg-1 px-2 font-mono text-num text-fg-3">
          <span className="text-fg">{clock(time)}</span>
          <div
            className="relative h-3 flex-1 cursor-pointer before:absolute before:inset-x-0 before:top-[5px] before:h-0.5 before:rounded-[1px] before:bg-surface-3"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              onSeek(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * duration);
            }}
          >
            {analysis.shots.slice(1).map((shot) => (
              <i
                key={shot.id}
                className="absolute top-[3px] h-1.5 w-px bg-fg-3"
                style={{ left: pct(shot.start) }}
              />
            ))}
            {(analysis.overview?.silence?.longest ?? []).map((gap) => (
              <i
                key={`${gap.start}`}
                className="absolute top-1 h-1 bg-bg-1"
                style={{ left: pct(gap.start), width: pct(gap.end - gap.start) }}
              />
            ))}
            <i
              className="absolute top-0 -ml-px h-3 w-0.5 rounded-[1px] bg-fg"
              style={{ left: pct(time) }}
            />
          </div>
          <span>{clock(duration)}</span>
        </div>
      )}
    </div>
  );
}

const STAGE_ROWS: ReadonlyArray<{ stage: AnalysisStage; label: string; icon: ReactNode }> = [
  { stage: "transcript", label: "Transcript", icon: <Subtitles className="size-icon-sm" /> },
  { stage: "speakers", label: "Speakers", icon: <Users className="size-icon-sm" /> },
  { stage: "silence", label: "Silence", icon: <SpeakerSimpleSlash className="size-icon-sm" /> },
  { stage: "takes", label: "Take Issues", icon: <Scissors className="size-icon-sm" /> },
  { stage: "vision", label: "Vision", icon: <Eye className="size-icon-sm" /> },
  { stage: "shots", label: "Scene map", icon: <FilmStrip className="size-icon-sm" /> },
];

const STATUS_LOOK: Record<StageState["status"], { tone: StatusDotTone; text: string }> = {
  fresh: { tone: "ok", text: "Ready" },
  running: { tone: "running", text: "Running" },
  missing: { tone: "off", text: "Not analyzed" },
  stale: { tone: "warn", text: "Outdated" },
  failed: { tone: "error", text: "Failed" },
  unavailable: { tone: "off", text: "Unavailable" },
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function stageDetail(stage: AnalysisStage, analysis: AssetAnalysis): string | null {
  const overview = analysis.overview;
  if (!overview) return null;
  switch (stage) {
    case "transcript":
      return overview.transcript?.language?.toUpperCase() ?? null;
    case "speakers":
      return overview.speakers
        ? plural(overview.speakers.speakers.length, "speaker", "speakers")
        : null;
    case "silence":
      return overview.silence
        ? `${plural(overview.silence.count, "pause", "pauses")} · ${overview.silence.totalSeconds.toFixed(1)} s`
        : null;
    case "takes": {
      if (!overview.takes) return null;
      const found = Object.values(overview.takes.counts).reduce((sum, n) => sum + (n ?? 0), 0);
      return found ? `${found} found` : "None found";
    }
    case "vision":
      return overview.vision ? plural(overview.vision.notes.length, "note", "notes") : null;
    case "shots":
      return overview.shots ? plural(overview.shots.count, "shot", "shots") : null;
    case "segments":
      return null;
  }
}

/** Vision tags are a glance, not an index: the search reaches every tag. */
const MAX_TAGS = 12;

export function AnalysisRows({ item, analysis }: { item: MediaItem; analysis: AssetAnalysis }) {
  const tags = [...new Set((analysis.overview?.vision?.notes ?? []).flatMap((note) => note.tags))];
  return (
    <>
      <div className="grid gap-0.5" data-testid="media-analysis">
        {STAGE_ROWS.map((row) => {
          const state = stageOf(item, row.stage);
          if (!state) return null;
          const look = STATUS_LOOK[state.status];
          const detail = state.status === "fresh" ? stageDetail(row.stage, analysis) : null;
          return (
            <div
              key={row.stage}
              className="grid min-h-ctl-sm grid-cols-[16px_1fr_auto] items-center gap-2 text-sm text-fg"
            >
              <span className="text-fg-3">{row.icon}</span>
              <span>{row.label}</span>
              <span
                title={state.detail ?? undefined}
                className={cn(
                  "inline-flex min-w-0 items-center gap-[5px] text-xs text-fg-3",
                  state.status === "fresh" && "text-fg-2",
                )}
              >
                <StatusDot tone={look.tone} />
                {detail ? `${look.text} · ${detail}` : look.text}
              </span>
            </div>
          );
        })}
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {tags.slice(0, MAX_TAGS).map((tag) => (
            <span
              key={tag}
              className="inline-flex h-5 items-center rounded-sm bg-surface-2 px-1.5 text-xs text-fg-2"
            >
              {tag.replaceAll("_", " ")}
            </span>
          ))}
          {tags.length > MAX_TAGS && (
            <span className="inline-flex h-5 items-center px-1 text-xs text-fg-3">
              +{tags.length - MAX_TAGS} more
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** Rows of `start – label` that seek the preview: scenes (segments) and take issues. */
export function TimedList({
  rows,
  time,
  onSeek,
}: {
  rows: ReadonlyArray<{ id: string; start: number; end: number; body: ReactNode }>;
  time: number;
  onSeek: (time: number) => void;
}) {
  return (
    <div className="-mx-1 grid gap-px">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          aria-current={time >= row.start && time < row.end}
          onClick={() => onSeek(row.start)}
          className="grid min-h-ctl-sm grid-cols-[76px_1fr] items-baseline gap-2 rounded-sm px-1 py-[3px] text-left text-sm leading-4 text-fg outline-hidden hover:bg-surface-1 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent aria-[current=true]:bg-surface-2"
        >
          <span className="font-mono text-num leading-4 text-fg-3">
            {clock(row.start)}–{clock(row.end)}
          </span>
          <span className="min-w-0">{row.body}</span>
        </button>
      ))}
    </div>
  );
}

export function TranscriptList({
  analysis,
  onSeek,
}: {
  analysis: AssetAnalysis;
  onSeek: (time: number) => void;
}) {
  const speakers = (analysis.overview?.speakers?.speakers.length ?? 0) > 1;
  return (
    <div className="grid gap-1.5" data-testid="media-transcript">
      {analysis.sentences.map((sentence) => (
        <button
          key={sentence.id}
          type="button"
          onClick={() => onSeek(sentence.start)}
          className={cn(
            "grid gap-2 rounded-sm text-left text-sm leading-[17px] text-fg outline-hidden hover:bg-surface-1 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
            speakers ? "grid-cols-[40px_24px_1fr]" : "grid-cols-[40px_1fr]",
          )}
        >
          <span className="font-mono text-num leading-[17px] text-fg-3">
            {clock(sentence.start)}
          </span>
          {speakers && (
            <span
              title={sentence.speaker ? `Speaker ${sentence.speaker.slice(1)}` : undefined}
              className="inline-flex h-[17px] items-center justify-center self-start rounded-xs bg-surface-2 font-mono text-num leading-none font-medium text-fg-2"
            >
              {sentence.speaker ?? "–"}
            </span>
          )}
          <span>{sentence.text}</span>
        </button>
      ))}
    </div>
  );
}
