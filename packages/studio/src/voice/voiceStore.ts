import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  UpdateVoiceProviderRequest,
  VoiceKeyCheckResult,
  VoicePreset,
  VoiceProviderId,
  VoiceProviderInfo,
} from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import type { SavePresetRequest, VoiceClient } from "./voiceClient";

/** What Studio shows of the global voice service: the providers and the preset library, read once and kept. */
export interface VoiceState {
  /** Null until the first read. */
  providers: VoiceProviderInfo[] | null;
  presets: VoicePreset[] | null;
  /** The last read failure, as the server worded it. */
  loadError: string | null;
  /** Which change is on its way (`key:<provider>`, `provider:<id>`, `check:<id>`, `preset:<id|new>`). */
  pending: string | null;

  /** Reads providers and presets again (a window opened, a key changed elsewhere). */
  refresh(): Promise<void>;
  refreshPresets(): Promise<void>;
  /** Resolve to the failure message, or null when the server accepted the change. */
  setApiKey(id: VoiceProviderId, key: string): Promise<string | null>;
  removeApiKey(id: VoiceProviderId): Promise<string | null>;
  updateProvider(id: VoiceProviderId, patch: UpdateVoiceProviderRequest): Promise<string | null>;
  /** The key check: a short phrase is synthesized; the sample is what the voice sounds like. */
  checkProvider(
    id: VoiceProviderId,
  ): Promise<{ ok: true; result: VoiceKeyCheckResult } | { ok: false; message: string }>;
  savePreset(
    request: SavePresetRequest,
    presetId?: string,
  ): Promise<{ ok: true; preset: VoicePreset } | { ok: false; message: string }>;
  deletePreset(presetId: string): Promise<string | null>;
}

export type VoiceStore = StoreApi<VoiceState>;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function createVoiceStore(client: VoiceClient): VoiceStore {
  return createStore<VoiceState>()((set, get) => {
    const replaceProvider = (provider: VoiceProviderInfo) =>
      set((state) => ({
        providers: (state.providers ?? []).some((known) => known.id === provider.id)
          ? (state.providers ?? []).map((known) => (known.id === provider.id ? provider : known))
          : [...(state.providers ?? []), provider],
      }));

    /** Runs one provider change; the server's answer is the provider as it now stands. */
    const changeProvider = async (
      pending: string,
      action: () => Promise<VoiceProviderInfo>,
    ): Promise<string | null> => {
      set({ pending });
      try {
        replaceProvider(await action());
        return null;
      } catch (error) {
        return messageOf(error, t("voice.error.notSaved"));
      } finally {
        set({ pending: null });
      }
    };

    return {
      providers: null,
      presets: null,
      loadError: null,
      pending: null,

      async refresh() {
        const [providers, presets] = await Promise.allSettled([
          client.providers(),
          client.presets(),
        ]);
        set({
          providers: providers.status === "fulfilled" ? providers.value : get().providers,
          presets: presets.status === "fulfilled" ? presets.value : get().presets,
          loadError:
            providers.status === "rejected"
              ? messageOf(providers.reason, t("voice.error.load"))
              : presets.status === "rejected"
                ? messageOf(presets.reason, t("voice.error.load"))
                : null,
        });
      },

      async refreshPresets() {
        try {
          set({ presets: await client.presets() });
        } catch (error) {
          set({ loadError: messageOf(error, t("voice.error.load")) });
        }
      },

      setApiKey: (id, key) => changeProvider(`key:${id}`, () => client.setApiKey(id, key)),
      removeApiKey: (id) => changeProvider(`key:${id}`, () => client.removeApiKey(id)),
      updateProvider: (id, patch) =>
        changeProvider(`provider:${id}`, () => client.updateProvider(id, patch)),

      async checkProvider(id) {
        set({ pending: `check:${id}` });
        try {
          return { ok: true, result: await client.checkProvider(id) };
        } catch (error) {
          return { ok: false, message: messageOf(error, t("voice.error.notChecked")) };
        } finally {
          set({ pending: null });
        }
      },

      async savePreset(request, presetId) {
        set({ pending: `preset:${presetId ?? "new"}` });
        try {
          const preset = presetId
            ? await client.updatePreset(presetId, request)
            : await client.createPreset(request);
          set((state) => {
            const known = state.presets ?? [];
            return {
              presets: known.some((item) => item.id === preset.id)
                ? known.map((item) => (item.id === preset.id ? preset : item))
                : [...known, preset],
            };
          });
          return { ok: true, preset };
        } catch (error) {
          return { ok: false, message: messageOf(error, t("voice.error.notSaved")) };
        } finally {
          set({ pending: null });
        }
      },

      async deletePreset(presetId) {
        set({ pending: `preset:${presetId}` });
        try {
          await client.deletePreset(presetId);
          set((state) => ({
            presets: (state.presets ?? []).filter((item) => item.id !== presetId),
          }));
          return null;
        } catch (error) {
          return messageOf(error, t("voice.error.notSaved"));
        } finally {
          set({ pending: null });
        }
      },
    };
  });
}

/** The providers that can synthesize now. */
export function configuredProviders(
  providers: readonly VoiceProviderInfo[] | null,
): VoiceProviderInfo[] {
  return (providers ?? []).filter((provider) => provider.configured);
}
