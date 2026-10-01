import type { ReactNode } from "react";
import { WarningCircle, WarningOctagon } from "@phosphor-icons/react";
import { cn } from "./ui/cn";

export type StudioBannerTone = "warn" | "err";

const TONE: Record<StudioBannerTone, { box: string; icon: ReactNode }> = {
  warn: {
    box: "border-warning/40 bg-[color-mix(in_oklch,var(--color-warning)_12%,var(--color-bg-1))]",
    icon: <WarningCircle size={14} className="shrink-0 text-warning" aria-hidden />,
  },
  err: {
    box: "border-error/40 bg-[color-mix(in_oklch,var(--color-error)_12%,var(--color-bg-1))]",
    icon: <WarningOctagon size={14} className="shrink-0 text-error" aria-hidden />,
  },
};

/**
 * The prototype's workspace banner (`.ov-banner`): a floating, tone-washed card
 * centred over the workspace with an icon, one sentence and its actions. Every
 * file/server banner (conflict, save paused, unreachable, composition missing)
 * wears it so they read as one family.
 */
export function StudioBanner({
  tone,
  children,
  actions,
  zIndex = "z-92",
}: {
  tone: StudioBannerTone;
  children: ReactNode;
  /** Buttons after the sentence; `Button size="sm"` keeps the 36 px card height. */
  actions?: ReactNode;
  /** The stacking layer; the conflict banner sits above the others. */
  zIndex?: "z-92" | "z-94";
}) {
  return (
    <div
      role="alert"
      className={cn(
        "hf-backdrop-in absolute left-1/2 top-14 flex w-max max-w-[min(720px,calc(100vw-48px))] -translate-x-1/2 flex-wrap items-center gap-x-2.5 gap-y-1.5",
        "min-h-9 rounded-lg border py-[5px] pl-3 pr-1.5 text-sm leading-[17px] text-fg shadow-pop",
        TONE[tone].box,
        zIndex,
      )}
    >
      {TONE[tone].icon}
      <span className="min-w-0 flex-1 text-pretty [&_strong]:font-semibold">{children}</span>
      {actions && <span className="flex shrink-0 flex-wrap items-center gap-1">{actions}</span>}
    </div>
  );
}
