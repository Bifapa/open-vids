import { MetricField } from "./propertyPanelPrimitives";
import {
  PERCENT_PROPS,
  PROP_CONSTRAINTS,
  PROP_LABELS,
  PROP_TOOLTIPS,
  PROP_UNITS,
  clampPropertyValue,
} from "./gsapAnimationConstants";
import { fieldBase, fieldSizes } from "../ui/Input";
import {
  INSP_CHIP,
  INSP_MINI_BUTTON,
  INSP_SELECT,
  inspSwitchKnob,
  inspSwitchTrack,
} from "./inspectorStyles";

export const BOOLEAN_PROPS = new Set(["visibility"]);
const STRING_PROPS = new Set(["filter", "clipPath"]);
const FILTER_PRESETS = [
  { label: "Blur", value: "blur(4px)" },
  { label: "Bright", value: "brightness(1.5)" },
  { label: "Gray", value: "grayscale(1)" },
  { label: "None", value: "none" },
];
const CLIP_PATH_PRESETS = [
  { label: "Circle", value: "circle(50% at 50% 50%)" },
  { label: "Inset", value: "inset(10%)" },
  { label: "None", value: "none" },
];

function isPercentProp(prop: string): boolean {
  return PERCENT_PROPS.has(prop);
}

function displayValue(prop: string, val: number | string): string {
  if (isPercentProp(prop)) return String(Math.round(Math.max(0, Math.min(1, Number(val))) * 100));
  return String(val);
}

function adjustedValue(prop: string, raw: string): string {
  if (isPercentProp(prop)) return String(clampPropertyValue(prop, Number(raw) / 100));
  const num = Number(raw);
  if (!Number.isNaN(num) && PROP_CONSTRAINTS[prop]) {
    return String(clampPropertyValue(prop, num));
  }
  return raw;
}

function RemoveButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${INSP_MINI_BUTTON} hover:text-error`}
      title={title}
      aria-label={title}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M3 3l6 6M9 3l-6 6" />
      </svg>
    </button>
  );
}

export function PropertyRow({
  prop,
  val,
  onCommit,
  onRemove,
  removeTitle,
}: {
  prop: string;
  val: number | string;
  onCommit: (adjusted: string) => void;
  onRemove: () => void;
  removeTitle: string;
}) {
  if (BOOLEAN_PROPS.has(prop)) {
    const isVisible = val === "visible" || val === 1;
    return (
      <div className="grid grid-cols-[minmax(0,72px)_minmax(0,1fr)_auto] items-center gap-1">
        <span className="min-w-0 truncate text-sm text-fg-3">{PROP_LABELS[prop] ?? prop}</span>
        <span className="flex min-w-0 items-center">
          <button
            type="button"
            role="switch"
            aria-checked={isVisible}
            onClick={() => onCommit(isVisible ? "hidden" : "visible")}
            className={inspSwitchTrack(isVisible)}
            title={isVisible ? "Visible — click to hide" : "Hidden — click to show"}
          >
            <span className={inspSwitchKnob(isVisible)} />
          </button>
        </span>
        <RemoveButton onClick={onRemove} title={removeTitle} />
      </div>
    );
  }
  if (STRING_PROPS.has(prop)) {
    const presets =
      prop === "filter" ? FILTER_PRESETS : prop === "clipPath" ? CLIP_PATH_PRESETS : [];
    return (
      <div className="grid gap-1">
        <div className="grid grid-cols-[minmax(0,72px)_minmax(0,1fr)_auto] items-center gap-1">
          <span className="min-w-0 truncate text-sm text-fg-3">{PROP_LABELS[prop] ?? prop}</span>
          <input
            type="text"
            defaultValue={String(val)}
            className={`${fieldBase} ${fieldSizes.sm} min-w-0 font-mono text-num`}
            onBlur={(e) => onCommit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <RemoveButton onClick={onRemove} title={removeTitle} />
        </div>
        {presets.length > 0 && (
          <div className="flex flex-wrap gap-1 pl-[76px]">
            {presets.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => onCommit(p.value)}
                className={INSP_CHIP}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        <MetricField
          label={PROP_LABELS[prop] ?? prop}
          value={displayValue(prop, val)}
          suffix={PROP_UNITS[prop]}
          tooltip={PROP_TOOLTIPS[prop]}
          scrub
          liveCommit
          onCommit={(raw) => onCommit(adjustedValue(prop, raw))}
        />
      </div>
      <RemoveButton onClick={onRemove} title={removeTitle} />
    </div>
  );
}

export function AddPropertyTrigger({
  adding,
  available,
  addLabel,
  addTitle,
  onAdd,
  onOpen,
  onClose,
  buttonClassName,
}: {
  adding: boolean;
  available: string[];
  addLabel: string;
  addTitle: string;
  onAdd: (prop: string) => void;
  onOpen: () => void;
  onClose: () => void;
  buttonClassName: string;
}) {
  if (adding && available.length > 0) {
    return (
      <select
        autoFocus
        className={`${INSP_SELECT} w-auto`}
        defaultValue=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
          onClose();
        }}
        onBlur={onClose}
      >
        <option value="" disabled>
          Choose property…
        </option>
        {available.map((p) => (
          <option key={p} value={p}>
            {PROP_LABELS[p] ?? p}
          </option>
        ))}
      </select>
    );
  }
  if (available.length === 0) return null;
  return (
    <button type="button" onClick={onOpen} className={buttonClassName} title={addTitle}>
      {addLabel}
    </button>
  );
}

export function parseNumericOrString(raw: string): number | string {
  const num = Number(raw);
  return Number.isFinite(num) ? num : raw;
}
