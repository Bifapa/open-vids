import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FIELD, LABEL } from "./propertyPanelHelpers";
import { CommitField } from "./propertyPanelCommitField";

export { CommitField } from "./propertyPanelCommitField";

/* ------------------------------------------------------------------ */
/*  MetricField                                                        */
/* ------------------------------------------------------------------ */

export function MetricField({
  label,
  value,
  disabled,
  liveCommit,
  scrub,
  suffix,
  tooltip,
  onCommit,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  liveCommit?: boolean;
  scrub?: boolean;
  suffix?: string;
  tooltip?: string;
  onCommit: (nextValue: string) => void | Promise<unknown>;
}) {
  const scrubRef = useRef<{ startX: number; startValue: number; pointerId: number } | null>(null);

  const handleScrubPointerDown = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      if (disabled || !scrub) return;
      const parsed = parseFloat(value);
      if (!Number.isFinite(parsed)) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      scrubRef.current = { startX: e.clientX, startValue: parsed, pointerId: e.pointerId };
    },
    [disabled, scrub, value],
  );

  const handleScrubPointerMove = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      const state = scrubRef.current;
      if (!state) return;
      const delta = e.clientX - state.startX;
      onCommit(String(Math.round(state.startValue + delta)));
    },
    [onCommit],
  );

  const handleScrubPointerUp = useCallback(() => {
    scrubRef.current = null;
  }, []);

  const scrubProps =
    scrub && !disabled
      ? ({
          className: "shrink-0 text-sm font-medium text-fg-3 cursor-ew-resize select-none",
          onPointerDown: handleScrubPointerDown,
          onPointerMove: handleScrubPointerMove,
          onPointerUp: handleScrubPointerUp,
          onPointerCancel: handleScrubPointerUp,
          onLostPointerCapture: handleScrubPointerUp,
        } as const)
      : ({ className: "shrink-0 text-sm font-medium text-fg-3" } as const);

  return (
    <div className={FIELD} title={tooltip}>
      <div className="flex min-w-0 items-center gap-3">
        <span {...scrubProps}>{label}</span>
        <CommitField
          value={value}
          disabled={disabled}
          liveCommit={liveCommit}
          onCommit={onCommit}
        />
        {suffix && <span className="shrink-0 text-xs text-fg-disabled">{suffix}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Simple field components                                            */
/* ------------------------------------------------------------------ */

export function DetailField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onCommit: (nextValue: string) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className={LABEL}>{label}</span>
      <div className={FIELD}>
        <CommitField value={value} disabled={disabled} onCommit={onCommit} />
      </div>
    </label>
  );
}

export function SliderControl({
  trackName,
  value,
  min,
  max,
  step,
  displayValue,
  formatDisplayValue,
  disabled,
  onCommit,
}: {
  trackName: string;
  value: number;
  min: number;
  max: number;
  step: number;
  displayValue: string;
  formatDisplayValue?: (nextValue: number) => string;
  disabled?: boolean;
  onCommit: (nextValue: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactionChangedRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
    },
    [],
  );

  const commitDraft = (nextDraft: number) => {
    if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
    if (interactionChangedRef.current) {
      interactionChangedRef.current = false;
    }
    if (nextDraft !== valueRef.current) onCommit(nextDraft);
  };
  const scheduleCommit = (nextDraft: number) => {
    if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      if (nextDraft !== valueRef.current) onCommit(nextDraft);
    }, 40);
  };

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        aria-label={trackName}
        onChange={(e) => {
          const n = Number(e.target.value);
          setDraft(n);
          interactionChangedRef.current = true;
          scheduleCommit(n);
        }}
        onMouseUp={() => commitDraft(draft)}
        onTouchEnd={() => commitDraft(draft)}
        onBlur={() => commitDraft(draft)}
        // h-6 is the 24x24 WCAG 2.2 (2.5.8) target: the visible track stays 2px
        // and the thumb 10px, only the pointer box grows.
        className="h-6 min-w-0 w-full cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-runnable-track]:h-[2px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-panel-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-[10px] [&::-webkit-slider-thumb]:h-[10px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_#0C0C0E,0_1px_3px_rgba(0,0,0,0.5)] [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb:active]:cursor-grabbing"
      />
      <div className="min-w-[44px] rounded-md bg-surface-1 px-2 py-1.5 text-right text-sm font-medium text-fg tabular-nums">
        {formatDisplayValue?.(draft) ?? displayValue}
      </div>
    </div>
  );
}

export function SegmentedControl({
  trackName,
  options,
  value,
  disabled,
  onChange,
}: {
  trackName: string;
  options: Array<{ label: string; value: string }>;
  value: string;
  disabled?: boolean;
  onChange: (nextValue: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={trackName}
      className="grid min-w-0 gap-[2px] rounded-md bg-surface-1 p-[2px]"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => {
            onChange(option.value);
          }}
          aria-pressed={option.value === value}
          className={`min-w-0 truncate rounded px-2 py-[5px] text-sm font-medium transition-colors disabled:cursor-not-allowed ${
            option.value === value ? "bg-surface-3 text-fg" : "text-fg-3 hover:text-fg-2"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SelectField({
  label,
  value,
  disabled,
  options,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  options: string[];
  onChange: (nextValue: string) => void;
}) {
  const renderedOptions = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <label className={`${FIELD} flex items-center gap-3`}>
      <span className="shrink-0 text-sm font-medium text-fg-3">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className="min-w-0 w-full appearance-none bg-transparent text-sm font-medium text-fg outline-hidden disabled:cursor-not-allowed disabled:text-fg-disabled"
      >
        {renderedOptions.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Section({
  title,
  icon: _icon,
  children,
  accessory,
  defaultCollapsed = false,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  accessory?: ReactNode;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const collapseIcon = (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="currentColor"
      className={`shrink-0 text-fg-disabled transition-transform duration-150 ${
        collapsed ? "-rotate-90" : ""
      }`}
    >
      <path d="M2 3l3 4 3-4z" />
    </svg>
  );

  const section = slugifyPanelSectionTitle(title);
  return (
    <section className="min-w-0 border-t border-border-subtle" data-panel-section={section}>
      <div className="flex w-full items-center gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
        >
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {collapseIcon}
        </button>
        {accessory && <div className="flex shrink-0 items-center">{accessory}</div>}
      </div>
      {!collapsed && <div className="px-4 pb-3">{children}</div>}
    </section>
  );
}

// Stable hook for e2e/automation to locate a section without depending on the
// display copy (h3 textContent matching breaks on wording tweaks or, if this
// panel is ever localized, on translation).
function slugifyPanelSectionTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
