import { useRef, useState, type ReactNode } from "react";
import { Copy, DownloadSimple, File, PencilSimple, X } from "@phosphor-icons/react";
import type {
  ExternalFileChangeBlockedState,
  ExternalFileChangeCoordinatorHandle,
} from "../hooks/useExternalFileChangeCoordinator";
import { Trans, useTranslation } from "../i18n";
import { StudioBanner } from "./StudioBanner";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
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
  const { t } = useTranslation();
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
            aria-label={t("common.close")}
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
  const { t } = useTranslation();
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
          {t("common.copy")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<DownloadSimple size={12} aria-hidden />}
          onClick={() => downloadText(filename, content)}
        >
          {t("common.download")}
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
  const { t } = useTranslation();
  const path = conflict.error.filePath;
  return (
    <ReviewDialog
      titleId="external-conflict-title"
      title={t("shell.fileConflict.reviewTitle", { path })}
      note={t("shell.fileConflict.reviewNote")}
      wide
      onClose={onClose}
    >
      <div className="grid gap-2 md:grid-cols-2">
        <VersionColumn
          title={t("shell.fileConflict.fileOnDisk")}
          icon={<File size={12} aria-hidden />}
          content={conflict.error.currentContent ?? t("shell.fileConflict.noContents")}
          filename={`${path}.external.html`}
        />
        <VersionColumn
          title={t("shell.fileConflict.unsavedVersion")}
          icon={<PencilSimple size={12} aria-hidden />}
          content={conflict.error.attemptedContent}
          filename={`${path}.studio.html`}
        />
      </div>
    </ReviewDialog>
  );
}

/**
 * The "are you sure" in front of writing Studio's version over the file on disk. An in-app dialog, not
 * `window.confirm`: the desktop shell's web view has no native confirm panel and answers every one with "cancel".
 */
function OverwriteConfirm({
  message,
  onCancel,
  onConfirm,
}: {
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onClose={onCancel}
      title={t("shell.fileConflict.confirmTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {t("shell.fileConflict.confirmAction")}
          </Button>
        </>
      }
    >
      <p className="m-0 text-sm leading-[17px] text-fg-2 text-pretty">{message}</p>
    </Dialog>
  );
}

export function ExternalFileConflictBanner({
  coordinator,
}: {
  coordinator: ExternalFileChangeCoordinatorHandle;
}) {
  const { t } = useTranslation();
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState<{ generation: number; draft: boolean } | null>(null);
  const blocked = coordinator.blocked;
  if (!blocked) return null;

  const conflict = blocked.status === "conflict" ? blocked : null;
  const failure = blocked.status === "failed" ? blocked : null;
  const pendingOverwrite = confirming?.generation === blocked.generation ? confirming : null;
  const askOverwrite = (draft: boolean) => setConfirming({ generation: blocked.generation, draft });
  return (
    <>
      <StudioBanner
        tone={conflict ? "warn" : "err"}
        zIndex="z-94"
        actions={
          <>
            {conflict && (
              <Button size="sm" onClick={() => setReviewing(true)}>
                {t("shell.fileConflict.reviewBoth")}
              </Button>
            )}
            {failure?.studioContent != null && (
              <Button size="sm" onClick={() => setReviewing(true)}>
                {t("shell.fileConflict.reviewDraft")}
              </Button>
            )}
            {failure && !failure.recovered && failure.studioContent != null && (
              <Button size="sm" onClick={() => void coordinator.retry()}>
                {t("shell.fileConflict.retrySave")}
              </Button>
            )}
            <Button size="sm" onClick={() => void coordinator.useExternalFile()}>
              {t("shell.fileConflict.discard")}
            </Button>
            {conflict && (
              <Button size="sm" variant="danger" onClick={() => askOverwrite(false)}>
                {t("shell.fileConflict.overwrite")}
              </Button>
            )}
            {failure?.recovered && failure.studioContent != null && (
              <Button size="sm" variant="danger" onClick={() => askOverwrite(true)}>
                {t("shell.fileConflict.overwriteDraft")}
              </Button>
            )}
          </>
        }
      >
        {conflict ? (
          <Trans
            i18nKey="shell.fileConflict.changed"
            values={{ path: conflict.error.filePath }}
            components={{ b: <strong /> }}
          />
        ) : (
          t("shell.fileConflict.failed", { error: errorMessage(blocked.error) })
        )}
      </StudioBanner>
      {reviewing && conflict && (
        <ConflictReview conflict={conflict} onClose={() => setReviewing(false)} />
      )}
      {reviewing && failure?.studioContent != null && (
        <ReviewDialog
          titleId="failed-draft-title"
          title={t("shell.fileConflict.recoverTitle", { path: failure.path })}
          note={t("shell.fileConflict.recoverNote")}
          wide={false}
          onClose={() => setReviewing(false)}
        >
          <VersionColumn
            title={t("shell.fileConflict.unsavedDraft")}
            icon={<PencilSimple size={12} aria-hidden />}
            content={failure.studioContent}
            filename={`${failure.path}.studio.html`}
          />
        </ReviewDialog>
      )}
      {pendingOverwrite && (
        <OverwriteConfirm
          message={
            pendingOverwrite.draft
              ? t("shell.fileConflict.confirmOverwriteDraft")
              : t("shell.fileConflict.confirmOverwrite")
          }
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void coordinator.keepStudioFile();
          }}
        />
      )}
    </>
  );
}
