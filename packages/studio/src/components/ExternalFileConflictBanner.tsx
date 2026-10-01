import { useRef, useState, type ReactNode } from "react";
import { Copy, DownloadSimple, File, PencilSimple, X } from "@phosphor-icons/react";
import type {
  ExternalFileChangeBlockedState,
  ExternalFileChangeCoordinatorHandle,
} from "../hooks/useExternalFileChangeCoordinator";
import { StudioBanner } from "./StudioBanner";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { useDialogBehavior } from "./ui/useDialogBehavior";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function downloadText(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/html;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The prototype's diff dialog chrome (`.float.diff-dlg`): head, note, body. */
function ReviewDialog({
  titleId,
  title,
  note,
  wide,
  onClose,
  children,
}: {
  titleId: string;
  title: string;
  note: string;
  wide: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useDialogBehavior({ open: true, onClose, containerRef });
  return (
    <div
      className="hf-backdrop-in fixed inset-0 z-110 flex items-center justify-center bg-scrim px-6 py-12"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-bg-1 text-sm text-fg shadow-pop outline-hidden ${
          wide ? "max-w-[880px]" : "max-w-[640px]"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-head shrink-0 items-center gap-1.5 border-b border-border-subtle pl-3 pr-1">
          <h2 id={titleId} className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">
            {title}
          </h2>
          <IconButton
            size="sm"
            aria-label="Close"
            onClick={onClose}
            icon={<X size={12} aria-hidden />}
          />
        </div>
        <p className="mx-3 mb-2.5 mt-3 text-sm leading-[17px] text-fg-2 text-pretty">{note}</p>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">{children}</div>
      </div>
    </div>
  );
}

/** One side of the review: a labelled read-only source with its own Copy and Download. */
function VersionColumn({
  title,
  icon,
  content,
  filename,
}: {
  title: string;
  icon: ReactNode;
  content: string;
  filename: string;
}) {
  return (
    <section
      aria-label={title}
      className="min-w-0 overflow-hidden rounded-md border border-border-subtle bg-bg-0"
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-border-subtle bg-bg-1 pl-2.5 pr-1 text-xs font-semibold text-fg-2">
        <span className="text-fg-3">{icon}</span>
        <h3 className="m-0 min-w-0 flex-1 truncate text-xs font-semibold">{title}</h3>
        <Button
          size="xs"
          variant="ghost"
          icon={<Copy size={12} aria-hidden />}
          onClick={() => void navigator.clipboard.writeText(content)}
        >
          Copy
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<DownloadSimple size={12} aria-hidden />}
          onClick={() => downloadText(filename, content)}
        >
          Download
        </Button>
      </div>
      <textarea
        readOnly
        value={content}
        className="block h-80 w-full resize-y border-0 bg-transparent px-2.5 py-1.5 font-mono text-num leading-[18px] text-fg-2 outline-hidden"
      />
    </section>
  );
}

function ConflictReview({
  conflict,
  onClose,
}: {
  conflict: Extract<ExternalFileChangeBlockedState, { status: "conflict" }>;
  onClose: () => void;
}) {
  const path = conflict.error.filePath;
  return (
    <ReviewDialog
      titleId="external-conflict-title"
      title={`Review both versions of ${path}`}
      note="Reviewing or exporting does not change either version."
      wide
      onClose={onClose}
    >
      <div className="grid gap-2 md:grid-cols-2">
        <VersionColumn
          title="File on disk"
          icon={<File size={12} aria-hidden />}
          content={conflict.error.currentContent ?? "(The server did not return file contents.)"}
          filename={`${path}.external.html`}
        />
        <VersionColumn
          title="Unsaved Studio version"
          icon={<PencilSimple size={12} aria-hidden />}
          content={conflict.error.attemptedContent}
          filename={`${path}.studio.html`}
        />
      </div>
    </ReviewDialog>
  );
}

export function ExternalFileConflictBanner({
  coordinator,
}: {
  coordinator: ExternalFileChangeCoordinatorHandle;
}) {
  const [reviewing, setReviewing] = useState(false);
  const blocked = coordinator.blocked;
  if (!blocked) return null;

  const conflict = blocked.status === "conflict" ? blocked : null;
  const failure = blocked.status === "failed" ? blocked : null;
  const overwrite = (message: string) => {
    if (window.confirm(message)) void coordinator.keepStudioFile();
  };
  return (
    <>
      <StudioBanner
        tone={conflict ? "warn" : "err"}
        zIndex="z-94"
        actions={
          <>
            {conflict && (
              <Button size="sm" onClick={() => setReviewing(true)}>
                Review or export both
              </Button>
            )}
            {failure?.studioContent != null && (
              <Button size="sm" onClick={() => setReviewing(true)}>
                Review or export Studio draft
              </Button>
            )}
            {failure && !failure.recovered && failure.studioContent != null && (
              <Button size="sm" onClick={() => void coordinator.retry()}>
                Retry save
              </Button>
            )}
            <Button size="sm" onClick={() => void coordinator.useExternalFile()}>
              Discard Studio edits and reload file
            </Button>
            {conflict && (
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  overwrite(
                    "Overwrite the externally changed file with the Studio version? The server will preserve its normal backup before writing.",
                  )
                }
              >
                Overwrite file with Studio version
              </Button>
            )}
            {failure?.recovered && failure.studioContent != null && (
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  overwrite(
                    "Overwrite the file with the recovered Studio draft? The current file will be preserved by the server's normal backup before writing.",
                  )
                }
              >
                Overwrite file with recovered Studio draft
              </Button>
            )}
          </>
        }
      >
        {conflict ? (
          <>
            <strong>{conflict.error.filePath}</strong> changed on disk while you have unsaved edits.
            Preview is paused so neither version is lost.
          </>
        ) : (
          `Studio could not safely finish local saves: ${errorMessage(blocked.error)}. Preview is paused.`
        )}
      </StudioBanner>
      {reviewing && conflict && (
        <ConflictReview conflict={conflict} onClose={() => setReviewing(false)} />
      )}
      {reviewing && failure?.studioContent != null && (
        <ReviewDialog
          titleId="failed-draft-title"
          title={`Recover unsaved Studio draft for ${failure.path}`}
          note="Copy or download this draft before choosing to discard it."
          wide={false}
          onClose={() => setReviewing(false)}
        >
          <VersionColumn
            title="Unsaved Studio draft"
            icon={<PencilSimple size={12} aria-hidden />}
            content={failure.studioContent}
            filename={`${failure.path}.studio.html`}
          />
        </ReviewDialog>
      )}
    </>
  );
}
