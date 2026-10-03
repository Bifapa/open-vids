import {
  CircleNotch,
  File,
  FilmStrip,
  ImageSquare,
  MusicNote,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useAgentStore } from "../../agent/agentContext";
import { NEW_CHAT_DRAFT } from "../../agent/agentStore";
import type { AttachmentKind, ComposerAttachment } from "../../agent/composerAttachments";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";

const KIND_ICONS: Record<AttachmentKind, typeof File> = {
  image: ImageSquare,
  video: FilmStrip,
  audio: MusicNote,
  file: File,
};

const NO_ATTACHMENTS: readonly ComposerAttachment[] = [];

/** The files attached to the draft being written (the open chat's, or the new-chat draft's). */
export function useDraftAttachments(): readonly ComposerAttachment[] {
  return useAgentStore(
    (state) => state.attachments[state.chatId ?? NEW_CHAT_DRAFT] ?? NO_ATTACHMENTS,
  );
}

/**
 * The files the next message carries, above the prompt: kind icon + name, a spinner while the file is being imported
 * into the project, an error mark when that failed (the message goes without it), × removes it.
 */
export function AttachmentChips({ onRemoved }: { onRemoved: () => void }) {
  const { t } = useTranslation();
  const attachments = useDraftAttachments();
  const removeAttachment = useAgentStore((state) => state.removeAttachment);
  const draftKey = useAgentStore((state) => state.chatId ?? NEW_CHAT_DRAFT);
  if (attachments.length === 0) return null;
  return (
    <div
      role="list"
      aria-label={t("chat.attach.label")}
      data-testid="composer-attachments"
      className="flex min-w-0 flex-wrap gap-1 px-1.5 pt-1.5"
    >
      {attachments.map((attachment) => {
        const Icon = KIND_ICONS[attachment.kind];
        const failed = attachment.status === "failed";
        const uploading = attachment.status === "uploading";
        return (
          <span
            key={attachment.id}
            role="listitem"
            data-status={attachment.status}
            title={
              failed
                ? t("chat.attach.failedTitle", { name: attachment.name })
                : (attachment.path ?? attachment.name)
            }
            className={cn(
              "inline-flex h-ctl-sm max-w-full min-w-0 items-center gap-[5px] rounded-sm border bg-surface-1 pr-px pl-1.5 text-xs leading-none font-medium hover:border-border-strong",
              failed ? "border-error/40 text-error" : "border-border text-fg-2 hover:text-fg",
            )}
          >
            {uploading ? (
              <CircleNotch
                size={12}
                aria-hidden
                className="shrink-0 animate-spin text-fg-3 motion-reduce:animate-none"
              />
            ) : failed ? (
              <WarningCircle size={12} weight="fill" aria-hidden className="shrink-0" />
            ) : (
              <Icon size={12} aria-hidden className="shrink-0 text-fg-3" />
            )}
            <span className="max-w-[22ch] min-w-0 truncate">{attachment.name}</span>
            {uploading && <span className="sr-only">{t("chat.attach.uploading")}</span>}
            {failed && <span className="sr-only">{t("chat.attach.failed")}</span>}
            <button
              type="button"
              aria-label={t("chat.attach.remove", { name: attachment.name })}
              onClick={() => {
                removeAttachment(draftKey, attachment.id);
                onRemoved();
              }}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-fg-3 outline-hidden hover:bg-surface-2 hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <X size={10} weight="bold" aria-hidden />
            </button>
          </span>
        );
      })}
    </div>
  );
}
