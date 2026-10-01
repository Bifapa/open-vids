import { Pill } from "../../components/ui";

/**
 * How many clips the track holds, as the outlined count pill beside the
 * track's name, so a multi-clip track reads as one at a glance.
 */
export function TrackClipCount({ clipCount }: { clipCount: number }) {
  if (clipCount < 1) return null;
  const label = clipCount === 1 ? "1 clip" : `${clipCount} clips`;
  return (
    <Pill tone="outline" aria-label={label} title={label} className="mr-0.5">
      {clipCount}
    </Pill>
  );
}
