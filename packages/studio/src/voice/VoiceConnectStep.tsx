import { useState } from "react";
import { Gear } from "@phosphor-icons/react";
import type { VoiceProviderId } from "@hyperframes/agent-protocol";
import { Button, Select } from "../components/ui";
import { openSettings } from "../components/settings/settingsStore";
import { useTranslation } from "../i18n";
import { useVoiceStore } from "./voiceContext";
import { VoiceKeyControl } from "./VoiceKeyControl";
import { VoiceProviderNotes } from "./VoiceProviderNotes";

/**
 * The chat's connect step, for a user who has no voice service yet: pick a service, paste the key, hear the check
 * sample (the key is checked as soon as it is saved), then continue to the voice setup window. A custom server needs
 * an address and a model, so it is set up in Settings.
 */
export function VoiceConnectStep({ onReady }: { onReady: () => void }) {
  const { t } = useTranslation();
  const providers = useVoiceStore((state) => state.providers);
  // The custom server's address is set in OpenVids Settings on the Projects page; it is offered here only once it is.
  const choices = (providers ?? []).filter(
    (provider) => provider.id !== "custom" || provider.configured,
  );
  const [picked, setPicked] = useState<VoiceProviderId | null>(null);
  const [checked, setChecked] = useState<VoiceProviderId | null>(null);
  const provider = choices.find((item) => item.id === picked) ?? choices[0] ?? null;

  if (provider === null) return null;
  return (
    <div className="grid gap-2" data-testid="voice-connect">
      <p className="m-0 text-xs leading-[15px] text-fg-3">{t("voice.connect.lede")}</p>
      <Select
        label={t("voice.connect.provider")}
        value={provider.id}
        options={choices.map((item) => ({ value: item.id, label: item.name }))}
        onCommit={(next) => setPicked(choices.find((item) => item.id === next)?.id ?? null)}
      />
      <VoiceKeyControl
        key={provider.id}
        provider={provider}
        autoCheck
        onChecked={() => setChecked(provider.id)}
      />
      <VoiceProviderNotes provider={provider} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="primary"
          data-testid="voice-connect-continue"
          disabled={checked !== provider.id}
          onClick={onReady}
        >
          {t("voice.connect.continue")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Gear size={12} aria-hidden />}
          onClick={() => openSettings("voice")}
        >
          {t("voice.connect.settings")}
        </Button>
      </div>
    </div>
  );
}
