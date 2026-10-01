import { Check, Question, Quotes, WarningCircle, type Icon } from "@phosphor-icons/react";
import type { LicenseStatus } from "@hyperframes/agent-protocol";
import { Badge, cn } from "../components/ui";
import { LICENSE_STATUS_HINTS, LICENSE_STATUS_LABELS, LICENSE_STATUS_TONES } from "./licenseLabels";

const STATUS_ICONS: Record<LicenseStatus, Icon> = {
  clear: Check,
  attribution: Quotes,
  restricted: WarningCircle,
  unknown: Question,
};

/**
 * A license status as the prototype's status badge. `label` replaces the status word (a card shows "Pexels · CC0");
 * the tone and the leading mark always follow the status, so a restricted or unknown license reads as one at a glance.
 */
export function LicenseChip({
  status,
  label,
  title,
  size = "sm",
  className,
}: {
  status: LicenseStatus;
  label?: string;
  title?: string;
  /** `sm` 16 px for dense cards (default), `md` 18 px in lists. */
  size?: "sm" | "md";
  className?: string;
}) {
  const statusLabel = LICENSE_STATUS_LABELS[status];
  const StatusIcon = STATUS_ICONS[status];
  return (
    <Badge
      data-license-status={status}
      title={title ?? `${statusLabel}: ${LICENSE_STATUS_HINTS[status]}`}
      tone={LICENSE_STATUS_TONES[status]}
      size={size}
      className={cn("min-w-0 max-w-full", className)}
    >
      <StatusIcon
        size={size === "md" ? 12 : 10}
        weight={status === "clear" ? "bold" : "regular"}
        className="shrink-0"
        aria-hidden
      />
      <span className="truncate">{label ?? statusLabel}</span>
    </Badge>
  );
}
