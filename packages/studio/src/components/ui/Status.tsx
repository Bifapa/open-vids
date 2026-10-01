/**
 * Status primitives from the prototype's "Status states": a badge, a count pill, a
 * status dot, a spinner and a thin progress meter. Tone always pairs a soft fill
 * with its own ink, so a status reads by colour and by text alike.
 */

import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./cn";

export type StatusTone = "neutral" | "success" | "warning" | "error";

const badgeTones: Record<StatusTone, string> = {
  neutral: "bg-surface-2 text-fg-2",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  error: "bg-error-soft text-error",
};

const badgeSizes = { md: "h-[18px] pl-[5px] pr-1.5 text-xs", sm: "h-4 px-[5px] text-2xs" } as const;
const spinnerSizes = { md: "size-3", sm: "size-2.5" } as const;
const meterSizes = { md: "h-[3px]", lg: "h-1" } as const;

interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
  tone?: StatusTone;
  /** `md` 18 px (default), `sm` 16 px for dense rows. */
  size?: "sm" | "md";
}

/** "Verified", "Failed", "Uncertain": a short status word, optionally with a leading icon. */
export function Badge({ tone = "neutral", size = "md", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-xs font-medium",
        badgeSizes[size],
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

const pillTones = {
  neutral: "bg-surface-3 text-fg",
  accent: "bg-accent text-accent-ink",
  warning: "bg-warning-soft text-warning",
  outline: "bg-bg-1 text-fg-2 font-medium shadow-[inset_0_0_0_1px_var(--color-border-strong)]",
} as const;

interface PillProps extends ComponentPropsWithoutRef<"span"> {
  tone?: keyof typeof pillTones;
}

/** A count: unread, queued, findings. Tabular digits on a 16 px pill. */
export function Pill({ tone = "neutral", className, ...props }: PillProps) {
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center whitespace-nowrap rounded-pill px-[5px]",
        "text-2xs leading-none font-semibold tabular-nums",
        pillTones[tone],
        className,
      )}
      {...props}
    />
  );
}

const dotTones = {
  idle: "bg-fg-3",
  new: "bg-fg-2",
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-error",
  off: "bg-transparent shadow-[inset_0_0_0_1.5px_var(--color-fg-3)]",
  running: "bg-fg-2 motion-safe:animate-pulse",
} as const;

export type StatusDotTone = keyof typeof dotTones;

interface StatusDotProps extends ComponentPropsWithoutRef<"span"> {
  tone?: StatusDotTone;
}

/** A 6 px state mark beside a label (Saved, Working, Stale, Error, Queued). Decorative. */
export function StatusDot({ tone = "idle", className, ...props }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-1.5 shrink-0 rounded-full", dotTones[tone], className)}
      {...props}
    />
  );
}

interface SpinnerProps extends ComponentPropsWithoutRef<"span"> {
  /** `md` 12 px (default), `sm` 10 px. */
  size?: "sm" | "md";
}

/** Indeterminate activity. The caller names the activity in text beside it. */
export function Spinner({ size = "md", className, ...props }: SpinnerProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 animate-spin rounded-full border-[1.5px] border-border-strong border-t-fg",
        "motion-reduce:[animation-duration:2.4s]",
        spinnerSizes[size],
        className,
      )}
      {...props}
    />
  );
}

interface MeterProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** 0–1. Clamped. */
  value: number;
  /** Names the progress for assistive tech ("Rendering"). */
  label: string;
  /** `md` 3 px (default), `lg` 4 px. */
  size?: "md" | "lg";
}

/** Determinate progress: a 3 px track with a neutral fill. */
export function Meter({ value, label, size = "md", className, ...props }: MeterProps) {
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      className={cn(
        "relative overflow-hidden rounded-[2px] bg-surface-3",
        meterSizes[size],
        className,
      )}
      {...props}
    >
      <div
        style={{ width: `${fraction * 100}%` }}
        className="h-full rounded-[inherit] bg-fg-2 transition-[width] duration-expand ease-out"
      />
    </div>
  );
}
