import type { VoicePreset } from "@hyperframes/agent-protocol";
import type { VoiceStore } from "./voiceStore";

/**
 * The library id of a project's voice. A project keeps a copy of its voice, and the agent's answer names a preset of
 * the user's library (the runtime refuses an id it does not know), so a copy whose preset was deleted is saved again
 * first (with its sample) and the new preset's id is used.
 */
export async function ensureLibraryPreset(
  store: VoiceStore,
  voice: VoicePreset,
): Promise<{ ok: true; presetId: string } | { ok: false; message: string }> {
  await store.getState().refreshPresets();
  if ((store.getState().presets ?? []).some((preset) => preset.id === voice.id))
    return { ok: true, presetId: voice.id };
  const saved = await store.getState().savePreset({
    preset: {
      name: voice.name,
      providerId: voice.providerId,
      model: voice.model,
      voice: voice.voice,
      style: voice.style,
      settings: voice.settings,
    },
    ...(voice.sample && { sampleHash: voice.sample.audio.hash, sampleText: voice.sample.text }),
  });
  return saved.ok ? { ok: true, presetId: saved.preset.id } : { ok: false, message: saved.message };
}
