import { ArrowsClockwise, LockSimple, PencilSimple } from "@phosphor-icons/react";
import { Badge, cn, type StatusTone } from "../components/ui";
import type { SyncBadge, SyncBadgeKind } from "./storySync";

const BADGE_TONES: Record<SyncBadgeKind, StatusTone> = {
  changed: "warning",
  locked: "warning",
  moves: "neutral",
  not_built: "neutral",
  edited: "neutral",
};

function BadgeIcon({ kind }: { kind: SyncBadgeKind }) {
  if (kind === "locked") return <LockSimple size={9} weight="fill" aria-hidden />;
  if (kind === "edited") return <PencilSimple size={9} aria-hidden />;
  if (kind === "moves") return <ArrowsClockwise size={9} aria-hidden />;
  return null;
}

/**
 * A node's Story ↔ timeline status (cards, inspector, impact dialog); nothing when in sync. `badge` is the shared
 * status badge; `flag` is the chip a chapter card draws over its frame (on-media ink, warnings with a dot).
 */
export function SyncBadges({
  badges,
  className,
  variant = "badge",
}: {
  badges: readonly SyncBadge[];
  className?: string;
  variant?: "badge" | "flag";
}) {
  if (badges.length === 0) return null;
  if (variant === "flag") {
    return badges.map((badge) => (
      <span
        key={badge.kind}
        title={badge.detail}
        data-sync-badge={badge.kind}
        className={
          badge.kind === "changed" || badge.kind === "locked" ? "hf-sg-flag hf-warn" : "hf-sg-flag"
        }
      >
        {badge.kind !== "changed" && badge.kind !== "locked" && <BadgeIcon kind={badge.kind} />}
        <span className="hf-sg-flag-label">{badge.label}</span>
      </span>
    ));
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)} data-story-sync="">
      {badges.map((badge) => (
        <Badge
          key={badge.kind}
          size="sm"
          tone={BADGE_TONES[badge.kind]}
          title={badge.detail}
          className={cn(
            badge.kind === "not_built" &&
              "bg-transparent shadow-[inset_0_0_0_1px_var(--color-border)]",
          )}
          data-sync-badge={badge.kind}
        >
          <BadgeIcon kind={badge.kind} />
          {badge.label}
        </Badge>
      ))}
    </div>
  );
}
