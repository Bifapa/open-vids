import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";

/** Click-to-type readout. Enter/blur commits; a refused value stays open and turns red. */
export function FlatSliderReadout({
  label,
  displayValue,
  tier,
  disabled,
  onCommitText,
}: {
  label: string;
  displayValue: string;
  tier: "default" | "explicitCustom";
  disabled?: boolean;
  /** Receives the raw text; return false to refuse it and keep the field open. */
  onCommitText?: (text: string) => boolean | void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editable = Boolean(onCommitText) && !disabled;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const begin = () => {
    if (!editable) return;
    setText(displayValue);
    setInvalid(false);
    setEditing(true);
  };
  // Enter and blur both commit, so a value typed and then clicked away from is
  // not silently dropped. A refused value stays open on Enter (the author is
  // still there to fix it) and is discarded on blur (they have moved on).
  const commit = (keepOpenIfRefused: boolean) => {
    const accepted = onCommitText?.(text.trim());
    if (accepted === false && keepOpenIfRefused) {
      setInvalid(true);
      inputRef.current?.select();
      return;
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        data-flat-slider-input="true"
        aria-label={t("inspector.slider.valueLabel", { label })}
        aria-invalid={invalid || undefined}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
          // Keep the timeline's own shortcuts from firing on every keystroke.
          e.stopPropagation();
        }}
        onBlur={() => commit(false)}
        className={`h-ctl-sm w-14 shrink-0 rounded-sm border bg-surface-1 px-1.5 text-right font-mono text-num text-fg outline-2 outline-offset-1 ${
          invalid ? "border-error outline-error" : "border-border-strong outline-accent"
        }`}
      />
    );
  }

  return (
    <span
      data-flat-slider-value="true"
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      title={editable ? t("inspector.slider.clickToType") : undefined}
      onClick={begin}
      onKeyDown={(e) => {
        if (!editable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          begin();
        }
      }}
      className={`flex h-ctl-sm w-14 shrink-0 items-center justify-end overflow-hidden rounded-sm border border-border bg-surface-1 px-1.5 font-mono text-num tabular-nums whitespace-nowrap ${
        tier === "explicitCustom" ? "text-fg" : "text-fg-2"
      } ${editable ? "cursor-text transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" : ""}`}
    >
      {displayValue}
    </span>
  );
}
