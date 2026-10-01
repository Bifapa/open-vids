/**
 * Wraps a Design-panel property control with the promote-to-variable gesture.
 * When a control can be promoted it shows a visible "◇ var" button; clicking it
 * declares a variable (default = current value, so the render is unchanged) and
 * binds this property to it. Once bound, the button is replaced by a "◆ {id}"
 * chip and edits route to the variable's default (edit-in-place). Controls that
 * aren't eligible (or render outside a promote context, or are disabled by the
 * caller) pass through untouched. Uses a render-prop so each control keeps its
 * own value/onCommit shape.
 */

import { useEffect } from "react";
import {
  useVariablePromoteChannel,
  type PromoteChannel,
} from "../../contexts/VariablePromoteContext";
import { useTranslation } from "../../i18n";

interface RenderArgs {
  /** When bound, the variable's default to display; otherwise undefined. */
  value?: string;
  /** When bound, routes commits to the variable default; otherwise undefined. */
  onCommit?: (value: string) => void;
  bound: boolean;
}

export function PromotableControl({
  channel,
  enabled = true,
  children,
}: {
  channel: PromoteChannel;
  /**
   * Caller-side gate. Text-section controls only promote when the edited field
   * is the selected element's OWN text (source "self"); binding a child/text-
   * node field would target a different element than the control edits.
   */
  enabled?: boolean;
  children: (args: RenderArgs) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const promote = useVariablePromoteChannel(channel);

  // A binding attribute (`data-var-*` / `var(--id)`) pointing at a declaration
  // that no longer exists renders as a plain unbound control — a silent
  // fallback that leaves a dev wondering why "their binding isn't showing".
  // Surface it in the console so the dangling reference is discoverable.
  const danglingId =
    enabled && promote && promote.boundId != null && promote.declaration == null
      ? promote.boundId
      : null;
  useEffect(() => {
    if (danglingId != null) {
      console.warn(
        `[hyperframes] Control is bound to variable "${danglingId}", but no such declaration exists. The element still carries the binding on disk — re-declare the variable or unbind the element.`,
      );
    }
  }, [danglingId]);

  if (!promote || !enabled) return <>{children({ bound: false })}</>;

  // A binding whose declaration was removed elsewhere is dangling: don't show
  // it as an editable bound control (setDefault would silently no-op) — let it
  // fall back to a plain, re-promotable control.
  const bound = promote.boundId != null && promote.declaration != null;
  const canPromote = promote.action != null && !bound;
  const defaultValue = promote.declaration?.default;

  const rendered = children(
    bound
      ? {
          // Only string defaults render inline; a FontValue/ImageValue object
          // falls back to the element's real value instead of "[object Object]".
          value: typeof defaultValue === "string" ? defaultValue : undefined,
          onCommit: promote.setDefault,
          bound: true,
        }
      : { bound: false },
  );

  return (
    <div
      className={`group/promo relative ${bound ? "rounded-sm shadow-[0_0_0_1px_var(--color-accent-line)]" : ""}`}
    >
      {rendered}
      {bound && (
        <span
          // Sits above the row (not on top of top-0) so it clears a value that
          // renders flush to the row's right edge, e.g. flat Font/Color rows.
          className="pointer-events-none absolute -top-2 right-1.5 z-10 inline-flex max-w-[60%] items-center gap-1 truncate rounded-xs border border-accent-line bg-accent-soft px-1 font-mono text-2xs leading-[14px] text-fg"
          title={t("editor.variable.boundTo", { id: promote.boundId })}
        >
          ◆ {promote.boundId}
        </span>
      )}
      {canPromote && (
        <button
          type="button"
          title={t("editor.variable.make")}
          onClick={(e) => {
            e.stopPropagation();
            promote.promote();
          }}
          aria-label={t("editor.variable.make")}
          // Sits in the label column, right after the label text (the prototype's `.promo`).
          className="absolute left-[54px] top-1 z-10 inline-flex size-4 items-center justify-center rounded-xs text-2xs text-fg-disabled opacity-0 transition-[color,background-color,opacity] group-hover/promo:opacity-100 hover:bg-surface-2 hover:text-fg focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent"
        >
          ◇
        </button>
      )}
    </div>
  );
}
