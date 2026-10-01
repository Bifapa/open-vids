import { Pill } from "../../components/ui";
import { useTranslation } from "../../i18n";

/**
 * How many clips the track holds, as the outlined count pill beside the
 * track's name, so a multi-clip track reads as one at a glance.
 */
export function TrackClipCount({ clipCount }: { clipCount: number }) {
  const { t } = useTranslation();
  if (clipCount < 1) return null;
  const label = t("player.track.clipCount", { count: clipCount });
  return (
    <Pill tone="outline" aria-label={label} title={label} className="mr-0.5">
      {clipCount}
    </Pill>
  );
}
