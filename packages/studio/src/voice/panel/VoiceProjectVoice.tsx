import type { VoiceScriptView } from "@hyperframes/agent-protocol";
import { Microphone } from "@phosphor-icons/react";
import { Button } from "../../components/ui";
import { useTranslation } from "../../i18n";
import { useVoiceEditLock } from "../script/useVoiceScript";
import { useVoiceScriptStoreApi } from "../voiceContext";
import { useVoiceUi } from "../voiceUiStore";
import { VoicePlayButton } from "../VoicePlayButton";
import { voiceProviderName } from "../voiceProviderNames";

/**
 * The project's voice as one row: its name and where it comes from, a sample to play, and "Change", which opens the
 * voice setup window (the one the chat's card opens). A voice saved there becomes the project's voice at once.
 */
export function VoiceProjectVoice({ view }: { view: VoiceScriptView }) {
  const { t } = useTranslation();
  const scripts = useVoiceScriptStoreApi();
  const { reason } = useVoiceEditLock();
  const voice = view.voice;

  const openSetup = () =>
    useVoiceUi.getState().openSetup({
      language: view.language,
      sampleText: view.lines[0]?.text ?? "",
      startFrom: voice,
      onSaved: (preset) => void scripts.getState().setVoice(preset.id),
    });

  return (
    <div
      data-testid="voice-project-voice"
      className="flex min-w-0 items-center gap-2 rounded-sm bg-surface-1 px-2 py-1.5"
    >
      {voice?.sample ? (
        <VoicePlayButton
          soundKey="voiceover:project-voice"
          label={t("voice.chat.setup.play", { name: voice.name })}
          source={() => (voice.sample === null ? null : { url: voice.sample.audio.url })}
        />
      ) : (
        <Microphone aria-hidden className="size-icon-md shrink-0 text-fg-3" />
      )}
      <span className="grid min-w-0 flex-1 gap-px">
        <span
          data-testid="voice-project-voice-name"
          className="truncate text-sm font-medium leading-4 text-fg"
        >
          {voice ? voice.name : t("voice.panel.noVoice")}
        </span>
        {voice && (
          <span className="truncate text-xs leading-[14px] text-fg-3">
            {[voiceProviderName(voice.providerId), voice.voice.name, voice.model]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </span>
      <Button
        size="sm"
        variant={voice ? "secondary" : "primary"}
        data-testid="voice-project-voice-change"
        disabled={reason !== null}
        title={reason ?? undefined}
        onClick={openSetup}
      >
        {voice ? t("voice.chat.setup.change") : t("voice.chat.setup.choose")}
      </Button>
    </div>
  );
}
