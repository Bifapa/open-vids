import { useCallback, useMemo } from "react";
import { STUDIO_MOTION_PATH } from "../components/editor/studioMotion";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import { t } from "../i18n";

interface HistoryResult {
  ok: boolean;
  reason?: string;
  message?: string;
  label?: string;
  paths?: string[];
  /** Per-file restored/previous content, used to soft-apply the preview. */
  files?: Record<string, { previous: string; restored: string }>;
}
interface HistoryFileCallbacks {
  readFile: (path: string) => Promise<string>;
  serialize?: <T>(paths: readonly string[], task: () => Promise<T>) => Promise<T>;
}
export interface EditHistoryHandle {
  undo: (cb: HistoryFileCallbacks) => Promise<HistoryResult>;
  redo: (cb: HistoryFileCallbacks) => Promise<HistoryResult>;
  state: {
    undo: ReadonlyArray<{ createdAt: number }>;
    redo: ReadonlyArray<{ createdAt: number }>;
  };
}

export interface UseEditHistoryActionsOptions {
  editHistory: Pick<EditHistoryHandle, "undo" | "redo">;
  readOptionalProjectFile: (path: string) => Promise<string>;
  readProjectFile: (path: string) => Promise<string>;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  showToast: (message: string, tone?: "error" | "info") => void;
  syncHistoryPreviewAfterApply: (restore: Pick<HistoryResult, "paths" | "files">) => Promise<void>;
  waitForPendingDomEditSaves: () => Promise<void>;
  onAfterUndoRedo?: (restore: Pick<HistoryResult, "paths" | "files">) => void;
  /** Active composition path — decides whether undo/redo must resync the SDK session. */
  activeCompPath?: string | null;
  /** Reloads the SDK session after a revert of the active comp, past the self-write suppress window. */
  forceReloadSdkSession?: () => void;
}

/** Takes one step of the project's history: the single owner of undo/redo over project files. */
export function useEditHistoryActions({
  editHistory,
  readOptionalProjectFile,
  readProjectFile,
  writeProjectFile,
  showToast,
  syncHistoryPreviewAfterApply,
  waitForPendingDomEditSaves,
  onAfterUndoRedo,
  activeCompPath,
  forceReloadSdkSession,
}: UseEditHistoryActionsOptions) {
  const readHistoryFile = useCallback(
    (path: string): Promise<string> =>
      path === STUDIO_MOTION_PATH ? readOptionalProjectFile(path) : readProjectFile(path),
    [readOptionalProjectFile, readProjectFile],
  );
  const serializeHistoryFiles = useCallback(
    <T>(paths: readonly string[], task: () => Promise<T>) =>
      serializeStudioFileMutations(writeProjectFile, paths, task),
    [writeProjectFile],
  );

  const apply = useCallback(
    async (direction: "undo" | "redo") => {
      await waitForPendingDomEditSaves();
      const result = await editHistory[direction]({
        readFile: readHistoryFile,
        serialize: serializeHistoryFiles,
      });
      if (!result.ok && result.reason === "content-mismatch") {
        showToast(
          t(direction === "undo" ? "shell.history.undoBlocked" : "shell.history.redoBlocked", {
            paths: String(result.paths?.join(", ")),
          }),
          "info",
        );
        return;
      }
      if (!result.ok && result.reason === "failed") {
        showToast(
          t(direction === "undo" ? "shell.history.undoFailed" : "shell.history.redoFailed", {
            message: String(result.message),
          }),
          "error",
        );
        return;
      }
      if (result.ok && result.label) {
        const restore = { paths: result.paths, files: result.files };
        onAfterUndoRedo?.(restore);
        if (activeCompPath && result.paths?.includes(activeCompPath)) {
          forceReloadSdkSession?.();
        }
        await syncHistoryPreviewAfterApply(restore);
        showToast(result.label, "info");
      }
    },
    [
      editHistory,
      readHistoryFile,
      showToast,
      syncHistoryPreviewAfterApply,
      waitForPendingDomEditSaves,
      serializeHistoryFiles,
      onAfterUndoRedo,
      activeCompPath,
      forceReloadSdkSession,
    ],
  );

  const undo = useCallback(() => apply("undo"), [apply]);
  const redo = useCallback(() => apply("redo"), [apply]);
  return useMemo(() => ({ undo, redo }), [undo, redo]);
}
