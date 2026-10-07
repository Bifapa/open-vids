import { useMemo, useState } from "react";
import { Waveform } from "@phosphor-icons/react";
import { Button } from "../../components/ui";
import { useTranslation } from "../../i18n";
import { usePlayerStore } from "../../player";
import { resolveCarveAvailability } from "../clip/voicePlacement";
import { useVoiceClipOpsContext } from "../clip/voiceClipOpsContext";
import { useVoiceEditLock } from "../script/useVoiceScript";

/**
 * "Carve music under the voiceover": the inspector's own voiceover carve, run for every music bed of the timeline
 * against the voiceover group when the user presses it. Never run by itself. It says why it cannot run (an agent turn
 * is editing, no voiceover on the timeline yet, no music) instead of just being grey.
 */
export function VoiceCarveButton() {
  const { t } = useTranslation();
  const ops = useVoiceClipOpsContext();
  const { reason: lockReason } = useVoiceEditLock();
  const elements = usePlayerStore((state) => state.elements);
  const availability = useMemo(() => resolveCarveAvailability(elements), [elements]);
  const [running, setRunning] = useState(false);

  const reason =
    lockReason ??
    (ops === null
      ? t("voice.carve.reason.unavailable")
      : availability.kind === "no-voice"
        ? t("voice.carve.reason.noVoice")
        : availability.kind === "no-music"
          ? t("voice.carve.reason.noMusic")
          : null);

  return (
    <div data-testid="voice-carve" className="grid gap-1">
      <Button
        size="sm"
        variant="secondary"
        icon={<Waveform aria-hidden size={12} />}
        data-testid="voice-carve-button"
        loading={running}
        disabled={reason !== null || running}
        aria-describedby={reason !== null ? "voice-carve-reason" : undefined}
        title={reason ?? t("voice.carve.hint")}
        onClick={() => {
          if (!ops) return;
          setRunning(true);
          void ops.carveMusic().finally(() => setRunning(false));
        }}
      >
        {t("voice.carve.button")}
      </Button>
      {reason !== null && (
        <p
          id="voice-carve-reason"
          data-testid="voice-carve-reason"
          className="m-0 text-xs leading-[15px] text-fg-3"
        >
          {reason}
        </p>
      )}
    </div>
  );
}
