import type React from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { formatNumber, useTranslation } from "../../i18n";
import type { TimelineEditCallbacks } from "./timelineCallbacks";
import { TrackClipCount } from "./TrackClipCount";

/** The square 20px head control the eye, caret and spacers share. */
export const TRACK_HEAD_BUTTON =
  "flex size-ctl-xs shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

// Hide, plainly. The speaker variant was the mute presentation; with mute gone
// this is the visibility eye it always was, and audio rows do not render it.
export function VisibilityButton({
  hidden,
  trackNumber,
  trackDisplayNumber,
  visible,
  onToggle,
}: {
  hidden: boolean;
  trackNumber: number;
  trackDisplayNumber: number | null;
  visible: boolean;
  onToggle: TimelineEditCallbacks["onToggleTrackHidden"];
}) {
  const { t } = useTranslation();
  if (!visible) return <span aria-hidden="true" className="size-ctl-xs shrink-0" />;
  // Display number in the text, real key in the callback. The two must not be
  // conflated in either direction.
  const number = trackDisplayNumber === null ? null : formatNumber(trackDisplayNumber);
  let label: string;
  if (hidden) {
    label = number === null ? t("player.track.showBare") : t("player.track.show", { number });
  } else {
    label = number === null ? t("player.track.hideBare") : t("player.track.hide", { number });
  }
  const Icon = hidden ? EyeSlash : Eye;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`${TRACK_HEAD_BUTTON} ${
        hidden ? "bg-surface-3 text-fg" : "text-fg-3 hover:bg-surface-2 hover:text-fg"
      }`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        // Display number alongside the real key: the undo-history label must
        // announce the same row this button just did (see `onToggleTrackHidden`).
        void onToggle?.(trackNumber, !hidden, trackDisplayNumber);
      }}
    >
      <Icon className="size-icon-sm" aria-hidden="true" />
    </button>
  );
}

/** The track's kind code (V1, A2, CAP, MOT) in the head's fixed first column. */
export function TrackCode({ code }: { code: string | undefined }) {
  if (!code) return null;
  return (
    <span
      aria-hidden="true"
      className="min-w-[22px] shrink-0 font-mono text-num font-semibold text-fg-2"
    >
      {code}
    </span>
  );
}

// The header a track gets when it has no keyframe clip to disclose: caret slot,
// code, name, clip count, eye. Not deprecated — it is the live path for every
// track without lanes.
export function PlainTrackHeader({
  trackNumber,
  trackDisplayNumber,
  trackCode,
  trackLabel,
  clipCount,
  showTrackLabel,
  isTrackHidden,
  isAudioTrack,
  onToggleTrackHidden,
  leading,
  trailing,
}: {
  trackNumber: number;
  trackDisplayNumber: number | null;
  trackCode?: string;
  trackLabel: string;
  clipCount: number;
  isTrackHidden: boolean;
  isAudioTrack: boolean;
  onToggleTrackHidden: TimelineEditCallbacks["onToggleTrackHidden"];
  showTrackLabel: boolean;
  /** The lane disclosure caret, or nothing: the slot keeps every code aligned. */
  leading?: React.ReactNode;
  /** Trailing controls that belong on the control line — the FX entry points,
   *  which the caller owns because only it knows the clip they act on. */
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-[3px]">
      {leading ?? <span aria-hidden="true" className="w-4 shrink-0" />}
      {showTrackLabel && <TrackCode code={trackCode} />}
      {/* The name truncates and gives way; the controls are `shrink-0` and
          hold the right edge whatever the name's length. */}
      {showTrackLabel && (
        <span title={trackLabel} className="min-w-0 flex-1 truncate text-xs text-fg-3">
          {trackLabel}
        </span>
      )}
      {showTrackLabel && <TrackClipCount clipCount={clipCount} />}
      <div className="ml-auto flex shrink-0 items-center gap-[3px]">
        {/* Not on an audio track: the eye there silences rather than hides, and
            the row already says what it is. `visible={false}` keeps a spacer so
            every row's control columns stay aligned.

            EXCEPT when the audio track is ALREADY hidden. `data-hidden` silences
            the clip in preview and drops it from the render, and nothing else
            writes it back — so a track hidden by "Hide all" or by hand would be
            silent with no control anywhere to restore it. Offering the eye only
            in that state keeps it off a normal audio row while leaving the door
            open from the inside. */}
        <VisibilityButton
          hidden={isTrackHidden}
          trackNumber={trackNumber}
          trackDisplayNumber={trackDisplayNumber}
          visible={!isAudioTrack || isTrackHidden}
          onToggle={onToggleTrackHidden}
        />
        {trailing}
      </div>
    </div>
  );
}
