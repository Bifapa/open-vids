import { memo, useState, useCallback, useMemo, useRef } from "react";
import { Plus, FolderSimplePlus, LockSimple } from "@phosphor-icons/react";
import { useTranslation } from "../../i18n";
import {
  buildTree,
  sortChildren,
  isActiveInSubtree,
  ContextMenu,
  InlineInput,
  DeleteConfirm,
  TreeFile,
  TreeFolder,
  type ContextMenuState,
  type InlineInputState,
} from "./FileTreeNodes";

// ── Types ──

interface FileTreeProps {
  files: string[];
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  onCreateFile?: (path: string) => void;
  onCreateFolder?: (path: string) => void;
  onDeleteFile?: (path: string) => void;
  onRenameFile?: (oldPath: string, newPath: string) => void;
  onDuplicateFile?: (path: string) => void;
  onMoveFile?: (oldPath: string, newPath: string) => void;
  onImportFiles?: (files: FileList, dir?: string) => void;
  lintFindingsByFile?: Map<string, { count: number; messages: string[] }>;
  /**
   * An agent turn is running: nothing that changes an existing file starts (new file / folder, rename, duplicate,
   * delete, move). Importing files from outside stays available.
   */
  locked?: boolean;
}

// ── Main FileTree Component ──

export const FileTree = memo(function FileTree({
  files,
  activeFile,
  onSelectFile,
  onCreateFile,
  onCreateFolder,
  onDeleteFile,
  onRenameFile,
  onDuplicateFile,
  onMoveFile,
  onImportFiles,
  lintFindingsByFile,
  locked = false,
}: FileTreeProps) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildTree(files), [files]);
  const children = useMemo(() => sortChildren(tree.children), [tree]);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [inlineInput, setInlineInput] = useState<InlineInputState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    path: string;
    isFolder: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const dragSourceRef = useRef<string | null>(null);

  const hasFileOps = !!(
    onCreateFile ||
    onCreateFolder ||
    onDeleteFile ||
    onRenameFile ||
    onDuplicateFile
  );

  // ── Context Menu handlers ──

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, path: string, isFolder: boolean) => {
      if (!hasFileOps || locked) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, targetPath: path, targetIsFolder: isFolder });
    },
    [hasFileOps, locked],
  );

  const handleCloseContextMenu = useCallback(() => setContextMenu(null), []);

  // ── New File ──

  const handleNewFile = useCallback(
    (parentPath: string) => {
      setInlineInput({
        parentPath,
        mode: "new-file",
        onCommit: (name: string) => {
          const fullPath = parentPath ? `${parentPath}/${name}` : name;
          onCreateFile?.(fullPath);
          setInlineInput(null);
        },
        onCancel: () => setInlineInput(null),
      });
    },
    [onCreateFile],
  );

  // ── New Folder ──

  const handleNewFolder = useCallback(
    (parentPath: string) => {
      setInlineInput({
        parentPath,
        mode: "new-folder",
        onCommit: (name: string) => {
          const fullPath = parentPath ? `${parentPath}/${name}` : name;
          onCreateFolder?.(fullPath);
          setInlineInput(null);
        },
        onCancel: () => setInlineInput(null),
      });
    },
    [onCreateFolder],
  );

  // ── Rename ──

  const handleRename = useCallback(
    (path: string) => {
      const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
      const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      setInlineInput({
        parentPath,
        mode: "rename",
        originalPath: path,
        originalName: name,
        onCommit: (newName: string) => {
          if (newName !== name) {
            const newPath = parentPath ? `${parentPath}/${newName}` : newName;
            onRenameFile?.(path, newPath);
          }
          setInlineInput(null);
        },
        onCancel: () => setInlineInput(null),
      });
    },
    [onRenameFile],
  );

  // ── Duplicate ──

  const handleDuplicate = useCallback(
    (path: string) => {
      onDuplicateFile?.(path);
    },
    [onDuplicateFile],
  );

  // ── Delete ──

  const handleDelete = useCallback(
    (path: string) => {
      // Anchor the confirm near where the context menu was opened so it
      // appears next to the row the user acted on.
      setDeleteTarget({
        path,
        isFolder: contextMenu?.targetIsFolder ?? false,
        x: contextMenu?.x ?? window.innerWidth / 2,
        y: contextMenu?.y ?? window.innerHeight / 2,
      });
    },
    [contextMenu],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (deleteTarget) {
      onDeleteFile?.(deleteTarget.path);
      setDeleteTarget(null);
    }
  }, [deleteTarget, onDeleteFile]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  // ── Drag and Drop ──

  const handleDragStart = useCallback(
    (e: React.DragEvent, path: string) => {
      if (locked) {
        e.preventDefault();
        return;
      }
      dragSourceRef.current = path;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", path);
    },
    [locked],
  );

  const handleDragOver = useCallback((_e: React.DragEvent, folderPath: string) => {
    setDragOverFolder(folderPath);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, folderPath: string) => {
      if (e.dataTransfer.files.length > 0 && !dragSourceRef.current) {
        e.preventDefault();
        onImportFiles?.(e.dataTransfer.files, folderPath || undefined);
        setDragOverFolder(null);
        return;
      }

      const sourcePath = dragSourceRef.current;
      if (!sourcePath || !onMoveFile || locked) {
        setDragOverFolder(null);
        return;
      }
      const fileName = sourcePath.includes("/")
        ? sourcePath.slice(sourcePath.lastIndexOf("/") + 1)
        : sourcePath;
      const newPath = folderPath ? `${folderPath}/${fileName}` : fileName;
      if (newPath !== sourcePath && !folderPath.startsWith(sourcePath + "/")) {
        onMoveFile(sourcePath, newPath);
      }
      setDragOverFolder(null);
      dragSourceRef.current = null;
    },
    [onMoveFile, onImportFiles, locked],
  );

  const handleDragLeave = useCallback(() => {
    setDragOverFolder(null);
  }, []);

  // ── Root-level context menu (right-click on empty space) ──

  const handleRootContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!hasFileOps || locked) return;
      if (e.target === e.currentTarget) {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, targetPath: "", targetIsFolder: true });
      }
    },
    [hasFileOps, locked],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-0">
      {/* Files header with the new-file / new-folder actions (prototype `.ft-head`) */}
      {hasFileOps && (
        <div className="flex h-list-head shrink-0 items-center gap-1 pl-3 pr-1.5 text-xs font-semibold text-fg-2">
          <span className="min-w-0 flex-1">{t("editor.fileTree.files")}</span>
          <button
            onClick={() => handleNewFile("")}
            disabled={locked}
            className="flex size-ctl-xs items-center justify-center rounded-sm text-fg-3 transition-colors duration-hover hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:text-fg-disabled disabled:hover:bg-transparent disabled:hover:text-fg-disabled"
            title={locked ? t("files.lock.agentEditing") : t("editor.fileTree.newFile")}
            aria-label={t("editor.fileTree.newFile")}
          >
            <Plus size={12} weight="bold" />
          </button>
          <button
            onClick={() => handleNewFolder("")}
            disabled={locked}
            className="flex size-ctl-xs items-center justify-center rounded-sm text-fg-3 transition-colors duration-hover hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:text-fg-disabled disabled:hover:bg-transparent disabled:hover:text-fg-disabled"
            title={locked ? t("files.lock.agentEditing") : t("editor.fileTree.newFolder")}
            aria-label={t("editor.fileTree.newFolder")}
          >
            <FolderSimplePlus size={12} />
          </button>
        </div>
      )}
      {hasFileOps && locked && (
        <p
          role="status"
          data-testid="file-tree-lock"
          className="flex items-start gap-1.5 px-3 pb-1.5 text-xs leading-[15px] text-fg-3"
        >
          <LockSimple aria-hidden size={12} weight="bold" className="mt-px shrink-0" />
          {t("files.lock.treeNotice")}
        </p>
      )}

      <div
        className={`flex-1 overflow-y-auto px-1.5 pb-1 transition-colors ${
          dragOverFolder === ""
            ? "bg-accent/5 outline-solid outline-1 -outline-offset-1 outline-accent/40"
            : ""
        }`}
        onContextMenu={handleRootContextMenu}
        onDragOver={(e) => {
          e.preventDefault();
          if (e.target === e.currentTarget) setDragOverFolder("");
        }}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget) setDragOverFolder(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          handleDrop(e, "");
        }}
      >
        {/* Root-level inline input for new file/folder */}
        {inlineInput &&
          (inlineInput.mode === "new-file" || inlineInput.mode === "new-folder") &&
          inlineInput.parentPath === "" && (
            <InlineInput
              defaultValue=""
              depth={0}
              isFolder={inlineInput.mode === "new-folder"}
              onCommit={(name) => inlineInput.onCommit?.(name)}
              onCancel={() => inlineInput.onCancel?.()}
            />
          )}
        {children.length === 0 && !inlineInput && (
          <div className="px-3 py-4 text-center text-xs text-fg-3">
            {hasFileOps ? t("editor.fileTree.emptyCanCreate") : t("editor.fileTree.empty")}
          </div>
        )}
        {children.map((child) =>
          child.isFile && child.children.size === 0 ? (
            <TreeFile
              key={child.fullPath}
              node={child}
              depth={0}
              activeFile={activeFile}
              onSelectFile={onSelectFile}
              onContextMenu={handleContextMenu}
              inlineInput={inlineInput}
              onDragStart={handleDragStart}
              lintInfo={lintFindingsByFile?.get(child.fullPath)}
            />
          ) : (
            <TreeFolder
              key={child.fullPath}
              node={child}
              depth={0}
              activeFile={activeFile}
              onSelectFile={onSelectFile}
              defaultOpen={isActiveInSubtree(child, activeFile)}
              onContextMenu={handleContextMenu}
              inlineInput={inlineInput}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragLeave={handleDragLeave}
              dragOverFolder={dragOverFolder}
              lintFindingsByFile={lintFindingsByFile}
            />
          ),
        )}
      </div>

      {/* Delete confirmation — anchored near the row it was invoked on */}
      {deleteTarget && (
        <div
          className="fixed z-50 w-56"
          style={{
            left: Math.min(deleteTarget.x, window.innerWidth - 240),
            top: Math.min(deleteTarget.y, window.innerHeight - 120),
          }}
        >
          <DeleteConfirm
            name={
              deleteTarget.path.includes("/")
                ? deleteTarget.path.slice(deleteTarget.path.lastIndexOf("/") + 1)
                : deleteTarget.path
            }
            isFolder={deleteTarget.isFolder}
            onConfirm={handleDeleteConfirm}
            onCancel={handleDeleteCancel}
          />
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onClose={handleCloseContextMenu}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onRename={handleRename}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
});
