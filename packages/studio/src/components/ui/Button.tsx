/**
 * Button — a native `<button>` wearing Studio's tokens.
 *
 * Everything visual comes from `theme.css`: the three control heights, the
 * radius scale, the semantic colours, the motion durations. No value is decided
 * here, so a button cannot drift from the rest of the system.
 *
 * Two conventions: classes merge through `cn`, so a caller's `className`
 * always wins within its group; and every interactive look is written twice,
 * once as the real state and once as `data-[preview-state=…]` (CSS-only, for
 * screenshots). `Button.test.tsx` asserts the two stay in sync.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

/** Forces one interactive look for a gallery shot. CSS-only; see the header. */
export type PreviewState = "hover" | "active" | "focus";

export interface ButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  "data-preview-state"?: PreviewState;
}

interface ButtonProps extends ButtonBaseProps {
  loading?: boolean;
  icon?: ReactNode;
}

/**
 * Shared by Button and IconButton. Every variant carries a 1px border (transparent
 * where the variant has none) so the four line up at one height. `disabled:`
 * keeps pointer events alive so a wrapping Tooltip can still explain why the
 * control is disabled.
 */
export const buttonBase = cn(
  "inline-flex items-center justify-center select-none cursor-pointer whitespace-nowrap border",
  "transition-[background-color,border-color,color] ease-standard duration-press",
  "disabled:cursor-not-allowed",
  "outline-hidden",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
  "data-[preview-state=focus]:outline-solid data-[preview-state=focus]:outline-2 data-[preview-state=focus]:outline-offset-1 data-[preview-state=focus]:outline-accent",
);

/**
 * One entry per variant, the prototype's `.btn` family. The `data-[preview-state=…]`
 * half of each string repeats the `hover:` and `active:` half exactly; the test
 * pairs them. Disabled controls go flat (no fill, a subtle edge, disabled ink)
 * rather than fading, so their label stays readable.
 */
export const buttonVariants: Record<ButtonVariant, string> = {
  primary: cn(
    "border-transparent bg-accent text-accent-ink font-semibold",
    "enabled:hover:bg-accent-hover data-[preview-state=hover]:bg-accent-hover",
    "enabled:active:bg-accent-press data-[preview-state=active]:bg-accent-press",
    "disabled:border-border-subtle disabled:bg-surface-1 disabled:text-fg-disabled",
  ),
  secondary: cn(
    "border-border bg-surface-1 text-fg font-medium",
    "enabled:hover:border-border-strong enabled:hover:bg-surface-2 data-[preview-state=hover]:border-border-strong data-[preview-state=hover]:bg-surface-2",
    "enabled:active:bg-surface-3 data-[preview-state=active]:bg-surface-3",
    "disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-disabled",
  ),
  danger: cn(
    "border-transparent bg-error text-bg-0 font-semibold",
    "enabled:hover:bg-error/90 data-[preview-state=hover]:bg-error/90",
    "enabled:active:bg-error/80 data-[preview-state=active]:bg-error/80",
    "disabled:border-border-subtle disabled:bg-surface-1 disabled:text-fg-disabled",
  ),
  ghost: cn(
    "border-transparent bg-transparent text-fg-2 font-medium",
    "enabled:hover:bg-surface-2 enabled:hover:text-fg data-[preview-state=hover]:bg-surface-2 data-[preview-state=hover]:text-fg",
    "enabled:active:bg-surface-3 data-[preview-state=active]:bg-surface-3",
    "aria-pressed:bg-surface-3 aria-pressed:text-fg",
    "disabled:text-fg-disabled",
  ),
};

/**
 * The four control heights, 20 / 24 / 28 / 32 px, from `--spacing-ctl-*`.
 * Panels use `sm`, window forms `md`, a prominent action `lg`.
 * Exported so the Capture download `<a href>` can wear the same recipe as a Button.
 */
export const buttonSizes: Record<ButtonSize, string> = {
  xs: "h-ctl-xs px-1.5 gap-1 rounded-sm text-xs",
  sm: "h-ctl-sm px-2 gap-1 rounded-sm text-sm",
  md: "h-ctl px-2.5 gap-1.5 rounded-md text-sm",
  lg: "h-ctl-lg px-3.5 gap-1.5 rounded-md text-sm",
};

function Spinner() {
  return (
    <svg className="animate-spin size-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = "secondary", size = "md", loading, icon, children, className, disabled, ...props },
    ref,
  ) => {
    const isDisabled = disabled || loading;
    let leading: ReactNode = null;
    if (loading) leading = <Spinner />;
    else if (icon) leading = <span className="shrink-0">{icon}</span>;
    return (
      <button
        ref={ref}
        disabled={isDisabled}
        // `aria-disabled` as well as `disabled`: assistive tech announces the
        // state even where the native attribute is filtered out of the tree.
        aria-disabled={isDisabled || undefined}
        className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], className)}
        {...props}
      >
        {leading}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
