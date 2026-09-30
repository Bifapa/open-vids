import { LockSimple } from "@phosphor-icons/react";
import { cn } from "../components/ui";
import type { SyncBadge, SyncBadgeKind } from "./storySync";

const BADGE_TONES: Record<SyncBadgeKind, string> = {
  changed: "border-container/40 bg-container/10 text-container",
  locked: "border-container/40 bg-container/10 text-container",
  moves: "border-border-input bg-bg-2 text-text-2",
  not_built: "border-dashed border-border-input bg-bg-2 text-text-2",
  edited: "border-selection/40 bg-selection/10 text-selection",
};

/** A node's Story ↔ timeline status as compact chips (cards, inspector, impact dialog); nothing when in sync. */
export function SyncBadges({
  badges,
  className,
}: {
  badges: readonly SyncBadge[];
  className?: string;
}) {
  if (badges.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)} data-story-sync="">
      {badges.map((badge) => (
        <span
          key={badge.kind}
          title={badge.detail}
          data-sync-badge={badge.kind}
          className={cn(
            "flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-px text-step-10 font-medium",
            BADGE_TONES[badge.kind],
          )}
        >
          {badge.kind === "locked" && <LockSimple size={9} weight="fill" aria-hidden />}
          {badge.label}
        </span>
      ))}
    </div>
  );
}
