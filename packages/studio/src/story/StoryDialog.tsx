import { useId, useRef, type ReactNode } from "react";
import { WarningCircle, X } from "@phosphor-icons/react";
import { IconButton, cn } from "../components/ui";
import { useDialogBehavior } from "../components/ui/useDialogBehavior";
import { EDIT_AUTHOR_LABELS, describeEdit, type EditInSection } from "./storySync";

/**
 * A modal over the Story panel only (the editor around it stays as it is): Escape and the backdrop close it,
 * focus is trapped inside while it is open and returns to the trigger after.
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
      className="absolute inset-0 z-30 flex items-start justify-center bg-bg-0/70 px-4 py-6 backdrop-blur-xs"
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
        className="flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-border-input bg-surface text-text-1 shadow-popover outline-hidden"
      >
        <header className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={titleId} className="text-step-13 font-semibold text-text-0">
              {title}
            </h2>
            {description && <p className="text-step-11 text-text-2">{description}</p>}
          </div>
          <IconButton
            aria-label="Close"
            size="sm"
            icon={<X size={12} aria-hidden />}
            onClick={onClose}
          />
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {children}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          {footer}
        </footer>
      </div>
    </div>
  );
}

/** A heading inside a dialog, in the inspector's section style. */
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
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-step-10 font-semibold uppercase tracking-wide text-text-3">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

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
        "flex items-start gap-2 rounded-md border px-2.5 py-2 text-step-11",
        warning
          ? "border-container/40 bg-container/10 text-text-1"
          : "border-border-input bg-bg-2 text-text-2",
      )}
    >
      {warning && (
        <WarningCircle
          size={13}
          weight="fill"
          className="mt-px shrink-0 text-container"
          aria-hidden
        />
      )}
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
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
          className="flex items-baseline gap-1.5 text-step-10 text-text-2"
        >
          <span
            className={cn(
              "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
              edit.by === "user" ? "bg-selection" : edit.by === "ai" ? "bg-accent" : "bg-text-4",
            )}
            aria-hidden
          />
          <span className="min-w-0 truncate">
            <span className="font-medium text-text-1">{edit.label}</span> {describeEdit(edit)} ·{" "}
            {EDIT_AUTHOR_LABELS[edit.by]}
            {showWhere && <span className="text-text-3"> · {where}</span>}
          </span>
        </li>
      ))}
      {more > 0 && <li className="pl-3 text-step-10 text-text-3">+{more} more</li>}
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
    <label className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-accent"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-step-11 font-medium text-text-1">{label}</span>
        {description && <span className="text-step-10 text-text-3">{description}</span>}
      </span>
    </label>
  );
}
