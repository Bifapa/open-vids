import { useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import type { VoicePreset } from "@hyperframes/agent-protocol";
import { Button, IconButton, Input } from "../ui";
import { formatDuration, useTranslation } from "../../i18n";
import { useVoiceStore, useVoiceStoreApi } from "../../voice/voiceContext";
import { useVoiceUi } from "../../voice/voiceUiStore";
import { VoicePlayButton } from "../../voice/VoicePlayButton";
import { SettingsGroup } from "./settingsLayout";

function PresetRow({ preset, providerName }: { preset: VoicePreset; providerName: string }) {
  const { t } = useTranslation();
  const store = useVoiceStoreApi();
  const pending = useVoiceStore((state) => state.pending);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = pending === `preset:${preset.id}`;

  const rename = async (name: string) => {
    const next = name.trim();
    if (next === "" || next === preset.name) return;
    setProblem(null);
    const saved = await store.getState().savePreset(
      {
        preset: {
          name: next,
          providerId: preset.providerId,
          model: preset.model,
          voice: preset.voice,
          style: preset.style,
          settings: preset.settings,
        },
        ...(preset.sample && {
          sampleHash: preset.sample.audio.hash,
          sampleText: preset.sample.text,
        }),
      },
      preset.id,
    );
    if (!saved.ok) setProblem(saved.message);
  };

  const remove = async () => {
    setProblem(null);
    const failure = await store.getState().deletePreset(preset.id);
    if (failure === null) setConfirming(false);
    else setProblem(failure);
  };

  return (
    <li
      data-preset-id={preset.id}
      className="grid gap-1.5 border-border-subtle px-3 py-2 not-first:border-t"
    >
      <div className="grid grid-cols-[28px_minmax(0,1fr)_28px] items-center gap-2.5">
        {preset.sample !== null ? (
          <VoicePlayButton
            soundKey={`preset:${preset.id}`}
            label={t("voice.settings.presets.play", { name: preset.name })}
            source={() => (preset.sample === null ? null : { url: preset.sample.audio.url })}
          />
        ) : (
          <span aria-hidden />
        )}
        <div className="grid min-w-0 gap-0.5">
          <Input
            value={preset.name}
            aria-label={t("voice.settings.presets.rename", { name: preset.name })}
            maxLength={80}
            disabled={busy}
            onCommit={(name) => void rename(name)}
          />
          <span className="truncate text-xs leading-[14px] text-fg-3">
            {[
              preset.voice.name,
              providerName,
              preset.model,
              preset.sample ? formatDuration(preset.sample.audio.durationSeconds) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <IconButton
          aria-label={t("voice.settings.presets.delete", { name: preset.name })}
          size="md"
          disabled={busy}
          icon={<Trash size={14} aria-hidden />}
          onClick={() => setConfirming(true)}
        />
      </div>
      {confirming && (
        <div
          role="group"
          aria-label={t("voice.settings.presets.confirmAria", { name: preset.name })}
          className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-surface-1 px-2 py-1.5 text-xs text-fg-2"
        >
          <span>{t("voice.settings.presets.confirm", { name: preset.name })}</span>
          <span className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {t("voice.settings.presets.keep")}
            </Button>
            <Button size="sm" variant="danger" loading={busy} onClick={() => void remove()}>
              {t("common.remove")}
            </Button>
          </span>
        </div>
      )}
      {problem !== null && (
        <p role="alert" className="m-0 text-xs text-error">
          {problem}
        </p>
      )}
    </li>
  );
}

/**
 * Saved voices: every preset of the user's library with its sample to play, a name to change and a way to delete it.
 * "New voice" opens the setup window without a script, on a general phrase.
 */
export function VoicePresetsGroup() {
  const { t } = useTranslation();
  const presets = useVoiceStore((state) => state.presets);
  const providers = useVoiceStore((state) => state.providers);
  const nameOf = (id: string) => providers?.find((provider) => provider.id === id)?.name ?? id;
  const anyConfigured = (providers ?? []).some((provider) => provider.configured);
  return (
    <SettingsGroup
      label={t("voice.settings.presets.title")}
      note={presets === null ? undefined : String(presets.length)}
      action={
        anyConfigured ? (
          <Button
            size="xs"
            variant="ghost"
            icon={<Plus size={12} aria-hidden />}
            onClick={() => useVoiceUi.getState().openSetup()}
          >
            {t("voice.settings.presets.new")}
          </Button>
        ) : undefined
      }
      footer={t("voice.settings.presets.footer")}
    >
      {presets === null || presets.length === 0 ? (
        <p className="m-0 px-3 py-3 text-sm text-fg-3" data-testid="voice-presets-empty">
          {presets === null ? t("voice.settings.loading") : t("voice.settings.presets.empty")}
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {presets.map((preset) => (
            <PresetRow key={preset.id} preset={preset} providerName={nameOf(preset.providerId)} />
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}
