import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CaretDown, PencilSimple, type Icon } from "@phosphor-icons/react";
import { Input, Toggle, cn } from "../components/ui";
import { formatDuration, formatTime, parseDuration } from "./storyFormat";

/** Which inspector sections the user folded, by title; kept while the app runs, like the prototype's. */
const folded = new Set<string>();

/** A collapsible inspector section: the prototype's `.sec` (caret header, 6 px rhythm body). */
export function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  const [open, setOpen] = useState(() => !folded.has(title));
  const bodyId = useId();
  return (
    <section className="border-b border-border-subtle last:border-b-0">
      <div className="flex items-center pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            if (open) folded.add(title);
            else folded.delete(title);
            setOpen(!open);
          }}
          className="flex h-[30px] min-w-0 flex-1 items-center gap-1 pl-2 pr-2.5 text-left text-sm font-semibold text-fg outline-hidden hover:bg-surface-1 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <CaretDown
            size={12}
            weight="bold"
            className={cn(
              "shrink-0 text-fg-3 transition-transform duration-press",
              !open && "-rotate-90",
            )}
            aria-hidden
          />
          <span className="truncate">{title}</span>
        </button>
        {open && aside}
      </div>
      <div id={bodyId} hidden={!open} className="grid gap-1.5 px-3 pt-0.5 pb-3">
        {children}
      </div>
    </section>
  );
}

/**
 * The head of the inspector: the kind's type chip, the selection's name and a line of where it sits
 * (prototype `.insp-head`).
 */
export function InspectorHead({
  icon: KindIcon,
  chip,
  number,
  name,
  sub,
}: {
  icon: Icon;
  /** The kind's chip classes (STORY_KIND_STYLES[kind].chip). */
  chip: string;
  /** A chapter shows its place in the order instead of the icon. */
  number?: string;
  name: string;
  sub: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border-subtle px-3 py-2.5">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-sm",
          chip,
          number !== undefined && "font-mono text-xs font-semibold",
        )}
      >
        {number ?? <KindIcon size={14} aria-hidden />}
      </span>
      <div className="min-w-0">
        <div className="truncate text-md font-semibold tracking-[-0.005em] text-fg" title={name}>
          {name}
        </div>
        <div className="mt-px truncate text-xs tabular-nums text-fg-3">{sub}</div>
      </div>
    </div>
  );
}

/** "Set by you": the agent keeps this field. */
function EditedMark() {
  return (
    <span title="Set by you: the agent keeps it" className="inline-flex text-fg-3">
      <PencilSimple size={10} aria-label="Set by you" />
    </span>
  );
}

/**
 * A labelled row: label on the left (72 px), control on the right, an optional hint under the control (prototype
 * `.frow`). `top` aligns the label with the first line of a multi-line control; `edited` marks a field the user set
 * by hand (agents keep it).
 */
export function Field({
  label,
  edited,
  children,
  hint,
  top,
}: {
  label: string;
  edited?: boolean;
  children: ReactNode;
  hint?: string;
  top?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid min-h-6 grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1",
        top ? "items-start" : "items-center",
      )}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1 text-sm whitespace-nowrap text-fg-3",
          top && "leading-6",
        )}
      >
        <span className="truncate">{label}</span>
        {edited && <EditedMark />}
      </span>
      <div className="min-w-0">{children}</div>
      {hint && <span className="col-start-2 text-xs text-fg-3">{hint}</span>}
    </div>
  );
}

/** Multi-line text: commits on blur or ⌘/Ctrl+Enter, Escape abandons the draft. */
export function TextAreaField({
  label,
  value,
  onCommit,
  disabled,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);
  const commit = () => {
    dirty.current = false;
    if (draft !== value) onCommit(draft);
  };
  return (
    <textarea
      aria-label={label}
      value={draft}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => {
        dirty.current = true;
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dirty.current = false;
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className={cn(
        "min-h-12 w-full resize-y rounded-sm border border-border bg-surface-1 px-2 py-[5px] text-sm leading-4 text-fg outline-hidden",
        "placeholder:text-fg-disabled hover:border-border-strong focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-2",
      )}
    />
  );
}

/**
 * A length or a point in time, typed as `m:ss` (or seconds). `optional` fields accept an empty box as null.
 * `precise` shows tenths (`1:02.5`) for source in/out points. Text that does not read, or a value `validate`
 * refuses, is marked invalid and not committed.
 */
export function TimeField({
  label,
  value,
  onCommit,
  disabled,
  optional,
  precise,
  placeholder,
  validate,
}: {
  label: string;
  value: number | null;
  onCommit: (next: number | null) => void;
  disabled?: boolean;
  optional?: boolean;
  precise?: boolean;
  placeholder?: string;
  validate?: (next: number) => boolean;
}) {
  const [invalid, setInvalid] = useState(false);
  const shown = value === null ? "" : precise ? formatTime(value) : formatDuration(value);
  useEffect(() => setInvalid(false), [value]);
  return (
    <Input
      aria-label={label}
      value={shown}
      invalid={invalid}
      disabled={disabled}
      placeholder={placeholder ?? (precise ? "0:00.0" : "0:00")}
      onCommit={(text) => {
        if (text.trim() === "" && optional) {
          setInvalid(false);
          if (value !== null) onCommit(null);
          return;
        }
        const parsed = parseDuration(text);
        if (parsed === null || (validate && !validate(parsed))) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        if (parsed !== value) onCommit(parsed);
      }}
    />
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onCommit,
  disabled,
  edited,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCommit: (next: boolean) => void;
  disabled?: boolean;
  edited?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <span id={id} className="flex items-center gap-1 text-sm text-fg-3">
          {label}
          {edited && <EditedMark />}
        </span>
        <Toggle label={label} checked={checked} onCommit={onCommit} disabled={disabled} />
      </div>
      {description && <span className="text-xs leading-[15px] text-fg-3">{description}</span>}
    </div>
  );
}

/** A quiet line of guidance under a control, with a leading glyph (prototype `.hint-note`). */
export function HintNote({
  icon: HintIcon,
  tone,
  children,
}: {
  icon: Icon;
  tone?: "warning";
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-1.5 text-xs leading-[15px] text-pretty text-fg-3">
      <HintIcon
        size={12}
        className={cn("mt-px", tone === "warning" && "text-warning")}
        aria-hidden
      />
      <span>{children}</span>
    </div>
  );
}

/** "Set by you" chips: the fields an agent will not change on this node. */
export function EditedChips({
  fields,
  labels,
}: {
  fields: readonly string[];
  labels: Record<string, string>;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Set by you">
      <span className="text-xs text-fg-3">Set by you:</span>
      {fields.map((field) => (
        <span
          key={field}
          className="inline-flex h-4 items-center rounded-xs bg-surface-2 px-[5px] text-2xs font-medium text-fg-2"
        >
          {labels[field] ?? field}
        </span>
      ))}
    </div>
  );
}
