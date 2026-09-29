import { Dialog } from "@base-ui/react/dialog";
import { X } from "@phosphor-icons/react";
import type { ReactNode, RefObject } from "react";
import { cn } from "../ui/cn";
import { IconButton } from "../ui/IconButton";

interface ChatDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Actions row under the body, right-aligned. */
  footer?: ReactNode;
  /** Where focus goes when the dialog closes (the control that opened it may be gone by then). */
  finalFocus?: RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * A modal for the chat's settings surfaces. Base UI owns focus trapping and Escape, and knows about the
 * popovers opened inside it (model lists), so Escape closes the innermost one first. It sits on the modal
 * layer, under the popup layer those popovers use.
 */
export function ChatDialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  finalFocus,
  className,
}: ChatDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-100 bg-black/60 transition-opacity duration-open data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          finalFocus={finalFocus}
          className={cn(
            "fixed left-1/2 top-1/2 z-100 flex max-h-[min(640px,calc(100vh-2rem))] w-[min(400px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden",
            "rounded-lg border border-border-input bg-bg-1 text-text-1 shadow-popover outline-hidden",
            className,
          )}
        >
          <div className="flex items-start gap-2 border-b border-border px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-step-12 font-semibold text-text-0">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="mt-0.5 text-step-11 text-text-3">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              render={
                <IconButton aria-label="Close" size="sm" icon={<X size={12} aria-hidden />} />
              }
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
              {footer}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A labelled block inside a dialog: small caps title, the control, an optional hint under it. */
export function DialogField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-step-10 font-medium uppercase tracking-wide text-text-3">{label}</span>
      {children}
      {hint && <p className="text-step-10 leading-snug text-text-4">{hint}</p>}
    </div>
  );
}
