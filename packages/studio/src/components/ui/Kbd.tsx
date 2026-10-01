import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./cn";

/**
 * A key cap: "⌘K", "Space", "S". The prototype's `.kbd`, for tooltips, buttons,
 * menus, empty states and the status bar. Decorative by default, because the
 * control it sits on already carries the action's name.
 */
export function Kbd({ className, ...props }: ComponentPropsWithoutRef<"kbd">) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-xs border border-border px-1",
        "font-ui text-num leading-none font-medium tracking-[0.02em] tabular-nums text-fg-3",
        className,
      )}
      {...props}
    />
  );
}
