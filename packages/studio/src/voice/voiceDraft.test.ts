import { describe, expect, it } from "vitest";
import type { VoiceControl } from "@hyperframes/agent-protocol";
import {
  defaultSettings,
  languageFilter,
  languageFilterValue,
  presetDraftOf,
  presetVoiceOf,
  sampleKey,
  settingsFor,
  type VoiceDraft,
} from "./voiceDraft";
import { catalogEntry, ELEVEN_CONTROLS, GEMINI_CONTROLS } from "./voiceTestHarness";

const draft = (overrides: Partial<VoiceDraft> = {}): VoiceDraft => ({
  providerId: "gemini",
  model: "gemini-3.8-flash-tts",
  voice: { id: "Kore", name: "Kore", kind: "prebuilt" },
  style: "",
  settings: {},
  ...overrides,
});

describe("settings", () => {
  it("start at each control's default, sliders and switches alone", () => {
    expect(defaultSettings(ELEVEN_CONTROLS)).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      use_speaker_boost: true,
    });
    expect(defaultSettings(GEMINI_CONTROLS)).toEqual({});
  });

  it("keep the values a changed model still allows and reset the rest", () => {
    const kept = settingsFor(ELEVEN_CONTROLS, {
      stability: 0.2,
      similarity_boost: 7,
      use_speaker_boost: false,
      gone: 1,
    });
    // 7 is outside the slider's range, `gone` is no control any more.
    expect(kept).toEqual({ stability: 0.2, similarity_boost: 0.75, use_speaker_boost: false });
  });

  it("allow only the listed values of a stepped slider", () => {
    const stepped: VoiceControl[] = [
      {
        kind: "slider",
        id: "stability",
        min: 0,
        max: 1,
        step: 0.5,
        default: 0.5,
        values: [0, 0.5, 1],
      },
    ];
    expect(settingsFor(stepped, { stability: 1 })).toEqual({ stability: 1 });
    expect(settingsFor(stepped, { stability: 0.3 })).toEqual({ stability: 0.5 });
  });
});

describe("the sample's identity", () => {
  it("is the same for the same voice, delivery, settings and phrase, however the settings are ordered", () => {
    const a = draft({ settings: { b: 1, a: true } });
    const b = draft({ settings: { a: true, b: 1 } });
    expect(sampleKey(a, " Hello ")).toBe(sampleKey(b, "Hello"));
  });

  it("changes with the voice, the style, a setting, the model and the phrase", () => {
    const base = sampleKey(draft(), "Hello");
    expect(
      sampleKey(draft({ voice: { id: "Puck", name: "Puck", kind: "prebuilt" } }), "Hello"),
    ).not.toBe(base);
    expect(sampleKey(draft({ style: "calm" }), "Hello")).not.toBe(base);
    expect(sampleKey(draft({ settings: { speed: 1.1 } }), "Hello")).not.toBe(base);
    expect(sampleKey(draft({ model: "gemini-3.8-flash-lite-tts" }), "Hello")).not.toBe(base);
    expect(sampleKey(draft(), "Hello!")).not.toBe(base);
  });
});

describe("the draft as the server takes it", () => {
  it("is null until a voice is chosen, then trims the style and names the preset after the voice", () => {
    expect(presetDraftOf(draft({ voice: null }), "x")).toBeNull();
    expect(presetDraftOf(draft({ style: "  calm " }), "  ")).toEqual({
      name: "Kore",
      providerId: "gemini",
      model: "gemini-3.8-flash-tts",
      voice: { id: "Kore", name: "Kore", kind: "prebuilt" },
      style: "calm",
      settings: {},
    });
    expect(presetDraftOf(draft(), " Narrator ")?.name).toBe("Narrator");
  });

  it("keeps a designed voice's description and a catalog voice's first language", () => {
    expect(presetVoiceOf(catalogEntry({ languages: ["ru-RU", "en-US"] }), "en")).toEqual({
      id: "Kore",
      name: "Kore",
      kind: "prebuilt",
      language: "ru-RU",
    });
    expect(presetVoiceOf(catalogEntry({ languages: [] }), "de")).toMatchObject({ language: "de" });
    expect(presetVoiceOf(catalogEntry({ languages: [] }), null)).not.toHaveProperty("language");
  });
});

describe("the language prefilter", () => {
  const filters = [
    { id: "gender", options: ["female", "male"] },
    { id: "language_code", options: null },
  ];
  const choices = { id: "language", options: ["en-US", "ru-RU", "pt-BR"] };

  it("finds the filter that narrows by language, whatever it is called", () => {
    expect(languageFilter(filters)?.id).toBe("language_code");
    expect(languageFilter([{ id: "gender", options: null }])).toBeNull();
  });

  it("gives a free-text filter the script's language as it was given", () => {
    expect(languageFilterValue(filters[1], "ru")).toBe("ru");
    expect(languageFilterValue(filters[1], " ru-RU ")).toBe("ru-RU");
    expect(languageFilterValue(filters[1], "")).toBeNull();
  });

  it("picks, for a filter with choices, the choice that is that language", () => {
    expect(languageFilterValue(choices, "ru")).toBe("ru-RU");
    expect(languageFilterValue(choices, "pt-br")).toBe("pt-BR");
    expect(languageFilterValue(choices, "ja")).toBeNull();
  });
});
