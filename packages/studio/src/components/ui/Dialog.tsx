/**
 * Dialog: a modal on Base UI, wearing the prototype's floating panel (`.float`):
 * a `bg-1` card with a 32 px head, a scrolling body and an optional action foot,
 * over the theme's scrim. Base UI owns the focus trap, Escape and focus return,
 * and knows about popups opened inside it, so Escape closes the innermost first.
 * It sits on the modal layer, under the popup layer menus and selects use.
 */

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "@phosphor-icons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./cn";
import { IconButton } from "./IconButton";

type PopupProps = ComponentPropsWithoutRef<typeof BaseDialog.Popup>;

export interface DialogProps {
  open: boolean;
  /** Escape, the scrim and the close button all call this. */
  onClose: () => void;
  title: string;
  /** One line under the title. */
  description?: string;
  /** Dim, tabular text at the end of the head ("QA pass 1 of 2"). */
  meta?: ReactNode;
  children: ReactNode;
  /** The action row, right-aligned; primary action last. */
  footer?: ReactNode;
  /** Where focus goes on open; Base UI's default is the first tabbable element. */
  initialFocus?: PopupProps["initialFocus"];
  /** Where focus goes on close, when the opener may be gone by then. */
  finalFocus?: PopupProps["finalFocus"];
  /** Width and height overrides for the card. */
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  meta,
  children,
  footer,
  initialFocus,
  finalFocus,
  className,
}: DialogProps) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-100 bg-scrim transition-opacity duration-open data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BaseDialog.Popup
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          className={cn(
            "fixed left-1/2 top-1/2 z-100 flex max-h-[min(640px,calc(100vh-2rem))] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden",
            "rounded-lg border border-border bg-bg-1 text-sm text-fg shadow-pop outline-hidden",
            "transition-[opacity,scale] duration-open ease-out-quint data-[ending-style]:duration-close data-[ending-style]:ease-in",
            "data-[starting-style]:[opacity:var(--popup-enter-opacity)] data-[starting-style]:[scale:var(--popup-enter-scale)] data-[ending-style]:opacity-0",
            className,
          )}
        >
          <div className="flex min-h-head shrink-0 items-center gap-1.5 border-b border-border-subtle py-1 pl-3 pr-1">
            <div className="min-w-0 flex-1">
              <BaseDialog.Title className="m-0 truncate text-sm font-semibold text-fg">
                {title}
              </BaseDialog.Title>
              {description && (
                <BaseDialog.Description className="m-0 text-xs text-fg-3">
                  {description}
                </BaseDialog.Description>
              )}
            </div>
            {meta ? (
              <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-fg-3">
                {meta}
              </span>
            ) : null}
            <BaseDialog.Close
              render={
                <IconButton aria-label="Close" size="sm" icon={<X size={12} aria-hidden />} />
              }
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">{children}</div>
          {footer && (
            <div className="flex min-h-11 shrink-0 items-center justify-end gap-1.5 border-t border-border-subtle py-2 pl-3 pr-2.5">
              {footer}
            </div>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
