import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Paperclip } from "@phosphor-icons/react";
import { useAgentStore, useAgentStoreApi } from "../../agent/agentContext";
import { hasFileDrag, hasProjectFileDrag } from "../../agent/composerAttachments";
import { attachDrop } from "../../agent/composerDrop";
import { useFileManagerContextOptional } from "../../contexts/FileManagerContext";
import { useTranslation } from "../../i18n";

/**
 * Everything dropped on the Chat panel stays in the chat. OS files are imported into the project and appear as chips
 * in the composer; a Media tile or file tree row attaches the project file it names, with no upload. Each drop is
 * claimed (`preventDefault`), so Studio's global drop handler never also puts the file on the timeline.
 */
export function ChatDropZone({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const store = useAgentStoreApi();
  const files = useFileManagerContextOptional();
  const availability = useAgentStore((state) => state.availability);
  const projectFiles = useMemo(() => new Set(files?.fileTree ?? []), [files?.fileTree]);
  // dragenter/dragleave fire for every child the pointer crosses: the overlay lives while the depth is positive.
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  const accepts = (event: DragEvent) =>
    hasFileDrag(event.dataTransfer) || hasProjectFileDrag(event.dataTransfer);

  const onDragEnter = (event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    depth.current += 1;
    setOver(true);
  };

  const onDragOver = (event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    // A file tree row is dragged with the "move" effect: a drop is only allowed with the effect the source offers.
    event.dataTransfer.dropEffect = event.dataTransfer.effectAllowed === "move" ? "move" : "copy";
  };

  const onDragLeave = (event: DragEvent) => {
    if (!accepts(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };

  const onDrop = (event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    if (availability !== "ready") return;
    const upload = files?.uploadProjectFiles;
    attachDrop(store, event.dataTransfer, {
      upload: upload ? (dropped) => upload(dropped) : () => Promise.resolve([]),
      projectFiles,
    });
  };

  return (
    <div
      data-chat-drop-zone
      className="relative h-full min-h-0"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {over && (
        <div
          data-testid="chat-drop-overlay"
          className="pointer-events-none absolute inset-1 z-40 flex flex-col items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-dashed border-accent bg-accent-soft px-4 text-center text-sm font-medium text-fg"
        >
          <Paperclip size={18} aria-hidden />
          {t("chat.attach.dropHint")}
        </div>
      )}
    </div>
  );
}
