import { useId, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { cn, fieldText } from "../components/ui";

const fieldBox = cn(
  "w-full rounded-sm border border-border bg-surface-1 px-2 text-sm text-fg outline-hidden",
  "placeholder:text-fg-disabled hover:border-border-strong",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
  "disabled:cursor-not-allowed disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-disabled",
  "aria-[invalid]:border-error",
);

/** A labelled box with a hint under it: the shape of every field of the design dialogs. */
function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-semibold text-fg-2">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="m-0 text-xs text-error">
          {error}
        </p>
      ) : hint ? (
        <p className="m-0 text-xs leading-[15px] text-fg-3">{hint}</p>
      ) : null}
    </div>
  );
}

/** A multi-line field. Cmd/Ctrl+Enter asks to submit, like the Story panel's text fields. */
export function TextAreaField({
  label,
  hint,
  value,
  onChange,
  onSubmit,
  placeholder,
  rows = 4,
  textareaRef,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange(next: string): void;
  onSubmit?(): void;
  placeholder?: string;
  rows?: number;
  textareaRef?: Ref<HTMLTextAreaElement>;
}) {
  const id = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit) {
      event.preventDefault();
      onSubmit();
    }
  };
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <textarea
        id={id}
        ref={textareaRef}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className={cn(fieldBox, "min-h-16 resize-y py-[5px] leading-4")}
      />
    </Field>
  );
}

/** A single-line field; Enter asks to submit. */
export function TextField({
  label,
  hint,
  error,
  value,
  onChange,
  onSubmit,
  placeholder,
  type = "text",
}: {
  label: string;
  hint?: string;
  error?: string | null;
  value: string;
  onChange(next: string): void;
  onSubmit?(): void;
  placeholder?: string;
  type?: "text" | "url";
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onSubmit) {
            event.preventDefault();
            onSubmit();
          }
        }}
        className={cn(fieldBox, fieldText, "h-ctl-sm")}
      />
    </Field>
  );
}
