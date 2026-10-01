import { INSP_ROW, inspSwitchKnob, inspSwitchTrack } from "./inspectorStyles";

/* ------------------------------------------------------------------ */
/*  FlatToggle — the prototype's `.frow` with a 28×16 `.sw` switch      */
/*  at the start of the field column.                                  */
/*  (split out of propertyPanelFlatPrimitives.tsx to stay under the    */
/*  600-line file-size gate)                                           */
/* ------------------------------------------------------------------ */

export function FlatToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className={INSP_ROW}>
      <span
        data-flat-toggle-label="true"
        className={`min-w-0 truncate text-sm ${checked ? "text-fg-2" : "text-fg-3"}`}
      >
        {label}
      </span>
      <span className="flex min-w-0 items-center">
        <button
          type="button"
          data-flat-toggle="true"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          onClick={() => {
            onChange(!checked);
          }}
          className={inspSwitchTrack(checked)}
        >
          <span data-flat-toggle-knob="true" className={inspSwitchKnob(checked)} />
        </button>
      </span>
    </div>
  );
}
