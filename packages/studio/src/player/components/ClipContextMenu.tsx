import { memo } from "react";
import { createPortal } from "react-dom";
import { usePlayerStore, type TimelineElement } from "../store/playerStore";
import { canSplitElement } from "../../utils/timelineElementSplit";
import { formatNumber, useTranslation } from "../../i18n";
import { useContextMenuDismiss } from "../../hooks/useContextMenuDismiss";
import { useMenuKeyboardNav } from "./menuKeyboardNav";
import {
  timelineMenuItem,
  timelineMenuSeparator,
  timelineMenuShortcut,
  timelineMenuSurface,
} from "./timelineMenuStyles";

interface ClipContextMenuProps {
  x: number;
  y: number;
  element: TimelineElement;
  currentTime: number;
  onClose: () => void;
  onSplit: (element: TimelineElement, splitTime: number) => void;
  onDelete: (element: TimelineElement) => void;
  onCopy?: () => boolean;
  onPaste?: () => Promise<void>;
  onDuplicate?: () => Promise<boolean>;
  canPaste?: boolean;
}

// A menu with many independently gated items (Split/Delete/Copy/Paste/Duplicate).
export const ClipContextMenu = memo(function ClipContextMenu({
  x,
  y,
  element,
  currentTime,
  onClose,
  onSplit,
  onDelete,
  onCopy,
  onPaste,
  onDuplicate,
  canPaste,
}: ClipContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useContextMenuDismiss(onClose);
  useMenuKeyboardNav(menuRef);
  // The right-clicked clip's own id: a member of the live multi-selection
  // means Copy/Duplicate act on the whole group, matching onContextMenuClip's
  // selection-preserving behaviour for a right-click inside it.
  const selectionSize = usePlayerStore((s) => {
    const id = element.key ?? element.id;
    return s.selectedElementIds.size > 1 && s.selectedElementIds.has(id)
      ? s.selectedElementIds.size
      : 1;
  });

  const isSplittable = canSplitElement(element) && ["video", "audio", "img"].includes(element.tag);
  const canSplit =
    isSplittable && currentTime > element.start && currentTime < element.start + element.duration;

  const splitLabel = !isSplittable
    ? null
    : canSplit
      ? t("player.clipMenu.splitAt", {
          time: formatNumber(currentTime, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        })
      : t("player.clipMenu.splitDisabled");

  const clipboardItemCount = [onCopy, onPaste, onDuplicate].filter(Boolean).length;
  const rowCount = (splitLabel ? 1 : 0) + clipboardItemCount + 1; // + Delete, always present
  const dividerCount = (splitLabel ? 1 : 0) + (clipboardItemCount > 0 ? 1 : 0);
  const menuWidth = 200;
  const menuHeight = rowCount * 30 + dividerCount * 9 + 8;
  const overflowY = y + menuHeight - window.innerHeight;
  const adjustedX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const adjustedY = overflowY > 0 ? y - overflowY - 8 : y;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("player.clipMenu.label")}
      className={timelineMenuSurface}
      style={{ left: adjustedX, top: adjustedY }}
    >
      {splitLabel && (
        <>
          <button
            type="button"
            role="menuitem"
            className={timelineMenuItem(canSplit)}
            disabled={!canSplit}
            onClick={() => {
              if (canSplit) {
                onSplit(element, currentTime);
                onClose();
              }
            }}
          >
            <span>{splitLabel}</span>
            <span className={timelineMenuShortcut}>S</span>
          </button>
          <div className={timelineMenuSeparator} />
        </>
      )}

      {(onCopy || onPaste || onDuplicate) && (
        <>
          {onCopy && (
            <button
              type="button"
              role="menuitem"
              className={timelineMenuItem(true)}
              onClick={() => {
                onCopy();
                onClose();
              }}
            >
              <span>
                {selectionSize > 1
                  ? t("player.clipMenu.copyClips", { count: selectionSize })
                  : t("common.copy")}
              </span>
              <span className={timelineMenuShortcut}>⌘C</span>
            </button>
          )}
          {onPaste && (
            <button
              type="button"
              role="menuitem"
              className={timelineMenuItem(!!canPaste)}
              disabled={!canPaste}
              onClick={() => {
                if (!canPaste) return;
                void onPaste();
                onClose();
              }}
            >
              <span>{t("common.paste")}</span>
              <span className={timelineMenuShortcut}>⌘V</span>
            </button>
          )}
          {onDuplicate && (
            <button
              type="button"
              role="menuitem"
              className={timelineMenuItem(true)}
              onClick={() => {
                void onDuplicate();
                onClose();
              }}
            >
              <span>
                {selectionSize > 1
                  ? t("player.clipMenu.duplicateClips", { count: selectionSize })
                  : t("common.duplicate")}
              </span>
              <span className={timelineMenuShortcut}>⌘D</span>
            </button>
          )}
          <div className={timelineMenuSeparator} />
        </>
      )}

      <button
        type="button"
        role="menuitem"
        className={timelineMenuItem(true, "danger")}
        onClick={() => {
          onDelete(element);
          onClose();
        }}
      >
        <span>{t("common.delete")}</span>
        <span className={timelineMenuShortcut}>⌫</span>
      </button>
    </div>,
    document.body,
  );
});
