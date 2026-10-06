import {
  type VoiceCatalogFilter,
  type VoiceCatalogEntry,
  type VoiceControl,
  type VoicePreset,
  type VoicePresetDraft,
  type VoicePresetVoice,
  type VoiceProviderId,
} from "@hyperframes/agent-protocol";

/** What the setup window holds while the user tries voices: a preset that is not saved yet. */
export interface VoiceDraft {
  providerId: VoiceProviderId;
  model: string;
  voice: VoicePresetVoice | null;
  style: string;
  settings: Record<string, number | boolean>;
}

export type SliderControl = Extract<VoiceControl, { kind: "slider" }>;
export type ToggleControl = Extract<VoiceControl, { kind: "toggle" }>;
export type CatalogControl = Extract<VoiceControl, { kind: "catalog" }>;
export type StyleControl = Extract<VoiceControl, { kind: "style" }>;
export type VoiceTextControl = Extract<VoiceControl, { kind: "voice_text" }>;
export type VoiceDesignControl = Extract<VoiceControl, { kind: "voice_design" }>;

/** The value of every slider and toggle of `controls`, at its default. */
export function defaultSettings(
  controls: readonly VoiceControl[],
): Record<string, number | boolean> {
  const settings: Record<string, number | boolean> = {};
  for (const control of controls) {
    if (control.kind === "slider" || control.kind === "toggle")
      settings[control.id] = control.default;
  }
  return settings;
}

/**
 * The settings after the controls changed (another model): values of controls that still exist stay, the rest start
 * at their default, and a value the control no longer allows is put back to the default.
 */
export function settingsFor(
  controls: readonly VoiceControl[],
  current: Readonly<Record<string, number | boolean>>,
): Record<string, number | boolean> {
  const settings = defaultSettings(controls);
  for (const control of controls) {
    if (control.kind === "slider") {
      const value = current[control.id];
      const allowed =
        typeof value === "number" &&
        value >= control.min &&
        value <= control.max &&
        (control.values === undefined || control.values.includes(value));
      if (allowed) settings[control.id] = value;
    } else if (control.kind === "toggle") {
      const value = current[control.id];
      if (typeof value === "boolean") settings[control.id] = value;
    }
  }
  return settings;
}

export function draftFromPreset(preset: VoicePreset): VoiceDraft {
  return {
    providerId: preset.providerId,
    model: preset.model,
    voice: preset.voice,
    style: preset.style,
    settings: { ...preset.settings },
  };
}

/** The draft as the server takes it (`POST /voice/sample`, `POST /voice/presets`), or null while no voice is chosen. */
export function presetDraftOf(
  draft: VoiceDraft,
  name: string,
): Omit<VoicePresetDraft, "sample"> | null {
  if (draft.voice === null) return null;
  return {
    name: name.trim() === "" ? draft.voice.name : name.trim(),
    providerId: draft.providerId,
    model: draft.model,
    voice: draft.voice,
    style: draft.style.trim(),
    settings: draft.settings,
  };
}

function sortedSettings(
  settings: Readonly<Record<string, number | boolean>>,
): Array<[string, number | boolean]> {
  return Object.entries(settings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Identity of one sample request: the same voice, delivery, settings and phrase make the same sound, so a sample that
 * was made for it is reused instead of asked for again.
 */
export function sampleKey(draft: VoiceDraft, text: string): string {
  return JSON.stringify([
    draft.providerId,
    draft.model,
    draft.voice?.id ?? null,
    draft.style.trim(),
    sortedSettings(draft.settings),
    text.trim(),
  ]);
}

/** The catalog filter that narrows by language (`language_code`, `language`), when the provider has one. */
export function languageFilter(filters: readonly VoiceCatalogFilter[]): VoiceCatalogFilter | null {
  return filters.find((filter) => /language/i.test(filter.id)) ?? null;
}

/**
 * What to put in the language filter for a script in `language` (BCP-47). A filter with fixed choices gets the choice
 * that is that language (`ru` finds `ru-RU`); a free-text filter gets the language as the agent gave it, the server
 * matches by primary subtag. Null when the filter has choices and none is that language.
 */
export function languageFilterValue(filter: VoiceCatalogFilter, language: string): string | null {
  const wanted = language.trim().toLowerCase();
  if (wanted === "") return null;
  if (filter.options === null) return language.trim();
  const primary = wanted.split("-")[0];
  return (
    filter.options.find((option) => option.toLowerCase() === wanted) ??
    filter.options.find((option) => option.toLowerCase().split("-")[0] === primary) ??
    null
  );
}

/** A voice picked from the catalog, as the preset keeps it. */
export function presetVoiceOf(entry: VoiceCatalogEntry, language: string | null): VoicePresetVoice {
  const voice: VoicePresetVoice = { id: entry.id, name: entry.name, kind: entry.kind };
  const spoken = entry.languages[0] ?? language;
  if (spoken) voice.language = spoken;
  return voice;
}
