import { useId, useRef, type ReactNode } from "react";
import { WarningCircle, X } from "@phosphor-icons/react";
import { IconButton, cn } from "../components/ui";
import { useDialogBehavior } from "../components/ui/useDialogBehavior";
import { EDIT_AUTHOR_LABELS, describeEdit, type EditInSection } from "./storySync";

/**
 * A modal over the Story panel only (the editor around it stays as it is): Escape and the backdrop close it,
 * focus is trapped inside while it is open and returns to the trigger after. Drawn as the prototype's float
 * (head, scrolling body, foot).
 */
export function StoryDialog({
  title,
  description,
  onClose,
  footer,
  children,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { requestClose } = useDialogBehavior({ open: true, onClose, containerRef });
  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-scrim px-4 py-10"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-border bg-bg-1 text-sm text-fg shadow-pop outline-hidden"
      >
        <header className="flex shrink-0 items-start gap-2 border-b border-border-subtle py-2.5 pr-1.5 pl-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
            <h2 id={titleId} className="truncate text-sm font-semibold text-fg">
              {title}
            </h2>
            {description && <p className="text-xs leading-[15px] text-fg-3">{description}</p>}
          </div>
          <IconButton
            aria-label="Close"
            size="sm"
            icon={<X size={12} aria-hidden />}
            onClick={onClose}
          />
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-3">
          {children}
        </div>
        <footer className="flex min-h-11 shrink-0 items-center justify-end gap-1.5 border-t border-border-subtle py-2 pr-2.5 pl-3">
          {footer}
        </footer>
      </div>
    </div>
  );
}

/** A labelled group inside a dialog (prototype `.sect-label`). */
export function DialogGroup({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs leading-[14px] font-semibold text-fg-2">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A note box: `warning` is the prototype's `.note-box.warn` (what you are about to lose), `info` a plain one. */
export function Callout({
  tone = "warning",
  children,
}: {
  tone?: "warning" | "info";
  children: ReactNode;
}) {
  const warning = tone === "warning";
  return (
    <div
      role={warning ? "alert" : undefined}
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm leading-[17px] text-pretty",
        warning
          ? "border-[color-mix(in_oklch,var(--color-warning)_35%,var(--color-border))] bg-warning-soft text-fg"
          : "border-border-subtle bg-bg-0 text-fg-2",
      )}
    >
      {warning && (
        <WarningCircle
          size={13}
          weight="fill"
          className="mt-0.5 shrink-0 text-warning"
          aria-hidden
        />
      )}
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** Manual edits as short lines: which clip, what was done, by whom, and where (when asked). */
export function EditRows({
  edits,
  limit,
  showWhere,
}: {
  edits: readonly EditInSection[];
  limit?: number;
  showWhere?: boolean;
}) {
  const shown = limit === undefined ? edits : edits.slice(0, limit);
  const more = edits.length - shown.length;
  return (
    <ul className="flex flex-col gap-0.5" aria-label="Manual edits">
      {shown.map(({ edit, where }) => (
        <li
          key={`${edit.clip}-${edit.kind}`}
          className="flex items-baseline gap-1.5 text-xs leading-[15px] text-fg-2"
        >
          <span
            className={cn(
              "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
              edit.by === "user"
                ? "bg-fg-2"
                : edit.by === "ai"
                  ? "bg-k-motion-l"
                  : "bg-fg-disabled",
            )}
            aria-hidden
          />
          <span className="min-w-0 truncate">
            <span className="font-medium text-fg">{edit.label}</span> {describeEdit(edit)} ·{" "}
            {EDIT_AUTHOR_LABELS[edit.by]}
            {showWhere && <span className="text-fg-3"> · {where}</span>}
          </span>
        </li>
      ))}
      {more > 0 && <li className="pl-3 text-xs text-fg-3">+{more} more</li>}
    </ul>
  );
}

/** A radio or checkbox with a label and a line of explanation. */
export function ChoiceRow({
  type,
  name,
  checked,
  onChange,
  label,
  description,
}: {
  type: "radio" | "checkbox";
  name?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-sm px-1.5 py-1 hover:bg-surface-1">
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-accent"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-fg">{label}</span>
        {description && <span className="text-xs leading-[15px] text-fg-3">{description}</span>}
      </span>
    </label>
  );
}
