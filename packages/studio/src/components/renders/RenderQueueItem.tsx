import { buildProjectApiPath } from "../../utils/projectRouting";
import { memo, useState } from "react";
import {
  ArrowSquareOut,
  DotsThree,
  DownloadSimple,
  FilmStrip,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { VideoFrameThumbnail } from "../ui/VideoFrameThumbnail";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { Meter, Spinner } from "../ui/Status";
import { cn } from "../ui/cn";
import type { RenderJob } from "./useRenderQueue";

export function formatRenderDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

const FORMAT_LABEL: Record<string, string> = {
  mp4: "MP4 · H.264",
  mov: "MOV · ProRes 4444",
  webm: "WebM · VP9",
};

/** The running job: spinner, stage, percent and a thin meter, with Cancel beside it. */
export const RenderJobStatus = memo(function RenderJobStatus({
  job,
  onCancel,
}: {
  job: RenderJob;
  onCancel: () => void;
}) {
  return (
    <div className="mt-2.5 grid gap-2 rounded-md border border-border-subtle bg-bg-1 px-2.5 py-2">
      <div className="flex min-h-[18px] items-center gap-2">
        <Spinner />
        <b className="min-w-0 flex-1 truncate font-semibold text-fg">{job.stage || "Rendering"}</b>
        <span className="font-mono text-num text-fg-2">{job.progress}%</span>
      </div>
      <Meter value={job.progress / 100} label={`Render progress: ${job.progress}%`} />
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-num text-fg-3">{job.filename}</span>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel Render
        </Button>
      </div>
    </div>
  );
});

interface RenderQueueItemProps {
  job: RenderJob;
  projectId: string;
  onDelete: () => void;
}

/** One finished, failed or cancelled render in Recent Renders. */
export const RenderQueueItem = memo(function RenderQueueItem({
  job,
  projectId,
  onDelete,
}: RenderQueueItemProps) {
  const [hovered, setHovered] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Direct file URL — serves from disk, survives server restarts
  const fileSrc = buildProjectApiPath(projectId, `/renders/file/${job.filename}`);
  const isComplete = job.status === "complete";
  const extension = job.filename.split(".").pop()?.toLowerCase() ?? "";
  const meta = [FORMAT_LABEL[extension] ?? extension.toUpperCase()];
  if (job.durationMs) meta.push(`${formatRenderDuration(job.durationMs)} render`);
  meta.push(formatTimeAgo(job.createdAt));

  const open = () => window.open(fileSrc, "_blank");
  const download = () => {
    const a = document.createElement("a");
    a.href = fileSrc;
    a.download = job.filename;
    a.click();
  };

  return (
    <li
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false);
        setVideoReady(false);
      }}
      className={cn(
        "flex min-h-row-lg items-center gap-2 rounded-md border border-transparent py-[3px] pl-1.5 pr-1",
        confirmingDelete
          ? "border-error/35 bg-error-soft"
          : "hover:border-border-subtle hover:bg-surface-1 focus-within:border-border-subtle focus-within:bg-surface-1",
      )}
    >
      {/* Static frame that swaps to the live render on hover. A real button so
          keyboard users can open the render too. */}
      <button
        type="button"
        onClick={isComplete ? open : undefined}
        disabled={!isComplete}
        aria-label={isComplete ? `Open ${job.filename} in a new tab` : undefined}
        className={cn(
          "relative flex h-6 w-10 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface-1 text-fg-3 shadow-[inset_0_0_0_1px_var(--color-border-subtle)]",
          "outline-hidden focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
          isComplete ? "cursor-pointer" : "cursor-default",
        )}
      >
        {isComplete ? (
          <>
            {hovered && (
              <video
                src={fileSrc}
                autoPlay
                muted
                loop
                playsInline
                onCanPlay={() => setVideoReady(true)}
                className="absolute inset-0 h-full w-full object-cover transition-opacity duration-150"
                style={{ opacity: videoReady ? 1 : 0 }}
              />
            )}
            <div
              className="absolute inset-0 transition-opacity duration-150"
              style={{ opacity: hovered && videoReady ? 0 : 1 }}
            >
              <VideoFrameThumbnail src={fileSrc} />
            </div>
          </>
        ) : job.status === "failed" ? (
          <WarningCircle size={12} className="text-error" aria-hidden />
        ) : (
          <FilmStrip size={12} aria-hidden />
        )}
      </button>

      <div className="grid min-w-0 flex-1 gap-px">
        <b className="truncate text-sm font-medium leading-4 text-fg">{job.filename}</b>
        {confirmingDelete ? (
          <span className="truncate text-xs leading-[14px] text-error">
            Delete this file from disk?
          </span>
        ) : job.status === "failed" ? (
          <span className="truncate text-xs leading-[14px] text-error" title={job.error}>
            {job.error ? `Failed: ${job.error}` : "Failed"}
          </span>
        ) : (
          <span className="truncate text-xs leading-[14px] text-fg-3">
            {job.status === "cancelled" ? "Cancelled · " : ""}
            {meta.join(" · ")}
          </span>
        )}
      </div>

      {confirmingDelete ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="ghost" onClick={() => setConfirmingDelete(false)}>
            Keep
          </Button>
          <Button
            size="xs"
            variant="danger"
            onClick={() => {
              setConfirmingDelete(false);
              onDelete();
            }}
          >
            Delete
          </Button>
        </span>
      ) : (
        <Menu
          side="bottom"
          align="end"
          aria-label={`${job.filename} actions`}
          trigger={
            <IconButton
              size="xs"
              aria-label={`Actions for ${job.filename}`}
              icon={<DotsThree size={14} weight="bold" aria-hidden />}
              className="text-fg-3 hover:bg-surface-3 hover:text-fg"
            />
          }
        >
          <MenuItem
            icon={<ArrowSquareOut size={14} aria-hidden />}
            disabled={!isComplete}
            onClick={open}
          >
            Open
          </MenuItem>
          <MenuItem
            icon={<DownloadSimple size={14} aria-hidden />}
            disabled={!isComplete}
            onClick={download}
          >
            Download
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Trash size={14} aria-hidden />}
            tone="danger"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete…
          </MenuItem>
        </Menu>
      )}
    </li>
  );
});
