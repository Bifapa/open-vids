import { useEffect } from "react";
import { Info, Plugs } from "@phosphor-icons/react";
import { Button, Dialog, Input, SegmentedControl, Select, Spinner } from "../components/ui";
import { openSettings } from "../components/settings/settingsStore";
import { useTranslation } from "../i18n";
import { stopVoiceSound } from "./voiceAudio";
import { modelOptionLabel } from "./voiceLabels";
import { useVoiceSetup } from "./useVoiceSetup";
import { VoiceControlsForm } from "./VoiceControlsForm";
import { VoiceSamplePanel } from "./VoiceSamplePanel";
import type { VoiceSetupRequest } from "./voiceUiStore";

function Note({ children }: { children: string }) {
  return (
    <p className="m-0 flex items-start gap-1.5 rounded-sm bg-surface-1 px-2 py-1.5 text-xs leading-[15px] text-fg-2">
      <Info aria-hidden size={12} className="mt-px shrink-0 text-fg-3" />
      <span className="min-w-0 [text-wrap:pretty]">{children}</span>
    </p>
  );
}

/**
 * The voice setup window: the user's configured providers, the model, the voice and its delivery, and a sample of
 * their own phrase, ending in a saved preset. Everything between the provider and the sample is drawn from the
 * controls the provider's model reports (`VoiceControlsForm`), so a provider that cannot do something simply has no
 * control for it.
 */
export function VoiceSetupDialog({
  request,
  onClose,
}: {
  request: VoiceSetupRequest;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const setup = useVoiceSetup(request);
  const { controls } = setup;

  // Whatever is sounding stops with the window.
  useEffect(() => stopVoiceSound, []);

  const save = async () => {
    const preset = await setup.save();
    if (!preset) return;
    stopVoiceSound();
    request.onSaved?.(preset);
    onClose();
  };

  const connect = () => {
    onClose();
    openSettings("voice");
  };

  const model = controls?.models.find((item) => item.id === controls.model) ?? null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("voice.setup.title")}
      description={t("voice.setup.description")}
      className="w-[min(760px,calc(100vw-2rem))] max-h-[min(720px,calc(100vh-2rem))]"
      footer={
        setup.providers.length === 0 ? (
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        ) : (
          <>
            {setup.saveError !== null && (
              <span role="alert" className="mr-auto min-w-0 truncate text-xs text-error">
                {setup.saveError}
              </span>
            )}
            <Input
              value={setup.name}
              size="sm"
              aria-label={t("voice.setup.presetName")}
              placeholder={setup.draft.voice?.name ?? t("voice.setup.presetName")}
              maxLength={80}
              onCommit={setup.setName}
              className="w-44"
            />
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              data-testid="voice-setup-save"
              loading={setup.saving}
              disabled={setup.draft.voice === null}
              onClick={() => void save()}
            >
              {t("voice.setup.save")}
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-4" data-testid="voice-setup-dialog">
        {!setup.loaded ? (
          <div role="status" className="flex items-center gap-2 text-sm text-fg-3">
            <Spinner />
            {t("voice.setup.loading")}
          </div>
        ) : setup.providers.length === 0 ? (
          <div className="grid justify-items-start gap-2" data-testid="voice-setup-empty">
            <p className="m-0 text-sm text-fg-2">{t("voice.setup.noProvider")}</p>
            <Button
              size="sm"
              variant="primary"
              icon={<Plugs size={12} aria-hidden />}
              onClick={connect}
            >
              {t("voice.setup.connect")}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {setup.providers.length > 1 && setup.providerId !== null && (
                <SegmentedControl
                  label={t("voice.setup.provider")}
                  value={setup.providerId}
                  options={setup.providers.map((provider) => ({
                    value: provider.id,
                    label: provider.name,
                  }))}
                  onChange={setup.chooseProvider}
                />
              )}
              {controls !== null && controls.models.length > 0 && (
                <div className="min-w-[220px] flex-1">
                  <Select
                    label={t("voice.setup.model")}
                    value={controls.model}
                    options={controls.models.map((item) => ({
                      value: item.id,
                      label: modelOptionLabel(item),
                    }))}
                    onCommit={setup.chooseModel}
                  />
                </div>
              )}
            </div>
            {model?.dialectApproximate === true && controls && (
              <Note>
                {t("voice.setup.approximate", {
                  dialect: controls.dialect.name,
                  model: model.name,
                })}
              </Note>
            )}
            {request.suggestion.trim() !== "" && (
              <Note>{t("voice.setup.suggestion", { suggestion: request.suggestion.trim() })}</Note>
            )}
            {setup.controlsError !== null ? (
              <div role="alert" className="flex items-center gap-2 text-xs text-error">
                <span className="min-w-0 flex-1">{setup.controlsError}</span>
                <Button size="xs" variant="ghost" onClick={setup.retryControls}>
                  {t("common.tryAgain")}
                </Button>
              </div>
            ) : controls === null ? (
              <div role="status" className="flex items-center gap-2 text-sm text-fg-3">
                <Spinner />
                {t("voice.setup.loadingControls")}
              </div>
            ) : (
              <VoiceControlsForm
                // A new model starts its catalog and controls from scratch.
                key={`${controls.provider.id}:${controls.model}`}
                controls={controls}
                draft={setup.draft}
                language={request.language}
                onVoice={setup.setVoice}
                onStyle={setup.setStyle}
                onSetting={setup.setSetting}
              />
            )}
            <VoiceSamplePanel setup={setup} />
          </>
        )}
      </div>
    </Dialog>
  );
}
