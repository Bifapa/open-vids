import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Input, Toggle, cn, fieldBase } from "../components/ui";
import { formatDuration, formatTime, parseDuration } from "./storyFormat";

export function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-b border-border px-3 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-step-10 font-semibold uppercase tracking-wide text-text-3">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A labelled row; `edited` marks a field the user set by hand (agents keep it). */
export function Field({
  label,
  edited,
  children,
  hint,
}: {
  label: string;
  edited?: boolean;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-step-10 font-medium text-text-2">
        {label}
        {edited && (
          <span
            className="flex items-center gap-1 text-selection"
            title="Set by you: the agent keeps it"
          >
            <span className="size-1.5 rounded-full bg-selection" aria-hidden />
            you
          </span>
        )}
      </span>
      {children}
      {hint && <span className="text-step-10 text-text-4">{hint}</span>}
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
        fieldBase,
        "h-auto min-h-14 resize-y py-1.5 leading-snug text-text-1 placeholder:text-text-5 disabled:cursor-not-allowed",
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
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span id={id} className="flex items-center gap-1.5 text-step-11 font-medium text-text-1">
          {label}
          {edited && <span className="size-1.5 rounded-full bg-selection" title="Set by you" />}
        </span>
        {description && <span className="text-step-10 text-text-3">{description}</span>}
      </div>
      <Toggle label={label} checked={checked} onCommit={onCommit} disabled={disabled} />
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
      <span className="text-step-10 text-text-3">Set by you:</span>
      {fields.map((field) => (
        <span
          key={field}
          className="rounded-sm border border-selection/40 bg-selection/10 px-1.5 py-0.5 text-step-10 font-medium text-selection"
        >
          {labels[field] ?? field}
        </span>
      ))}
    </div>
  );
}
