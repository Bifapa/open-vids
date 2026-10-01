import { type ReactNode, useId, useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { INSP_SUBGROUP_HEAD } from "./inspectorStyles";

/**
 * The prototype's `.fx-sub`: a disclosure group inside an inspector section
 * (Grade's Scopes, Looks, Primary…). A hairline separates consecutive groups;
 * the heading carries a caret, the title and an optional right-aligned meta
 * line ("Warm Daylight · 100%", "Adjusted").
 */
export function FlatSubGroup({
  title,
  meta,
  defaultOpen = true,
  accessory,
  children,
  "data-testid": testId,
}: {
  title: string;
  meta?: ReactNode;
  defaultOpen?: boolean;
  /** Controls drawn at the end of the heading row, outside the toggle button. */
  accessory?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <div
      data-flat-subgroup={title}
      data-testid={testId}
      className="min-w-0 border-t border-border-subtle first:border-t-0"
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((was) => !was)}
          className={INSP_SUBGROUP_HEAD}
        >
          <CaretDown
            size={12}
            aria-hidden="true"
            className={`shrink-0 text-fg-3 transition-transform ${open ? "" : "-rotate-90"}`}
          />
          <span className="truncate">{title}</span>
          {meta ? (
            <span className="ml-auto min-w-0 truncate font-normal text-fg-3">{meta}</span>
          ) : null}
        </button>
        {accessory}
      </div>
      <div id={bodyId} hidden={!open} className="grid min-w-0 gap-1.5 pt-0.5 pb-2.5">
        {open ? children : null}
      </div>
    </div>
  );
}
