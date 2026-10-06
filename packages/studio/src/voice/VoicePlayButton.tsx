import { useState } from "react";
import { Play, Stop, WarningCircle } from "@phosphor-icons/react";
import { useTranslation } from "../i18n";
import { Button, IconButton } from "../components/ui";
import {
  listenWithVideo,
  playVoiceSound,
  stopVoiceSound,
  useVoiceSound,
  type SoundRange,
} from "./voiceAudio";

/** What a play button plays: a URL (and a stretch of it), or null when the sound could not be made. */
export interface VoiceSoundSource {
  url: string;
  range?: SoundRange;
}

interface VoicePlayButtonProps {
  /** Names the sound across the app: the one with this key shows Stop while it sounds. */
  soundKey: string;
  /** Accessible name while stopped ("Play the sample of Kore"). */
  label: string;
  /** Resolves the sound when the button is pressed (a sample may have to be made first); null: nothing to play. */
  source: () => VoiceSoundSource | Promise<VoiceSoundSource | null> | null;
  /** `icon` is a square play button; `text` shows `children` beside the glyph. */
  variant?: "icon" | "text";
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  children?: string;
  /** Play from the playhead together with the composition ("Listen with video"); both stop together. */
  withVideo?: boolean;
}

/**
 * Play / Stop of one voice sound. Only one voice sound plays at a time across Studio, so starting this stops any
 * other and the button shows Stop while its own sound sounds. A sound that cannot be played says so on the button.
 */
export function VoicePlayButton({
  soundKey,
  label,
  source,
  variant = "icon",
  size = "sm",
  disabled,
  children,
  withVideo = false,
}: VoicePlayButtonProps) {
  const { t } = useTranslation();
  const playing = useVoiceSound((state) => state.playingKey === soundKey);
  const failed = useVoiceSound((state) => state.failedKey === soundKey);
  const [starting, setStarting] = useState(false);

  const toggle = async () => {
    if (playing) return stopVoiceSound();
    setStarting(true);
    try {
      const sound = await source();
      if (sound) {
        if (withVideo) await listenWithVideo(soundKey, sound.url);
        else await playVoiceSound(soundKey, sound.url, sound.range);
      }
    } finally {
      setStarting(false);
    }
  };

  const glyph = failed ? (
    <WarningCircle aria-hidden size={12} weight="fill" className="text-error" />
  ) : playing ? (
    <Stop aria-hidden size={12} weight="fill" />
  ) : (
    <Play aria-hidden size={12} weight="fill" />
  );
  const name = playing ? t("voice.play.stop") : failed ? t("voice.play.failed", { label }) : label;

  if (variant === "icon") {
    return (
      <IconButton
        aria-label={name}
        title={name}
        size={size}
        disabled={disabled || starting}
        aria-pressed={playing}
        data-sound-key={soundKey}
        icon={glyph}
        onClick={() => void toggle()}
      />
    );
  }
  return (
    <Button
      size={size}
      variant="secondary"
      icon={glyph}
      loading={starting}
      disabled={disabled}
      aria-pressed={playing}
      data-sound-key={soundKey}
      onClick={() => void toggle()}
    >
      {playing ? t("voice.play.stop") : (children ?? label)}
    </Button>
  );
}
