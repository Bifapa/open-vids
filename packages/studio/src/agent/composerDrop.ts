import type { AgentStore } from "./agentStore";
import { NEW_CHAT_DRAFT } from "./agentDraftChat";
import {
  projectAttachment,
  readDroppedProjectFile,
  uploadingAttachment,
} from "./composerAttachments";

export interface ComposerDropDeps {
  /** Imports OS files into the project (`useFileManager.uploadProjectFiles`); the paths that landed, none on failure. */
  upload: (files: File[]) => Promise<string[]>;
  /** The project's files: what a plain-text drag has to name to count as one. */
  projectFiles: ReadonlySet<string>;
}

/**
 * Attaches what was dropped on the chat to the draft being written: OS files become chips that upload (ready with
 * their project path, or failed), a Media tile or file tree row becomes a ready chip at once. The history list has no
 * composer, so a drop there starts the new-chat draft.
 */
export function attachDrop(
  store: AgentStore,
  dataTransfer: Pick<DataTransfer, "files" | "getData">,
  deps: ComposerDropDeps,
): void {
  if (store.getState().view === "history") store.getState().startDraft();
  const { chatId, addAttachments, patchAttachment } = store.getState();
  const draftKey = chatId ?? NEW_CHAT_DRAFT;

  const dropped = Array.from(dataTransfer.files);
  if (dropped.length > 0) {
    const pairs = dropped.map((file) => ({ file, attachment: uploadingAttachment(file) }));
    const added = addAttachments(
      draftKey,
      pairs.map((pair) => pair.attachment),
    ).map((attachment) => attachment.id);
    for (const { file, attachment } of pairs) {
      if (!added.includes(attachment.id)) continue;
      void deps.upload([file]).then(
        (paths) =>
          patchAttachment(
            draftKey,
            attachment.id,
            paths[0] ? { status: "ready", path: paths[0] } : { status: "failed" },
          ),
        () => patchAttachment(draftKey, attachment.id, { status: "failed" }),
      );
    }
    return;
  }

  const project = readDroppedProjectFile(dataTransfer, deps.projectFiles);
  if (project) addAttachments(draftKey, [projectAttachment(project)]);
}
