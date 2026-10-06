import { useEffect } from "react";
import { useTranslation } from "../../i18n";
import { useVoiceStore, useVoiceStoreApi } from "../../voice/voiceContext";
import { VoicePresetsGroup } from "./VoicePresetsGroup";
import { VoiceProviderBlock } from "./VoiceProviderBlock";
import { SettingsGroup, SettingsPage } from "./settingsLayout";

/**
 * Settings › Voice (a beta section): the services that speak a script with the user's own key, and the voices saved
 * from them. Keys are written here and never read back; the Projects page edits the same files.
 */
export function VoiceSection() {
  const { t } = useTranslation();
  const store = useVoiceStoreApi();
  const providers = useVoiceStore((state) => state.providers);
  const loadError = useVoiceStore((state) => state.loadError);

  useEffect(() => {
    void store.getState().refresh();
  }, [store]);

  return (
    <SettingsPage title={t("settings.section.voice")} lede={t("voice.settings.lede")}>
      <SettingsGroup
        label={t("voice.settings.providers")}
        footer={t("voice.settings.providers.footer")}
      >
        {providers === null ? (
          <p
            role={loadError === null ? "status" : "alert"}
            className={`m-0 px-3 py-3 text-sm ${loadError === null ? "text-fg-3" : "text-error"}`}
          >
            {loadError ?? t("voice.settings.loading")}
          </p>
        ) : (
          providers.map((provider) => <VoiceProviderBlock key={provider.id} provider={provider} />)
        )}
      </SettingsGroup>
      <VoicePresetsGroup />
    </SettingsPage>
  );
}
