// The timeline's own context menus (clip, gap, keyframe, automation range) wear
// the app menu recipe: blurred menu surface, 24px rows, accent highlight.
export const timelineMenuSurface =
  "fixed z-200 min-w-[180px] rounded-lg border border-border bg-menu-bg/94 p-1 text-sm shadow-pop backdrop-blur-xl";

export const timelineMenuSeparator = "mx-1.5 my-1 h-px bg-border";

export const timelineMenuShortcut =
  "ml-3 text-xs tabular-nums text-fg-3 group-hover:text-current group-focus-visible:text-current";

const ITEM_BASE =
  "group flex h-ctl-sm w-full items-center justify-between gap-6 rounded-sm px-2 text-left whitespace-nowrap outline-hidden";

export function timelineMenuItem(enabled: boolean, tone: "default" | "danger" = "default"): string {
  if (!enabled) return `${ITEM_BASE} cursor-not-allowed text-fg-disabled`;
  return tone === "danger"
    ? `${ITEM_BASE} cursor-pointer text-error hover:bg-error hover:text-bg-0 focus-visible:bg-error focus-visible:text-bg-0`
    : `${ITEM_BASE} cursor-pointer text-fg hover:bg-accent hover:text-accent-ink focus-visible:bg-accent focus-visible:text-accent-ink`;
}
