import { useCallback, useEffect, useRef } from "react";
import { useDomEditActionsContextOptional } from "../contexts/DomEditContext";
import { useFileManagerContextOptional } from "../contexts/FileManagerContext";
import type { UseEditHistoryActionsOptions } from "../hooks/useEditHistoryActions";
import { usePlayerStore } from "../player";

/** What the editor needs to pick up a project that was rewritten underneath it. */
export interface RevertRefreshDeps {
  /** File open in the code editor, or null. */
  editingPath: string | null;
  readProjectFile: (path: string) => Promise<string>;
  updateEditingFileContent: (path: string, content: string) => void;
  invalidateGsapCache: () => void;
  forceReloadSdkSession?: () => void;
  syncHistoryPreviewAfterApply: UseEditHistoryActionsOptions["syncHistoryPreviewAfterApply"];
  refreshFileTree: () => void | Promise<void>;
  bumpThumbnailRevisions: (compositions: readonly string[] | null) => void;
}

async function attempt(step: () => void | Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    // A stale view is recoverable (reload); a throw out of here would cost the user the revert result.
    console.error("[Studio] Refreshing the editor after a revert failed:", error);
  }
}

/**
 * The same refresh Studio's own undo/redo runs after a history step (`useEditHistoryActions`):
 * drop the GSAP cache, force the SDK session to re-open, then let `syncHistoryPreviewAfterApply`
 * reload the preview and clear the timeline. A revert restores files through the history engine's
 * atomic replace, which the file watcher does not report on macOS, so nothing else would notice.
 *
 * The revert response does not say which files changed, so this is the "unknown paths" case:
 * a full preview reload, plus the file tree, thumbnails and the open code file.
 */
export async function refreshEditorAfterRevert(deps: RevertRefreshDeps): Promise<void> {
  await attempt(deps.invalidateGsapCache);
  await attempt(() => deps.forceReloadSdkSession?.());
  await attempt(() => deps.syncHistoryPreviewAfterApply({}));
  await attempt(deps.refreshFileTree);
  await attempt(() => deps.bumpThumbnailRevisions(null));
  const path = deps.editingPath;
  if (path) {
    await attempt(async () =>
      deps.updateEditingFileContent(path, await deps.readProjectFile(path)),
    );
  }
}

export interface RevertRefreshOptions {
  forceReloadSdkSession?: () => void;
  syncHistoryPreviewAfterApply: UseEditHistoryActionsOptions["syncHistoryPreviewAfterApply"];
}

/** A stable callback that refreshes the live editor from the state current when it is called. */
export function useEditorRefreshAfterRevert(options: RevertRefreshOptions): () => Promise<void> {
  const files = useFileManagerContextOptional();
  const dom = useDomEditActionsContextOptional();
  const live = useRef({ options, files, dom });
  useEffect(() => {
    live.current = { options, files, dom };
  });

  return useCallback(async () => {
    const { options: current, files: fileManager, dom: domActions } = live.current;
    await refreshEditorAfterRevert({
      editingPath: fileManager?.editingFile?.path ?? null,
      readProjectFile: (path) =>
        fileManager ? fileManager.readProjectFile(path) : Promise.resolve(""),
      updateEditingFileContent: (path, content) =>
        fileManager?.updateEditingFileContent(path, content),
      invalidateGsapCache: () => domActions?.invalidateGsapCache(),
      forceReloadSdkSession: current.forceReloadSdkSession,
      syncHistoryPreviewAfterApply: current.syncHistoryPreviewAfterApply,
      refreshFileTree: () => fileManager?.refreshFileTree(),
      bumpThumbnailRevisions: usePlayerStore.getState().bumpThumbnailRevisions,
    });
  }, []);
}
