import { memo } from "react";
import { SpeakerHigh, SpeakerLow, SpeakerX } from "@phosphor-icons/react";
import { IconButton } from "../../components/ui";

interface VolumeControlProps {
  audioMuted: boolean;
  audioVolume: number;
  disabled: boolean;
  setAudioMuted: (muted: boolean) => void;
  setAudioVolume: (volume: number) => void;
}

/** Mute button with the volume slider in a small float above it, shown on hover or focus. */
export const VolumeControl = memo(function VolumeControl({
  audioMuted,
  audioVolume,
  disabled,
  setAudioMuted,
  setAudioVolume,
}: VolumeControlProps) {
  const percentage = Math.round(audioVolume * 100);
  const silent = audioMuted || audioVolume === 0;
  const muteLabel = silent ? "Unmute audio" : "Mute audio";
  const Icon = silent ? SpeakerX : audioVolume >= 0.5 ? SpeakerHigh : SpeakerLow;

  return (
    <div className="group relative inline-flex shrink-0">
      <div
        className={
          "invisible absolute bottom-[calc(100%+6px)] left-1/2 z-50 flex w-[156px] -translate-x-1/2 items-center gap-2 " +
          "rounded-lg border border-border bg-menu-bg/94 px-2.5 py-1.5 opacity-0 shadow-pop backdrop-blur-md " +
          "transition-[opacity,visibility] delay-120 duration-120 " +
          "after:absolute after:inset-x-0 after:top-full after:h-2 after:content-[''] " +
          "group-focus-within:visible group-focus-within:opacity-100 group-focus-within:delay-0 " +
          "group-hover:visible group-hover:opacity-100 group-hover:delay-0"
        }
      >
        <div className="relative flex h-6 min-w-0 flex-1 items-center">
          <div className="absolute inset-x-0 h-0.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-fg-2" style={{ width: `${percentage}%` }} />
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={percentage}
            disabled={disabled}
            aria-label="Preview volume"
            aria-valuetext={`${percentage}%`}
            onChange={(event) => {
              const volume = Number(event.currentTarget.value) / 100;
              setAudioVolume(volume);
              if (audioMuted && volume > 0) setAudioMuted(false);
            }}
            className="hf-preview-volume-range absolute inset-0 w-full disabled:pointer-events-none"
          />
        </div>
        <span className="w-10 shrink-0 text-right font-mono text-num tabular-nums text-fg-2">
          {percentage}%
        </span>
      </div>

      {/* No tooltip: the volume float opens in the same spot on hover. */}
      <IconButton
        onClick={() => {
          if (silent && audioVolume === 0) setAudioVolume(1);
          setAudioMuted(!silent);
        }}
        disabled={disabled}
        aria-label={muteLabel}
        aria-pressed={silent}
        icon={<Icon size={16} />}
      />
    </div>
  );
});
