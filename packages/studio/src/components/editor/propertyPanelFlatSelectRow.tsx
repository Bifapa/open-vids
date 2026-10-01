import { RotateCcw } from "../../icons/SystemIcons";
import { INSP_MINI_BUTTON, INSP_ROW, INSP_SELECT } from "./inspectorStyles";
import {
  VALUE_TIER_LABEL_CLASS,
  VALUE_TIER_VALUE_CLASS,
  type PropertyValueTier,
} from "./propertyPanelValueTier";

/* ------------------------------------------------------------------ */
/*  FlatSelectRow — label/value row backed by a native <select>        */
/* ------------------------------------------------------------------ */

export function FlatSelectRow({
  label,
  ariaLabel,
  value,
  options,
  tier,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  /** Accessible name when a caller renders the visible label OUTSIDE this
   *  row (label="" to avoid a duplicate) — e.g. Grade's "Preset" row, which
   *  shows its own label span and would otherwise leave the <select>
   *  unnamed. Falls back to `label` when omitted. */
  ariaLabel?: string;
  value: string;
  options: Array<string | { value: string; label: string }>;
  tier: PropertyValueTier;
  disabled?: boolean;
  onChange: (nextValue: string) => void;
  onReset?: () => void;
}) {
  const normalizedOptions = options.map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );
  // A valid authored value outside the preset list (e.g. a `mix-blend-mode`
  // or `object-position` this row doesn't offer as a preset) must not be
  // silently misrepresented as the first option — the native <select> falls
  // back to selectedIndex 0 when `value` matches no <option>, and reselecting
  // that visible-but-wrong preset overwrites the real persisted value. Prepend
  // the current value so it's always representable, matching legacy
  // `SelectField`'s same guard.
  const renderedOptions =
    value && !normalizedOptions.some((option) => option.value === value)
      ? [{ value, label: value }, ...normalizedOptions]
      : normalizedOptions;
  return (
    <div className={label ? `group ${INSP_ROW}` : "group flex min-h-ctl-sm items-center"}>
      {label && (
        <span className={`min-w-0 truncate text-sm ${VALUE_TIER_LABEL_CLASS[tier]}`}>{label}</span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <select
          value={value}
          disabled={disabled}
          aria-label={ariaLabel || label || undefined}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          className={`${INSP_SELECT} ${VALUE_TIER_VALUE_CLASS[tier]}`}
        >
          {renderedOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {tier === "explicitCustom" && onReset && (
          <button
            type="button"
            data-flat-select-reset="true"
            title="Remove — fall back to default"
            disabled={disabled}
            onClick={() => {
              onReset();
            }}
            className={`${INSP_MINI_BUTTON} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
          >
            <RotateCcw size={12} />
          </button>
        )}
      </span>
    </div>
  );
}
