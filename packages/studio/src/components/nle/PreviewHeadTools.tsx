import { Camera } from "@phosphor-icons/react";
import { useStudioShellContextOptional, type StudioShellValue } from "../../contexts/StudioContext";
import { useFrameCapture } from "../../hooks/useFrameCapture";
import { STUDIO_PREVIEW_FPS } from "../../player/lib/time";
import { SnapToolbar } from "../editor/SnapToolbar";
import { Spinner, Tooltip, buttonBase, buttonVariants, cn } from "../ui";

/** "compositions/intro.html" → "intro". */
function compositionName(path: string | null): string {
  if (!path) return "index";
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.html?$/i, "") || file;
}

/**
 * The viewer's side of the preview group's head (the dock strip draws it):
 * `Name · W × H · fps`, the guides and snapping tools, and frame capture.
 */
export function PreviewHeadTools() {
  const shell = useStudioShellContextOptional();
  if (!shell) return null;
  const dims = shell.compositionDimensions;
  const name = compositionName(shell.activeCompPath);
  const meta = dims ? `${name} · ${dims.width} × ${dims.height} · ${STUDIO_PREVIEW_FPS} fps` : name;
  return (
    <div className="flex min-w-0 items-center gap-0.5" data-testid="preview-head-tools">
      <span
        className="min-w-0 truncate pr-1.5 font-mono text-xs tabular-nums text-fg-3"
        title={meta}
      >
        {meta}
      </span>
      <SnapToolbar />
      <CaptureFrameButton shell={shell} />
    </div>
  );
}

function CaptureFrameButton({ shell }: { shell: StudioShellValue }) {
  const {
    captureFrameHref,
    captureFrameFilename,
    handleCaptureFrameClick,
    refreshCaptureFrameTime,
    capturing,
  } = useFrameCapture({
    projectId: shell.projectId,
    activeCompPath: shell.activeCompPath,
    showToast: shell.showToast,
    waitForPendingDomEditSaves: shell.waitForPendingDomEditSaves,
  });
  return (
    <Tooltip label={capturing ? "Capturing frame…" : "Capture frame as PNG"}>
      {/* A real download link: `download` on an <a> is what saves the frame,
          so it wears IconButton's recipe rather than being one. */}
      <a
        href={captureFrameHref}
        download={captureFrameFilename}
        onClick={(e) => {
          if (capturing) {
            e.preventDefault();
            return;
          }
          void handleCaptureFrameClick(e);
        }}
        onFocus={refreshCaptureFrameTime}
        onPointerDown={refreshCaptureFrameTime}
        aria-disabled={capturing || undefined}
        aria-label={capturing ? "Capturing frame" : "Capture current frame"}
        className={cn(
          buttonBase,
          buttonVariants.ghost,
          "size-ctl-sm shrink-0 rounded-sm p-0",
          capturing ? "cursor-default text-fg-disabled" : "hover:bg-surface-2 hover:text-fg",
        )}
      >
        {capturing ? <Spinner size="sm" /> : <Camera size={14} aria-hidden="true" />}
      </a>
    </Tooltip>
  );
}
