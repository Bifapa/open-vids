import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";

export const inputCls =
  "h-ctl-sm w-full rounded-sm border border-border bg-surface-1 px-1.5 text-right font-mono text-num text-fg outline-hidden transition-colors placeholder:font-ui placeholder:text-fg-3 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-fg-disabled";

/** `.sect-label` + a stack of `.frow` rows. */
export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 pb-3">
      <div className="flex min-w-0 items-baseline gap-1.5 pt-1 text-xs font-semibold text-fg-2">
        {label}
      </div>
      <div className="grid gap-1.5">{children}</div>
    </div>
  );
}

/** `.frow`: a 72px label column and the field. */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-ctl-sm grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
      <span className="min-w-0 truncate text-sm text-fg-3">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

interface NumberFieldProps {
  value: number | undefined;
  /** True when a multi-selection has differing values — shows "Mixed" until edited. */
  mixed?: boolean;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  ariaLabel: string;
  onCommit: (value: number) => void;
}

/**
 * Numeric input that only commits finite parses. Typing "-" or clearing the
 * field keeps a local draft instead of committing NaN/0 into live transforms
 * and the persisted overrides file.
 */
export function NumberField({
  value,
  mixed,
  step,
  min,
  max,
  disabled,
  ariaLabel,
  onCommit,
}: NumberFieldProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const focusedRef = useRef(false);

  // External value changed while not editing — drop any stale draft.
  useEffect(() => {
    if (!focusedRef.current) setDraft(null);
  }, [value]);

  const display = draft !== null ? draft : mixed ? "" : String(value ?? 0);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraft(raw);
    const parsed = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(parsed)) {
      // Native min/max only constrain spinner steps — typed values bypass
      // them, so clamp before committing to the model/overrides.
      let clamped = parsed;
      if (min !== undefined) clamped = Math.max(min, clamped);
      if (max !== undefined) clamped = Math.min(max, clamped);
      onCommit(clamped);
    }
  };

  return (
    <input
      type="number"
      className={inputCls}
      value={display}
      placeholder={mixed ? t("captions.field.mixed") : undefined}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={handleChange}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        setDraft(null);
      }}
    />
  );
}
