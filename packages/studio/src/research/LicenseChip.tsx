import { WarningCircle } from "@phosphor-icons/react";
import type { LicenseStatus } from "@hyperframes/agent-protocol";
import { cn } from "../components/ui";
import {
  LICENSE_STATUS_HINTS,
  LICENSE_STATUS_LABELS,
  LICENSE_STATUS_TONES,
  isWarnedStatus,
} from "./licenseLabels";

/**
 * A license status as a compact chip. `label` replaces the status word (a card shows "Pexels · CC0"); the colour and
 * the warning mark always follow the status, so a restricted or unknown license reads as one at a glance.
 */
export function LicenseChip({
  status,
  label,
  title,
  className,
}: {
  status: LicenseStatus;
  label?: string;
  title?: string;
  className?: string;
}) {
  const statusLabel = LICENSE_STATUS_LABELS[status];
  return (
    <span
      data-license-status={status}
      title={title ?? `${statusLabel}: ${LICENSE_STATUS_HINTS[status]}`}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-px text-step-10 font-medium",
        LICENSE_STATUS_TONES[status],
        className,
      )}
    >
      {isWarnedStatus(status) && (
        <WarningCircle size={10} weight="fill" className="shrink-0" aria-hidden />
      )}
      <span className="truncate">{label ?? statusLabel}</span>
    </span>
  );
}
