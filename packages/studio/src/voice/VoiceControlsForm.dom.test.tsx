// @vitest-environment happy-dom

/**
 * The voice setup window's controls are drawn from what the provider's model reports: a capability the provider does
 * not have has no control at all (no disabled stand-ins), labels fall back to a readable name, and the catalog opens
 * filtered by the script's language.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceCatalogPage, VoiceControl, VoicePresetVoice } from "@hyperframes/agent-protocol";
import type * as voiceAudio from "./voiceAudio";
import { cleanupMounted } from "../components/ui/mountHost.testHelpers";
import { byLabel, mountVoice, pressAndSettle, settle } from "./voiceDom.testHelpers";
import { VoiceControlsForm } from "./VoiceControlsForm";
import type { VoiceDraft } from "./voiceDraft";
import {
  catalogEntry,
  catalogPage,
  ELEVEN_CONTROLS,
  GEMINI_CONTROLS,
  providerControls,
} from "./voiceTestHarness";
import { defaultSettings } from "./voiceDraft";

vi.mock("./voiceAudio", async (importOriginal) => ({
  ...(await importOriginal<typeof voiceAudio>()),
  playVoiceSound: vi.fn(async () => true),
  stopVoiceSound: vi.fn(),
}));

afterEach(() => {
  cleanupMounted();
  vi.clearAllMocks();
});

const draftOf = (overrides: Partial<VoiceDraft> = {}): VoiceDraft => ({
  providerId: "gemini",
  model: "gemini-3.8-flash-tts",
  voice: null,
  style: "",
  settings: {},
  ...overrides,
});

function mount(
  controls: VoiceControl[],
  options: {
    draft?: Partial<VoiceDraft>;
    language?: string | null;
    catalog?: VoiceCatalogPage | Error;
  } = {},
) {
  const onVoice = vi.fn<(voice: VoicePresetVoice) => void>();
  const onStyle = vi.fn<(style: string) => void>();
  const onSetting = vi.fn<(id: string, value: number | boolean) => void>();
  const mounted = mountVoice(
    <VoiceControlsForm
      controls={providerControls({ controls })}
      draft={draftOf({ settings: defaultSettings(controls), ...options.draft })}
      language={options.language ?? null}
      onVoice={onVoice}
      onStyle={onStyle}
      onSetting={onSetting}
    />,
    options.catalog ? { catalog: options.catalog } : {},
  );
  return { ...mounted, onVoice, onStyle, onSetting };
}

const control = (host: ParentNode, id: string) =>
  host.querySelector(`[data-voice-control="${id}"]`);
const headings = (host: ParentNode) =>
  [...host.querySelectorAll("h3")].map((heading) => heading.textContent);

describe("controls drawn from a provider's capabilities", () => {
  it("draws Gemini's catalog, voice design and style, and no sliders or switches", async () => {
    const { host } = mount(GEMINI_CONTROLS);
    await settle();
    expect(control(host, "catalog")).not.toBeNull();
    expect(control(host, "voice_design")).not.toBeNull();
    expect(control(host, "style:style")).not.toBeNull();
    expect(host.querySelector('[data-voice-control^="slider"]')).toBeNull();
    expect(host.querySelector('[data-voice-control^="toggle"]')).toBeNull();
    expect(control(host, "voice_text")).toBeNull();
    expect(headings(host)).toEqual(["Voice", "Delivery"]);
    // The catalog's own filters: free text for the language, choices for the gender.
    expect(byLabel(host, "Language")?.tagName).toBe("INPUT");
    expect(byLabel(host, "Gender")?.getAttribute("role")).toBe("combobox");
  });

  it("draws ElevenLabs' sliders and switch with their values, and no style field or voice design", async () => {
    const { host, onSetting } = mount(ELEVEN_CONTROLS);
    await settle();
    expect(control(host, "catalog")).not.toBeNull();
    expect(control(host, "voice_design")).toBeNull();
    expect(host.querySelector('[data-voice-control^="style"]')).toBeNull();
    const stability = control(host, "slider:stability");
    expect(stability?.textContent).toContain("Stability");
    expect(stability?.textContent).toContain("0.5");
    expect(control(host, "slider:similarity_boost")?.textContent).toContain("0.75");
    const boost = host.querySelector<HTMLElement>('[role="switch"][aria-label="Speaker boost"]');
    expect(boost?.getAttribute("aria-checked")).toBe("true");
    await pressAndSettle(boost);
    expect(onSetting).toHaveBeenCalledWith("use_speaker_boost", false);
  });

  it("draws a bare voice-name field for a server with nothing else, and no delivery section", async () => {
    const { host, onVoice } = mount([{ kind: "voice_text", maxChars: 100 }], {
      draft: { providerId: "custom", voice: { id: "af_heart", name: "af_heart", kind: "custom" } },
    });
    await settle();
    const field = byLabel<HTMLInputElement>(host, "Voice name");
    expect(field?.value).toBe("af_heart");
    expect(control(host, "catalog")).toBeNull();
    expect(headings(host)).toEqual(["Voice"]);
    expect(onVoice).not.toHaveBeenCalled();
  });

  it("draws nothing for a model that reports no controls", async () => {
    const { host } = mount([]);
    await settle();
    expect(headings(host)).toEqual([]);
    expect(host.querySelector("[data-voice-control]")).toBeNull();
  });

  it("gives a control Studio has no wording for a readable label, and a stepped slider only its values", async () => {
    const { host, onSetting } = mount([
      { kind: "slider", id: "pitch_shift", min: 0, max: 1, step: 0.1, default: 0.3 },
      {
        kind: "slider",
        id: "stability",
        min: 0,
        max: 1,
        step: 0.5,
        default: 0.5,
        values: [0, 0.5, 1],
      },
      { kind: "toggle", id: "breathy_mode", default: false },
    ]);
    await settle();
    expect(control(host, "slider:pitch_shift")?.textContent).toContain("Pitch shift");
    expect(control(host, "toggle:breathy_mode")?.textContent).toContain("Breathy mode");
    const stepped = control(host, "slider:stability");
    const options = [...(stepped?.querySelectorAll('[role="radio"]') ?? [])].map(
      (o) => o.textContent,
    );
    expect(options).toEqual(["0", "0.5", "1"]);
    const one = [...(stepped?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])].find(
      (option) => option.textContent === "1",
    );
    await pressAndSettle(one);
    expect(onSetting).toHaveBeenCalledWith("stability", 1);
  });

  it("shows the style as the field the model calls it: style, or instructions", async () => {
    const style = mount([{ kind: "style", target: "style", maxChars: 200 }]);
    await settle();
    expect(
      style.host.querySelector('[data-voice-control="style:style"] label')?.textContent,
    ).toContain("Style");
    cleanupMounted();
    const instructions = mount([{ kind: "style", target: "instructions", maxChars: 1000 }], {
      draft: { style: "calm" },
    });
    await settle();
    const field = instructions.host.querySelector<HTMLTextAreaElement>(
      '[data-voice-control="style:instructions"] textarea',
    );
    expect(field?.value).toBe("calm");
    expect(
      instructions.host.querySelector('[data-voice-control="style:instructions"] label')
        ?.textContent,
    ).toContain("Instructions");
  });
});

describe("the catalog", () => {
  it("opens filtered by the script's language and sends the model with the request", async () => {
    const { calls } = mount(GEMINI_CONTROLS, { language: "ru" });
    await settle();
    expect(calls.voices).toHaveBeenCalledTimes(1);
    expect(calls.voices.mock.calls[0][1]).toEqual({
      filters: { language_code: "ru" },
      model: "gemini-3.8-flash-tts",
    });
  });

  it("opens unfiltered when the script has no language or the provider has no language filter", async () => {
    const noLanguage = mount(GEMINI_CONTROLS);
    await settle();
    expect(noLanguage.calls.voices.mock.calls[0][1].filters).toEqual({});
    cleanupMounted();
    const noFilter = mount(ELEVEN_CONTROLS, { language: "ru" });
    await settle();
    expect(noFilter.calls.voices.mock.calls[0][1].filters).toEqual({});
  });

  it("picks a voice with its characteristics and marks the chosen one", async () => {
    const { host, onVoice } = mount(GEMINI_CONTROLS, {
      draft: { voice: { id: "Puck", name: "Puck", kind: "prebuilt" } },
      catalog: catalogPage([
        catalogEntry(),
        catalogEntry({
          id: "Puck",
          name: "Puck",
          description: "Upbeat",
          labels: { gender: "male" },
        }),
      ]),
    });
    await settle();
    const rows = [...host.querySelectorAll("[data-voice-id]")];
    expect(rows.map((row) => row.getAttribute("data-voice-id"))).toEqual(["Kore", "Puck"]);
    expect(rows[0].textContent).toContain("female · neutral · Firm");
    expect(rows[1].querySelector("button")?.getAttribute("aria-pressed")).toBe("true");
    await pressAndSettle(rows[0].querySelector("button"));
    expect(onVoice).toHaveBeenCalledWith({
      id: "Kore",
      name: "Kore",
      kind: "prebuilt",
      language: "en-US",
    });
  });

  it("offers a free demo only for a voice the provider hosts a sample of, and only where demos are the preview", async () => {
    const withDemo = mount(ELEVEN_CONTROLS, {
      catalog: catalogPage([
        catalogEntry({ id: "v1", name: "Rachel", previewUrl: "https://cdn.example/rachel.mp3" }),
        catalogEntry({ id: "v2", name: "Adam", previewUrl: null }),
      ]),
    });
    await settle();
    expect(byLabel(withDemo.host, "Play the provider’s demo of Rachel")).not.toBeNull();
    expect(byLabel(withDemo.host, "Play the provider’s demo of Adam")).toBeNull();
    cleanupMounted();
    // Gemini's voices have no hosted sample: the preview is a synthesis, never a demo button.
    const synthesized = mount(GEMINI_CONTROLS, {
      catalog: catalogPage([catalogEntry({ previewUrl: "https://cdn.example/x.mp3" })]),
    });
    await settle();
    expect(byLabel(synthesized.host, "Play the provider’s demo of Kore")).toBeNull();
  });

  it("says so when the filters match nothing", async () => {
    const { host } = mount(GEMINI_CONTROLS, { catalog: catalogPage([]) });
    await settle();
    expect(host.textContent).toContain("No voices match these filters.");
  });

  it("says so, with a way to try again, when the catalog cannot be read", async () => {
    const { host, calls } = mount(GEMINI_CONTROLS, { catalog: new Error("Catalog is down") });
    await settle();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t load the voices: Catalog is down");
    await pressAndSettle(alert?.querySelector("button"));
    expect(calls.voices).toHaveBeenCalledTimes(2);
  });
});
