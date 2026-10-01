import type { CSSProperties } from "react";

/**
 * Class strings shared across the Design inspector so every section draws the
 * prototype's controls (`openvids.css` `.sec`/`.frow`/`.nf`, the inspector's
 * `.kfb`/`.promo` gutter buttons) the same way.
 */

/** 20px ghost square: keyframe gutter, reset, promote, row actions. */
export const INSP_MINI_BUTTON =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:pointer-events-none disabled:text-fg-disabled";

/** Focus ring drawn inside full-bleed rows (section headers, list rows). */
export const INSP_FOCUS_INSET =
  "outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** `.frow`: label column (`--insp-label-w`, 72px; wider for Russian), field column. */
export const INSP_ROW =
  "grid min-h-ctl-sm grid-cols-[var(--insp-label-w)_minmax(0,1fr)] items-center gap-2";

/** `.frow > label`. */
export const INSP_ROW_LABEL = "min-w-0 truncate text-sm text-fg-3";

/** `.sel`: native select drawn as a 24px field with a caret (see inspector.css). */
export const INSP_SELECT =
  "hf-insp-sel h-ctl-sm w-full min-w-0 rounded-sm border border-border bg-surface-1 pl-2 pr-[22px] text-sm text-fg transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-fg-disabled";

/** `.sect-label`: a group heading inside a section body. */
export const INSP_SUBHEAD = "flex min-w-0 items-baseline gap-1.5 text-xs font-semibold text-fg-2";

/** `.fx-mini` / `.fx-term`: a small uppercase caption above a block (IN/OUT, PRESETS). */
export const INSP_MINI_LABEL = "text-2xs font-semibold uppercase tracking-[0.06em] text-fg-3";

/** `.fx-val`: the 56px mono value box beside a slider. */
export const INSP_VALUE_BOX =
  "h-[22px] w-14 shrink-0 rounded-sm border border-border bg-surface-1 px-1.5 text-right font-mono text-num text-fg outline-hidden transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-disabled";

/** `.fx-lbl`: the 76px label of a slider row; long names wrap rather than truncate. */
export const INSP_FX_LABEL = "w-[76px] shrink-0 wrap-break-word text-sm leading-[13px] text-fg-3";

/** `.fx-node` / `.anim-card`: a bordered card on bg-1. */
export const INSP_CARD = "min-w-0 rounded-sm border border-border bg-bg-1";

/** `.fx-node-b`: a card's open body under a hairline. */
export const INSP_CARD_BODY = "grid gap-1.5 border-t border-border-subtle p-2";

/** `.fx-sub-h`: a 26px disclosure heading inside a section (Grade's Scopes, Looks…). */
export const INSP_SUBGROUP_HEAD =
  "flex h-[26px] w-full min-w-0 items-center gap-1 rounded-xs pr-1 text-left text-xs font-semibold text-fg-2 transition-colors hover:bg-surface-1 hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** `.ichip`: a 22px chip (caption words, ease presets, tags); selected = accent-soft. */
export const INSP_CHIP =
  "relative h-[22px] max-w-full truncate rounded-sm border border-border bg-surface-1 px-[7px] text-xs text-fg-2 transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-pressed:border-accent-line aria-pressed:bg-accent-soft aria-pressed:text-fg aria-selected:border-accent-line aria-selected:bg-accent-soft aria-selected:text-fg";

/** `.sw` track, as used by FlatToggle and the FX rack's bypass switch. */
export function inspSwitchTrack(on: boolean): string {
  return `relative inline-flex h-4 w-7 shrink-0 items-center rounded-pill border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${
    on ? "border-fg-3 bg-surface-3" : "border-border-strong bg-surface-1 hover:border-fg-3"
  }`;
}

/** `.sw` knob. */
export function inspSwitchKnob(on: boolean): string {
  return `absolute left-0.5 top-0.5 size-2.5 rounded-full transition-transform ${
    on ? "translate-x-3 bg-fg" : "bg-fg-3"
  }`;
}

/** `.fx-look` / `.fx-ov-card`: a thumbnail card with a caption; selected = accent edge. */
export function inspPreviewCard(selected: boolean): string {
  return `grid min-w-0 overflow-hidden rounded-sm border text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
    selected
      ? "border-accent bg-surface-1 text-fg shadow-[inset_0_0_0_1px_var(--color-accent)]"
      : "border-border-subtle bg-surface-1 text-fg-2 hover:border-border-strong hover:text-fg"
  }`;
}

/** Inline style for an `hf-insp-rng` range: fills the track up to `value` within `[min, max]`. */
export function rangeFillStyle(
  value: number,
  min: number,
  max: number,
): CSSProperties & Record<"--p", string> {
  const pct = ((value - min) / Math.max(max - min, 1e-9)) * 100;
  return { "--p": `${Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0}%` };
}
