import { memo, useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  PencilSimple,
  Copy,
  Trash,
  FilePlus,
  FolderSimplePlus,
  FolderSimple,
} from "@phosphor-icons/react";
import { ChevronDown, ChevronRight } from "../../icons/SystemIcons";
import { Button } from "../ui/Button";
import {
  FileIcon,
  buildTree as _buildTree,
  sortChildren,
  isActiveInSubtree,
  type TreeNode,
  type ContextMenuState,
  type InlineInputState,
} from "./FileTreeIcons";

export type { ContextMenuState, InlineInputState };
export { buildTree, sortChildren, isActiveInSubtree } from "./FileTreeIcons";

const SZ_ICON = 14;

// The prototype's menu row: 24 px, accent highlight, dim leading glyph that inks on highlight.
const MENU_ITEM =
  "flex h-6 w-full cursor-default items-center gap-2 rounded-sm px-2 text-left text-sm text-fg outline-hidden hover:bg-accent hover:text-accent-ink focus-visible:bg-accent focus-visible:text-accent-ink [&_svg]:shrink-0 [&_svg]:text-fg-3 hover:[&_svg]:text-current focus-visible:[&_svg]:text-current";
const MENU_SEPARATOR = "-mx-1 my-1 border-t border-border-subtle";

// ── Context Menu Component ──

export function ContextMenu({
  state,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onDuplicate,
  onDelete,
}: {
  state: ContextMenuState;
  onClose: () => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onRename: (path: string) => void;
  onDuplicate: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstItem = menuRef.current?.querySelector("button");
    if (firstItem instanceof HTMLElement) firstItem.focus();
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      restoreFocusRef.current?.focus();
    };
  }, [onClose]);

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    e.preventDefault();
    const items = Array.from(menu.querySelectorAll("button"));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (e.key === "ArrowUp") {
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    } else if (e.key === "End") next = items.length - 1;
    items[next]?.focus();
  };

  const adjustedX = Math.min(state.x, window.innerWidth - 180);
  const adjustedY = Math.min(state.y, window.innerHeight - 200);

  const parentPath = state.targetIsFolder
    ? state.targetPath
    : state.targetPath.includes("/")
      ? state.targetPath.slice(0, state.targetPath.lastIndexOf("/"))
      : "";

  return (
    <div
      ref={menuRef}
      role="menu"
      onKeyDown={handleMenuKeyDown}
      className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-menu-bg p-1 text-sm shadow-pop backdrop-blur-xl"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {state.targetIsFolder && (
        <>
          <button
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              onNewFile(state.targetPath);
              onClose();
            }}
          >
            <FilePlus size={12} />
            New File
          </button>
          <button
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              onNewFolder(state.targetPath);
              onClose();
            }}
          >
            <FolderSimplePlus size={12} />
            New Folder
          </button>
          <div className={MENU_SEPARATOR} />
        </>
      )}
      {!state.targetIsFolder && (
        <>
          <button
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              onNewFile(parentPath);
              onClose();
            }}
          >
            <FilePlus size={12} />
            New File
          </button>
          <div className={MENU_SEPARATOR} />
        </>
      )}
      <button
        role="menuitem"
        className={MENU_ITEM}
        onClick={() => {
          onRename(state.targetPath);
          onClose();
        }}
      >
        <PencilSimple size={12} />
        Rename
      </button>
      {!state.targetIsFolder && (
        <button
          role="menuitem"
          className={MENU_ITEM}
          onClick={() => {
            onDuplicate(state.targetPath);
            onClose();
          }}
        >
          <Copy size={12} />
          Duplicate
        </button>
      )}
      <div className={MENU_SEPARATOR} />
      <button
        role="menuitem"
        className={`${MENU_ITEM} text-error hover:bg-error hover:text-on-media focus-visible:bg-error focus-visible:text-on-media`}
        onClick={() => {
          onDelete(state.targetPath);
          onClose();
        }}
      >
        <Trash size={12} />
        Delete
      </button>
    </div>
  );
}

// ── Inline Input (for new file/folder/rename) ──

export function InlineInput({
  defaultValue,
  depth,
  isFolder,
  onCommit,
  onCancel,
}: {
  defaultValue: string;
  depth: number;
  isFolder: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);

  const validate = (name: string): string | null => {
    if (/[/\\]/.test(name)) return "Name can't contain / or \\";
    if (name.includes("..")) return "Name can't contain ..";
    return null;
  };

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (defaultValue && defaultValue.includes(".")) {
      const dotIdx = defaultValue.lastIndexOf(".");
      el.setSelectionRange(0, dotIdx);
    } else {
      el.select();
    }
  }, [defaultValue]);

  const commit = (name: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(name);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) {
        onCancel();
        return;
      }
      const invalid = validate(trimmed);
      if (invalid) {
        setError(invalid);
        return;
      }
      commit(trimmed);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const handleBlur = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== defaultValue && !validate(trimmed)) commit(trimmed);
    else onCancel();
  };

  return (
    <div
      className="flex min-h-6 items-center gap-[5px] py-0.5 pr-1.5"
      style={{ paddingLeft: `${4 + depth * 14 + (isFolder ? 0 : 17)}px` }}
    >
      {isFolder ? (
        <FolderSimple size={SZ_ICON} className="shrink-0 text-fg-3" />
      ) : (
        <FileIcon path={value} />
      )}
      <div className="flex-1 min-w-0">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          aria-invalid={error ? true : undefined}
          className={`h-5 w-full min-w-0 rounded-sm border bg-surface-1 px-1.5 text-sm text-fg outline-hidden ${
            error
              ? "border-error shadow-[0_0_0_2px_var(--color-error-soft)]"
              : "border-border focus:border-accent"
          }`}
          spellCheck={false}
        />
        {error && (
          <div className="mt-0.5 text-2xs text-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Delete Confirmation ──

export function DeleteConfirm({
  name,
  isFolder,
  onConfirm,
  onCancel,
}: {
  name: string;
  isFolder?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("keydown", handleEscape);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onCancel]);

  return (
    <div
      ref={ref}
      className="grid gap-1.5 rounded-lg border border-border bg-menu-bg p-2.5 pb-2 text-sm text-fg shadow-pop backdrop-blur-xl"
    >
      <p className="m-0 leading-[17px] text-pretty">
        {isFolder ? (
          <>
            Delete folder <b className="font-semibold">{name}</b> and everything inside it?
          </>
        ) : (
          <>
            Delete <b className="font-semibold">{name}</b>?
          </>
        )}
      </p>
      <div className="mt-1 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" onClick={onConfirm}>
          Delete
        </Button>
      </div>
    </div>
  );
}

// ── TreeFile ──

export const TreeFile = memo(function TreeFile({
  node,
  depth,
  activeFile,
  onSelectFile,
  onContextMenu,
  inlineInput,
  onDragStart,
  lintInfo,
}: {
  node: TreeNode;
  depth: number;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isFolder: boolean) => void;
  inlineInput: InlineInputState | null;
  onDragStart: (e: React.DragEvent, path: string) => void;
  lintInfo?: { count: number; messages: string[] };
}) {
  const isActive = node.fullPath === activeFile;
  const isRenaming = inlineInput?.mode === "rename" && inlineInput.originalPath === node.fullPath;

  if (isRenaming) {
    return (
      <InlineInput
        defaultValue={inlineInput.originalName ?? node.name}
        depth={depth}
        isFolder={false}
        onCommit={(name) => {
          inlineInput?.onCommit?.(name);
        }}
        onCancel={() => {
          inlineInput?.onCancel?.();
        }}
      />
    );
  }

  return (
    <button
      draggable
      onDragStart={(e) => onDragStart(e, node.fullPath)}
      onClick={() => onSelectFile(node.fullPath)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, node.fullPath, false);
      }}
      className={`flex h-6 w-full items-center gap-[5px] rounded-sm border pr-1.5 text-left text-sm outline-hidden transition-colors duration-hover focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent ${
        isActive
          ? "border-accent-line bg-accent-soft text-fg"
          : "border-transparent text-fg-2 hover:bg-surface-1 hover:text-fg"
      }`}
      style={{ paddingLeft: `${4 + depth * 14 + 17}px` }}
    >
      <FileIcon path={node.name} />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {lintInfo && lintInfo.count > 0 && (
        <span
          className="shrink-0 text-2xs font-semibold tabular-nums text-warning"
          title={lintInfo.messages.join("\n")}
        >
          {lintInfo.count}
        </span>
      )}
    </button>
  );
});

// ── TreeFolder ──

export const TreeFolder = memo(function TreeFolder({
  node,
  depth,
  activeFile,
  onSelectFile,
  defaultOpen,
  onContextMenu,
  inlineInput,
  onDragStart,
  onDragOver,
  onDrop,
  onDragLeave,
  dragOverFolder,
  lintFindingsByFile,
}: {
  node: TreeNode;
  depth: number;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  defaultOpen: boolean;
  onContextMenu: (e: React.MouseEvent, path: string, isFolder: boolean) => void;
  inlineInput: InlineInputState | null;
  onDragStart: (e: React.DragEvent, path: string) => void;
  onDragOver: (e: React.DragEvent, folderPath: string) => void;
  onDrop: (e: React.DragEvent, folderPath: string) => void;
  onDragLeave: () => void;
  dragOverFolder: string | null;
  lintFindingsByFile?: Map<string, { count: number; messages: string[] }>;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  const children = useMemo(() => sortChildren(node.children), [node.children]);
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  const isDragOver = dragOverFolder === node.fullPath;
  const isRenaming = inlineInput?.mode === "rename" && inlineInput.originalPath === node.fullPath;

  if (isRenaming) {
    return (
      <InlineInput
        defaultValue={inlineInput.originalName ?? node.name}
        depth={depth}
        isFolder={true}
        onCommit={(name) => {
          inlineInput?.onCommit?.(name);
        }}
        onCancel={() => {
          inlineInput?.onCancel?.();
        }}
      />
    );
  }

  return (
    <>
      <button
        draggable
        onDragStart={(e) => onDragStart(e, node.fullPath)}
        onClick={toggle}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, node.fullPath, true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDragOver(e, node.fullPath);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDrop(e, node.fullPath);
        }}
        onDragLeave={onDragLeave}
        className={`flex h-6 w-full items-center gap-[5px] rounded-sm border pr-1.5 text-left text-sm text-fg-2 outline-hidden transition-colors duration-hover hover:bg-surface-1 hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent ${
          isDragOver ? "border-accent bg-accent/10" : "border-transparent"
        }`}
        style={{ paddingLeft: `${4 + depth * 14}px` }}
      >
        <Chevron size={10} className="w-3 shrink-0 text-fg-3" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
      {isOpen && (
        <>
          {inlineInput &&
            (inlineInput.mode === "new-file" || inlineInput.mode === "new-folder") &&
            inlineInput.parentPath === node.fullPath && (
              <InlineInput
                defaultValue=""
                depth={depth + 1}
                isFolder={inlineInput.mode === "new-folder"}
                onCommit={(name) => {
                  inlineInput?.onCommit?.(name);
                }}
                onCancel={() => {
                  inlineInput?.onCancel?.();
                }}
              />
            )}
          {children.map((child) =>
            child.isFile && child.children.size === 0 ? (
              <TreeFile
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                activeFile={activeFile}
                onSelectFile={onSelectFile}
                onContextMenu={onContextMenu}
                inlineInput={inlineInput}
                onDragStart={onDragStart}
                lintInfo={lintFindingsByFile?.get(child.fullPath)}
              />
            ) : child.children.size > 0 ? (
              <TreeFolder
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                activeFile={activeFile}
                onSelectFile={onSelectFile}
                defaultOpen={isActiveInSubtree(child, activeFile)}
                onContextMenu={onContextMenu}
                inlineInput={inlineInput}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onDragLeave={onDragLeave}
                dragOverFolder={dragOverFolder}
                lintFindingsByFile={lintFindingsByFile}
              />
            ) : (
              <TreeFile
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                activeFile={activeFile}
                onSelectFile={onSelectFile}
                onContextMenu={onContextMenu}
                inlineInput={inlineInput}
                onDragStart={onDragStart}
                lintInfo={lintFindingsByFile?.get(child.fullPath)}
              />
            ),
          )}
        </>
      )}
    </>
  );
});
