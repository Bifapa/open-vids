/**
 * Input: a boxed text field. Typing edits a local draft; Enter and blur commit it,
 * Escape abandons it.
 */

import { Input as BaseInput } from "@base-ui/react/input";
import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { cn } from "./cn";
import type { PreviewState } from "./Button";

/**
 * Shared field look (also used by NumberField and Select): the prototype's panel
 * control, 24 px on `surface-1`. Each interactive state is written twice, real and
 * `data-[preview-state=...]`; `valueControls.test.tsx` asserts the lists match.
 */
export const fieldBase = cn(
  "flex min-w-0 items-center gap-1.5 h-ctl-sm px-2 rounded-sm",
  "bg-surface-1 border border-border text-sm text-fg",
  "transition-[border-color,background-color] ease-standard duration-focus",
  "hover:border-border-strong data-[preview-state=hover]:border-border-strong",
  "outline-hidden",
  "focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent",
  "data-[preview-state=focus]:outline-solid data-[preview-state=focus]:outline-2 data-[preview-state=focus]:outline-offset-1 data-[preview-state=focus]:outline-accent",
  // `aria-invalid` is not one of Tailwind's built-in aria variants, so the
  // arbitrary form is the one that compiles. The token gate would have caught
  // the bare `aria-invalid:` spelling as a class that resolves to nothing.
  "aria-[invalid]:border-error",
  "has-[:disabled]:border-border-subtle has-[:disabled]:bg-transparent has-[:disabled]:text-fg-disabled has-[:disabled]:cursor-not-allowed",
);

/**
 * Field heights. `sm` (24 px) is the panel and inspector control; `md` (28 px, on the
 * window background) is the window-form field in Settings and sheets.
 */
export type FieldSize = "sm" | "md";

export const fieldSizes: Record<FieldSize, string> = {
  sm: "",
  md: "h-ctl px-2.5 rounded-md bg-bg-0",
};

/** The text itself, inside the box. The box owns the border and the ring. */
export const fieldText = cn(
  "min-w-0 w-full bg-transparent text-inherit outline-hidden",
  "placeholder:text-fg-3 disabled:cursor-not-allowed",
);

export interface InputProps extends Omit<
  ComponentPropsWithoutRef<"input">,
  "value" | "onChange" | "className" | "size"
> {
  /** The committed value. A draft lives inside until Enter or blur. */
  value: string;
  /** Called with the draft on Enter and on blur, only when it really changed. */
  onCommit: (next: string) => void;
  /** Marks the field invalid: red boundary and `aria-invalid`. */
  invalid?: boolean;
  /** `sm` in panels (default), `md` in window forms. */
  size?: FieldSize;
  className?: string;
  "data-preview-state"?: PreviewState;
}

export function Input({
  value,
  onCommit,
  invalid,
  size = "sm",
  disabled,
  className,
  "data-preview-state": previewState,
  ...props
}: InputProps) {
  const [draft, setDraft] = useState(value);
  const valueRef = useRef(value);
  valueRef.current = value;
  const dirtyRef = useRef(false);

  // An external write (a seek, an undo, another panel) is authoritative, but it
  // must not eat what the user is halfway through typing.
  useEffect(() => {
    if (!dirtyRef.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    dirtyRef.current = false;
    if (next === valueRef.current) return;
    onCommit(next);
  };

  return (
    <div
      className={cn(fieldBase, fieldSizes[size], className)}
      aria-invalid={invalid || undefined}
      data-preview-state={previewState}
    >
      <BaseInput
        value={draft}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={fieldText}
        onValueChange={(next) => {
          dirtyRef.current = true;
          setDraft(next);
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(draft);
            return;
          }
          if (event.key === "Escape") {
            // Abandon the draft rather than leave it for the blur commit.
            event.preventDefault();
            event.stopPropagation();
            dirtyRef.current = false;
            setDraft(valueRef.current);
            event.currentTarget.blur();
          }
        }}
        {...props}
      />
    </div>
  );
}
