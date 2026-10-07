import { useState } from "react";
import { ClosedCaptioning } from "@phosphor-icons/react";
import { Button } from "../../components/ui";
import { useTranslation } from "../../i18n";
import { usePlayerStore } from "../../player";
import { useVoiceClipOpsContext } from "../clip/voiceClipOpsContext";
import { useVoiceEditLock } from "../script/useVoiceScript";

/**
 * "Add captions": captions for the narration on the timeline, written by the editing service from each line's own
 * text timed by its take's words (the same operation an agent calls). It says why it cannot run — an agent turn is
 * editing, or no voiceover clip is on the timeline yet — instead of just being grey.
 */
export function VoiceCaptionsButton() {
  const { t } = useTranslation();
  const ops = useVoiceClipOpsContext();
  const { reason: lockReason } = useVoiceEditLock();
  const hasVoiceClip = usePlayerStore((state) =>
    state.elements.some((element) => element.voiceLine !== undefined),
  );
  const [running, setRunning] = useState(false);

  const reason =
    lockReason ??
    (ops === null
      ? t("voice.captions.reason.unavailable")
      : hasVoiceClip
        ? null
        : t("voice.captions.reason.noClips"));

  return (
    <div data-testid="voice-captions" className="grid gap-1">
      <Button
        size="sm"
        variant="secondary"
        icon={<ClosedCaptioning aria-hidden size={12} />}
        data-testid="voice-captions-button"
        loading={running}
        disabled={reason !== null || running}
        aria-describedby={reason !== null ? "voice-captions-reason" : undefined}
        title={reason ?? t("voice.captions.hint")}
        onClick={() => {
          if (!ops) return;
          setRunning(true);
          void ops.addCaptions().finally(() => setRunning(false));
        }}
      >
        {t("voice.captions.button")}
      </Button>
      {reason !== null && (
        <p
          id="voice-captions-reason"
          data-testid="voice-captions-reason"
          className="m-0 text-xs leading-[15px] text-fg-3"
        >
          {reason}
        </p>
      )}
    </div>
  );
}
