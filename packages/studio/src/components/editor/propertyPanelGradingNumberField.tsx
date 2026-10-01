import { useEffect, useRef, useState } from "react";
import { clampNumber } from "../../utils/studioHelpers";

export function GradingNumberField({
  label,
  ariaLabel = label,
  value,
  min,
  max,
  disabled,
  formatValue = String,
  labelClassName = "min-w-0",
  labelTextClassName = "block",
  inputClassName = "w-full",
  onBegin,
  onPreview,
  onSettle,
  onCancel,
}: {
  label: string;
  ariaLabel?: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  formatValue?: (value: number) => string;
  labelClassName?: string;
  labelTextClassName?: string;
  inputClassName?: string;
  onBegin: () => void;
  onPreview: (value: number) => void;
  onSettle: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => formatValue(value));
  const focusedRef = useRef(false);
  const cancelBlurRef = useRef(false);
  const baselineRef = useRef(value);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(formatValue(value));
  }, [formatValue, value]);

  const settle = () => {
    focusedRef.current = false;
    if (cancelBlurRef.current) {
      cancelBlurRef.current = false;
      return;
    }
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(formatValue(value));
      if (dirtyRef.current) onCancel();
      dirtyRef.current = false;
      return;
    }
    const next = clampNumber(parsed, min, max);
    setDraft(formatValue(next));
    if (!dirtyRef.current || Object.is(next, baselineRef.current)) {
      if (dirtyRef.current) onCancel();
      dirtyRef.current = false;
      return;
    }
    onPreview(next);
    onSettle();
    dirtyRef.current = false;
  };

  return (
    <label className={labelClassName}>
      <span className={labelTextClassName}>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled}
        onFocus={() => {
          focusedRef.current = true;
          baselineRef.current = value;
          dirtyRef.current = false;
          setDraft(formatValue(value));
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === "") return;
          const parsed = Number(next);
          if (!Number.isFinite(parsed)) return;
          const clamped = clampNumber(parsed, min, max);
          if (!Object.is(clamped, baselineRef.current) && !dirtyRef.current) {
            dirtyRef.current = true;
            onBegin();
          }
          if (dirtyRef.current) onPreview(clamped);
        }}
        onBlur={settle}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancelBlurRef.current = true;
            focusedRef.current = false;
            setDraft(formatValue(value));
            if (dirtyRef.current) onCancel();
            dirtyRef.current = false;
            event.currentTarget.blur();
          } else if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        className={`h-[22px] w-full min-w-0 rounded-sm border border-border bg-surface-1 px-1 text-right font-mono text-2xs text-fg outline-hidden transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-disabled ${inputClassName}`}
      />
    </label>
  );
}
