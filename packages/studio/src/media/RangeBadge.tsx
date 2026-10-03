import { Scissors } from "@phosphor-icons/react";
import type { AssetRange } from "@hyperframes/agent-protocol";
import { cn } from "../components/ui";
import { useTranslation } from "../i18n";
import { formatRangeLabel } from "./assetRange";
import { useAssetRange } from "./assetRangesStore";

/**
 * The mark of an asset the user picked a fragment of: scissors and `0:42–1:15`. `media` sits on a thumbnail, `inline`
 * on a row's own background. The tooltip says what the pick means.
 */
export function RangeBadge({
  range,
  tone = "media",
  className,
}: {
  range: AssetRange;
  tone?: "media" | "inline";
  className?: string;
}) {
  const { t } = useTranslation();
  const label = formatRangeLabel(range);
  const title = t("media.range.badgeTitle", { range: label });
  return (
    <span
      title={title}
      aria-label={title}
      data-testid="media-range-badge"
      className={cn(
        "inline-flex flex-none items-center gap-[3px] rounded-xs px-[5px] text-num leading-[14px] font-medium tabular-nums",
        tone === "media" ? "bg-on-media-bg text-on-media" : "bg-surface-2 text-fg-2",
        className,
      )}
    >
      <Scissors size={9} weight="bold" aria-hidden="true" />
      {label}
    </span>
  );
}

/** The badge of an asset by path, from the ranges store (nothing when no fragment is picked). */
export function AssetRangeBadge({
  asset,
  tone,
  className,
}: {
  asset: string;
  tone?: "media" | "inline";
  className?: string;
}) {
  const range = useAssetRange(asset);
  return range ? <RangeBadge range={range} tone={tone} className={className} /> : null;
}
