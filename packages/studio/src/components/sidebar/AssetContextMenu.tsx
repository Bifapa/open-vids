import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { Button, cn, fieldBase, fieldText, popupSurface } from "../ui";
import { filename } from "./assetHelpers";

/** Reject names that would escape the asset directory or break paths. */
function isValidAssetName(name: string): boolean {
  return name.length > 0 && !/[/\\]/.test(name) && !name.includes("..");
}

/** A menu row in the shared menu look: 24 px, accent fill under the pointer or focus. */
const itemBase = cn(
  "flex h-ctl-sm w-full cursor-default select-none items-center gap-2 rounded-sm px-2 text-left text-sm whitespace-nowrap",
  "outline-hidden transition-colors duration-hover",
);
const itemDefault =
  "text-fg hover:bg-accent hover:text-accent-ink focus-visible:bg-accent focus-visible:text-accent-ink";
const itemDanger =
  "text-error hover:bg-error hover:text-bg-0 focus-visible:bg-error focus-visible:text-bg-0";

function MenuRow({
  icon,
  danger,
  onClick,
  children,
}: {
  icon: ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(itemBase, danger ? itemDanger : itemDefault, "group/item")}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-icon-md shrink-0 items-center justify-center",
          danger
            ? "text-current"
            : "text-fg-3 group-hover/item:text-current group-focus-visible/item:text-current",
        )}
      >
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </button>
  );
}

export function ContextMenu({
  x,
  y,
  asset,
  onClose,
  onCopy,
  onDelete,
  onRename,
  onAddAtPlayhead,
}: {
  x: number;
  y: number;
  asset: string;
  onClose: () => void;
  onCopy: (path: string) => void;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newPath: string) => void;
  onAddAtPlayhead?: (path: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [mode, setMode] = useState<"menu" | "confirm-delete" | "rename">("menu");
  const [renameDraft, setRenameDraft] = useState(() => filename(asset));
  const [renameError, setRenameError] = useState<string | null>(null);

  // Clamp the menu inside the viewport once it has a size.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      x: Math.min(x, window.innerWidth - rect.width - margin),
      y: Math.min(y, window.innerHeight - rect.height - margin),
    });
  }, [x, y, mode]);

  // Keyboard contract: Escape backs out one level (rename/delete-confirm →
  // menu → closed), arrows move between menu items.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (mode !== "menu") {
          setMode("menu");
        } else {
          onClose();
        }
        return;
      }
      if (mode !== "menu" || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
      );
      if (items.length === 0) return;
      e.preventDefault();
      const idx = items.findIndex((el) => el === document.activeElement);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next = items[(idx + delta + items.length) % items.length];
      next.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [mode, onClose]);

  // Move focus into the menu on open so arrow keys work immediately.
  useEffect(() => {
    if (mode === "menu") {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    }
  }, [mode]);

  const commitRename = useCallback(() => {
    const trimmed = renameDraft.trim();
    if (trimmed === filename(asset)) {
      onClose();
      return;
    }
    if (!isValidAssetName(trimmed)) {
      setRenameError("Name can't contain / or ..");
      return;
    }
    const dir = asset.includes("/") ? asset.slice(0, asset.lastIndexOf("/") + 1) : "";
    onRename?.(asset, `${dir}${trimmed}`);
    onClose();
  }, [renameDraft, asset, onRename, onClose]);

  const name = filename(asset);

  // Portaled to the body: dock panels are `contain: paint`, which would clip a
  // fixed-position menu to the panel it was opened from.
  return createPortal(
    <div
      className="fixed inset-0 z-200"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={menuRef}
        role="menu"
        aria-label={`Actions for ${name}`}
        className={cn(popupSurface, "absolute min-w-44 p-1 shadow-pop", mode !== "menu" && "w-60")}
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {mode === "menu" && (
          <>
            {onAddAtPlayhead && (
              <MenuRow
                icon={<Plus size={14} />}
                onClick={() => {
                  onAddAtPlayhead(asset);
                  onClose();
                }}
              >
                Insert at Playhead
              </MenuRow>
            )}
            <MenuRow
              icon={<Copy size={14} />}
              onClick={() => {
                onCopy(asset);
                onClose();
              }}
            >
              Copy Path
            </MenuRow>
            {onRename && (
              <MenuRow icon={<PencilSimple size={14} />} onClick={() => setMode("rename")}>
                Rename
              </MenuRow>
            )}
            {onDelete && (
              <>
                <div role="separator" className="mx-1.5 my-1 h-px bg-border" />
                <MenuRow
                  icon={<Trash size={14} />}
                  danger
                  onClick={() => setMode("confirm-delete")}
                >
                  Delete…
                </MenuRow>
              </>
            )}
          </>
        )}
        {mode === "confirm-delete" && (
          <div
            role="group"
            aria-label={`Confirm deleting ${name}`}
            className="flex flex-col gap-1.5 px-1.5 pt-1 pb-0.5 text-sm text-fg"
          >
            <p className="leading-[17px] [overflow-wrap:anywhere]">
              Delete <b className="font-semibold">{name}</b>?
            </p>
            <p className="text-xs text-fg-3">The file is removed from the project folder.</p>
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setMode("menu")}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  onDelete?.(asset);
                  onClose();
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        )}
        {mode === "rename" && (
          <div className="flex flex-col gap-1.5 px-1 py-1">
            <div className={fieldBase} aria-invalid={renameError ? true : undefined}>
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => {
                  setRenameDraft(e.target.value);
                  setRenameError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setMode("menu");
                  }
                }}
                aria-label={`Rename ${name}`}
                aria-invalid={renameError ? true : undefined}
                spellCheck={false}
                className={fieldText}
              />
            </div>
            {renameError && (
              <span role="alert" className="px-0.5 text-xs text-error">
                {renameError}
              </span>
            )}
            <div className="flex items-center justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setMode("menu")}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={commitRename}>
                Rename
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
