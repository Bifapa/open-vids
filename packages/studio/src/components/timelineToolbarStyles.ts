// The timeline head's controls: 24px ghost icon buttons (`.icon-btn.sm`), the
// Select/Blade segmented pair (`.seg.sm`) and hairline separators.
export const flatBtn =
  "inline-flex size-ctl-sm shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 outline-hidden transition-colors focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
export const flatIdle = `${flatBtn} text-fg-2 hover:bg-surface-2 hover:text-fg active:bg-surface-3`;
export const flatActive = `${flatBtn} bg-surface-3 text-fg`;
export const flatDisabled = `${flatBtn} text-fg-disabled cursor-not-allowed`;

export const segGroup =
  "inline-flex shrink-0 gap-0.5 rounded-md border border-border bg-bg-0 p-0.5";
export const segButton =
  "inline-flex h-[18px] w-[26px] items-center justify-center rounded-sm border-0 bg-transparent p-0 text-fg-3 outline-hidden transition-colors hover:bg-surface-2 hover:text-fg aria-pressed:bg-surface-3 aria-pressed:text-fg aria-pressed:shadow-[inset_0_0_0_1px_var(--color-border-strong)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent";

export const toolbarSep = "mx-1 h-4 w-px shrink-0 bg-border";
