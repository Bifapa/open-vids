import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  VoicePreset,
  VoicePresetVoice,
  VoiceProviderControls,
  VoiceProviderId,
  VoiceProviderInfo,
} from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import { useVoiceClient, useVoiceStore, useVoiceStoreApi } from "./voiceContext";
import { presetDraftOf, sampleKey, settingsFor, type VoiceDraft } from "./voiceDraft";
import { configuredProviders } from "./voiceStore";
import type { VoiceSetupRequest } from "./voiceUiStore";
import { useVoiceSamples, type SampleEntry, type VoiceSamples } from "./useVoiceSamples";

export interface VoiceSetup {
  /** Providers that can synthesize now; empty means there is nothing to set up yet. */
  providers: VoiceProviderInfo[];
  /** False until the provider list was read once. */
  loaded: boolean;
  providerId: VoiceProviderId | null;
  chooseProvider(id: VoiceProviderId): void;
  /** The provider's controls for the chosen model; null while they load. */
  controls: VoiceProviderControls | null;
  controlsError: string | null;
  retryControls(): void;
  chooseModel(model: string): void;
  draft: VoiceDraft;
  setVoice(voice: VoicePresetVoice): void;
  setStyle(style: string): void;
  setSetting(id: string, value: number | boolean): void;
  /** Puts a compared draft back as the current one. */
  adopt(draft: VoiceDraft): void;
  text: string;
  setText(text: string): void;
  name: string;
  setName(name: string): void;
  samples: VoiceSamples;
  /** The sample made for exactly the current draft and phrase, when there is one. */
  currentSample: SampleEntry | null;
  saving: boolean;
  saveError: string | null;
  save(): Promise<VoicePreset | null>;
}

/**
 * The state of the voice setup window: the provider and model, the controls of that model, the draft the user is
 * trying (voice, style, settings), the phrase every sample speaks, and the save. The window itself only draws it.
 */
export function useVoiceSetup(request: VoiceSetupRequest): VoiceSetup {
  const client = useVoiceClient();
  const storeApi = useVoiceStoreApi();
  const allProviders = useVoiceStore((state) => state.providers);
  const refresh = useVoiceStore((state) => state.refresh);
  const start = request.startFrom;
  const providers = useMemo(() => configuredProviders(allProviders), [allProviders]);

  const [wantedProvider, setWantedProvider] = useState<VoiceProviderId | null>(
    start?.providerId ?? null,
  );
  const [wantedModel, setWantedModel] = useState<string | null>(start?.model ?? null);
  const [voice, setVoiceState] = useState<VoicePresetVoice | null>(start?.voice ?? null);
  const [style, setStyleState] = useState(start?.style ?? "");
  const [settings, setSettings] = useState<Record<string, number | boolean>>(
    start ? { ...start.settings } : {},
  );
  const [controls, setControls] = useState<VoiceProviderControls | null>(null);
  const [controlsError, setControlsError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [text, setText] = useState(request.sampleText.trim() || t("voice.setup.defaultSample"));
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const samples = useVoiceSamples(client);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const providerId =
    wantedProvider !== null && providers.some((provider) => provider.id === wantedProvider)
      ? wantedProvider
      : (providers[0]?.id ?? null);

  useEffect(() => {
    if (providerId === null) return;
    const controller = new AbortController();
    setControls(null);
    setControlsError(null);
    client
      .controls(providerId, wantedModel ?? undefined, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setControls(next);
        setSettings(settingsFor(next.controls, settingsRef.current));
        // A model without a style field keeps no style.
        if (!next.controls.some((control) => control.kind === "style")) setStyleState("");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setControlsError(error instanceof Error ? error.message : t("voice.setup.controlsFailed"));
      });
    return () => controller.abort();
  }, [client, providerId, wantedModel, reload]);

  const draft = useMemo<VoiceDraft>(
    () => ({
      providerId: providerId ?? start?.providerId ?? "gemini",
      model: controls?.model ?? wantedModel ?? "",
      voice,
      style,
      settings,
    }),
    [providerId, controls, wantedModel, voice, style, settings, start],
  );

  const chooseProvider = useCallback((id: VoiceProviderId) => {
    setWantedProvider(id);
    setWantedModel(null);
    setVoiceState(null);
    setStyleState("");
    setSettings({});
  }, []);

  const adopt = useCallback((next: VoiceDraft) => {
    setWantedProvider(next.providerId);
    setWantedModel(next.model);
    setVoiceState(next.voice);
    setStyleState(next.style);
    setSettings({ ...next.settings });
  }, []);

  const currentSample = samples.entries[sampleKey(draft, text)] ?? null;

  const save = useCallback(async (): Promise<VoicePreset | null> => {
    const preset = presetDraftOf(draft, name);
    if (preset === null) return null;
    setSaving(true);
    setSaveError(null);
    const sampleReady = currentSample?.status === "ready" ? currentSample.result : null;
    const saved = await storeApi.getState().savePreset({
      preset,
      ...(sampleReady && { sampleHash: sampleReady.audio.hash, sampleText: text.trim() }),
    });
    setSaving(false);
    if (!saved.ok) {
      setSaveError(saved.message);
      return null;
    }
    return saved.preset;
  }, [draft, name, currentSample, storeApi, text]);

  return {
    providers,
    loaded: allProviders !== null,
    providerId,
    chooseProvider,
    controls,
    controlsError,
    retryControls: () => setReload((count) => count + 1),
    chooseModel: setWantedModel,
    draft,
    setVoice: setVoiceState,
    setStyle: setStyleState,
    setSetting: (id, value) => setSettings((current) => ({ ...current, [id]: value })),
    adopt,
    text,
    setText,
    name,
    setName,
    samples,
    currentSample,
    saving,
    saveError,
    save,
  };
}
