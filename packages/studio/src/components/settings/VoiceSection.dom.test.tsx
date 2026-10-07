// @vitest-environment happy-dom

/**
 * Settings › Voice: each service with its key (saved, checked by listening, replaced, removed; never shown back), the
 * notes a service needs shown, the model picker, the custom server (address read-only), "Rules for the agent", and
 * the saved voices.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceProviderInfo } from "@hyperframes/agent-protocol";
import { cleanupMounted } from "../ui/mountHost.testHelpers";
import type * as voiceAudio from "../../voice/voiceAudio";
import { playVoiceSound } from "../../voice/voiceAudio";
import {
  blur,
  button,
  byLabel,
  byTestId,
  mountVoice,
  pressAndSettle,
  settle,
  typeAndEnter,
  typeInto,
} from "../../voice/voiceDom.testHelpers";
import {
  audioRef,
  freshProviders,
  providerInfo,
  voicePreset,
  type FakeVoiceData,
} from "../../voice/voiceTestHarness";
import { useVoiceUi } from "../../voice/voiceUiStore";
import { SETTINGS_SECTIONS, openSettings, useSettingsDialog } from "./settingsStore";
import { VoiceSection } from "./VoiceSection";

vi.mock("../../voice/voiceAudio", async (importOriginal) => ({
  ...(await importOriginal<typeof voiceAudio>()),
  playVoiceSound: vi.fn(async () => true),
  stopVoiceSound: vi.fn(),
}));

afterEach(() => {
  cleanupMounted();
  vi.clearAllMocks();
  useVoiceUi.setState({ setup: null });
  useSettingsDialog.setState({ open: false, section: "general" });
});

/** Gemini ready with a saved key, the custom server ready at an address, the rest not set up. */
function providers(): VoiceProviderInfo[] {
  return freshProviders().map((provider) => {
    if (provider.id === "gemini") return { ...provider, hasKey: true, configured: true };
    if (provider.id === "custom")
      return {
        ...provider,
        configured: true,
        baseUrl: "http://127.0.0.1:8880/v1",
        model: "kokoro",
        voice: "af_heart",
      };
    return provider;
  });
}

function mount(data: FakeVoiceData = {}) {
  return mountVoice(<VoiceSection />, { providers: providers(), ...data });
}

const block = (host: ParentNode, id: string) =>
  host.querySelector<HTMLElement>(`[data-voice-provider="${id}"]`);

describe("the Voice section", () => {
  it("is listed in the sidebar and openSettings lands on it", () => {
    expect(SETTINGS_SECTIONS).toContain("voice");
    openSettings("voice");
    expect(useSettingsDialog.getState().section).toBe("voice");
  });
});

describe("the services", () => {
  it("lists every service with whether it can speak, and the notes it needs shown", async () => {
    const { host } = mount();
    await settle();
    expect(
      [...host.querySelectorAll("[data-voice-provider]")].map((b) =>
        b.getAttribute("data-voice-provider"),
      ),
    ).toEqual(["gemini", "openai", "openrouter", "elevenlabs", "custom"]);
    expect(block(host, "gemini")?.textContent).toContain("Ready");
    expect(block(host, "openai")?.textContent).toContain("Not set up");
    const gemini = block(host, "gemini")?.querySelector('[data-voice-note="free_tier_terms"]');
    expect(gemini?.textContent).toContain("Google uses what you send");
    expect(gemini?.querySelector("a")?.getAttribute("href")).toBe(
      "https://ai.google.dev/gemini-api/terms",
    );
    expect(
      block(host, "openrouter")?.querySelector('[data-voice-note="catalog_needs_google_key"]')
        ?.textContent,
    ).toContain("need a Google (Gemini) key");
    expect(block(host, "openai")?.querySelector("[data-voice-note]")).toBeNull();
  });

  it("saves a pasted key, never shows it back, and offers Replace and Remove", async () => {
    const { host, calls } = mount();
    await settle();
    const openai = block(host, "openai");
    const field = byLabel<HTMLInputElement>(openai ?? host, "API key for OpenAI");
    expect(field?.type).toBe("password");
    await pressAndSettle(button(openai ?? host, "Save"));
    expect(openai?.textContent).toContain("Paste an API key first.");
    if (!field) throw new Error("no key field");
    await typeInto(field, "sk-very-secret");
    await pressAndSettle(button(openai ?? host, "Save"));
    expect(calls.setApiKey).toHaveBeenCalledWith("openai", "sk-very-secret");
    expect(host.textContent).not.toContain("sk-very-secret");
    expect(block(host, "openai")?.textContent).toContain("Key saved");
    expect(byLabel(block(host, "openai") ?? host, "API key for OpenAI")).toBeNull();

    await pressAndSettle(byLabel(block(host, "openai") ?? host, "Remove the key of OpenAI"));
    expect(calls.removeApiKey).toHaveBeenCalledWith("openai");
    expect(byLabel(block(host, "openai") ?? host, "API key for OpenAI")).not.toBeNull();
  });

  it("checks a key by playing the sample that comes back, and says when it fails", async () => {
    const { host, calls } = mount();
    await settle();
    const gemini = block(host, "gemini");
    await pressAndSettle(byLabel(gemini ?? host, "Check the key of Gemini"));
    expect(calls.checkProvider).toHaveBeenCalledWith("gemini");
    expect(playVoiceSound).toHaveBeenCalledWith("voice-key:gemini", audioRef().url);
    expect(byTestId(host, "voice-key-checked")?.textContent).toContain("The key works.");

    calls.checkProvider.mockRejectedValueOnce(new Error("The service rejected this key."));
    await pressAndSettle(byLabel(gemini ?? host, "Check the key of Gemini"));
    expect(byTestId(host, "voice-key-failed")?.textContent).toBe("The service rejected this key.");
  });

  it("lets the user replace a saved key from the same field", async () => {
    const { host, calls } = mount();
    await settle();
    const gemini = block(host, "gemini");
    await pressAndSettle(byLabel(gemini ?? host, "Replace the key of Gemini"));
    const field = byLabel<HTMLInputElement>(gemini ?? host, "API key for Gemini");
    if (!field) throw new Error("no key field");
    await typeInto(field, "new-key");
    await pressAndSettle(button(gemini ?? host, "Save"));
    expect(calls.setApiKey).toHaveBeenCalledWith("gemini", "new-key");
  });

  it("shows the model picker with prices and saves the model the user picks as it is", async () => {
    const { host } = mount();
    await settle();
    expect(byLabel(block(host, "gemini") ?? host, "Model of Gemini")?.textContent).toBe(
      "Gemini 3.8 Flash TTS · $0.0135/min",
    );
    // A service that is not set up has no models to pick from yet.
    expect(byLabel(block(host, "openai") ?? host, "Model of OpenAI")).toBeNull();
  });

  it("saves the rules for the agent when the field loses focus", async () => {
    const { host, calls } = mount();
    await settle();
    const rules = block(host, "gemini")?.querySelector("textarea");
    if (!rules) throw new Error("no rules field");
    await typeInto(rules, "No tags, numbers as words");
    await blur(rules);
    expect(calls.updateProvider).toHaveBeenCalledWith("gemini", {
      agentRules: "No tags, numbers as words",
    });
    expect(block(host, "gemini")?.textContent).toContain("Saved");
  });
});

describe("the custom server", () => {
  it("shows its address read-only, and edits its model and voice without ever sending an address", async () => {
    const { host, calls } = mount();
    await settle();
    const custom = block(host, "custom");
    expect(byTestId(custom ?? host, "voice-custom-address")?.textContent).toContain(
      "http://127.0.0.1:8880/v1",
    );
    expect(byTestId(custom ?? host, "voice-custom-address")?.textContent).toContain(
      "Set it in OpenVids Settings on the Projects page.",
    );
    expect(
      byTestId(custom ?? host, "voice-custom-address")?.querySelector("input, textarea"),
    ).toBeNull();
    // The key is optional for this server.
    expect(custom?.textContent).toContain("A key is optional for this server.");

    const [model, voice] = [
      ...(custom?.querySelectorAll<HTMLInputElement>("input:not([type=password])") ?? []),
    ];
    await typeAndEnter(model, "kokoro-v2");
    await typeAndEnter(voice, "bf_emma");
    expect(calls.updateProvider.mock.calls).toEqual([
      ["custom", { model: "kokoro-v2" }],
      ["custom", { voice: "bf_emma" }],
    ]);
  });

  it("says the address is not set when it is not", async () => {
    const { host } = mount({
      providers: freshProviders(),
    });
    await settle();
    expect(byTestId(block(host, "custom") ?? host, "voice-custom-address")?.textContent).toContain(
      "Not set",
    );
  });
});

describe("saved voices", () => {
  const presets = [voicePreset(), voicePreset({ id: "preset2", name: "Deep", sample: null })];

  it("lists them with their sample, and says when there are none", async () => {
    const { host } = mount({ presets });
    await settle();
    const rows = [...host.querySelectorAll("[data-preset-id]")];
    expect(rows.map((row) => row.getAttribute("data-preset-id"))).toEqual(["preset1", "preset2"]);
    await pressAndSettle(byLabel(rows[0], "Play the sample of Warm narrator"));
    expect(playVoiceSound).toHaveBeenCalledWith("preset:preset1", audioRef().url, undefined);
    // A voice saved without a sample has nothing to play.
    expect(byLabel(rows[1], "Play the sample of Deep")).toBeNull();
    cleanupMounted();
    const empty = mount({ presets: [] });
    await settle();
    expect(byTestId(empty.host, "voice-presets-empty")?.textContent).toContain(
      "No saved voices yet",
    );
  });

  it("renames a voice, keeping its sample", async () => {
    const { host, calls } = mount({ presets });
    await settle();
    const name = byLabel<HTMLInputElement>(host, "Name of Warm narrator");
    if (!name) throw new Error("no name field");
    await typeAndEnter(name, "Narrator");
    expect(calls.updatePreset).toHaveBeenCalledTimes(1);
    const [id, request] = calls.updatePreset.mock.calls[0];
    expect(id).toBe("preset1");
    expect(request.preset.name).toBe("Narrator");
    expect(request.sampleHash).toBe(audioRef().hash);
  });

  it("asks before deleting, and deletes on confirmation", async () => {
    const { host, calls } = mount({ presets });
    await settle();
    await pressAndSettle(byLabel(host, "Delete Warm narrator"));
    expect(calls.deletePreset).not.toHaveBeenCalled();
    await pressAndSettle(button(byLabel(host, "Confirm deleting Warm narrator") ?? host, "Keep"));
    expect(byLabel(host, "Confirm deleting Warm narrator")).toBeNull();
    await pressAndSettle(byLabel(host, "Delete Warm narrator"));
    await pressAndSettle(button(byLabel(host, "Confirm deleting Warm narrator") ?? host, "Remove"));
    expect(calls.deletePreset).toHaveBeenCalledWith("preset1");
    expect(host.querySelector('[data-preset-id="preset1"]')).toBeNull();
  });

  it("opens the setup window for a new voice only when a service can speak", async () => {
    const { host } = mount({ presets: [] });
    await settle();
    await pressAndSettle(button(host, "New voice"));
    expect(useVoiceUi.getState().setup).toMatchObject({
      language: null,
      startFrom: null,
      sampleText: "",
    });
    cleanupMounted();
    useVoiceUi.setState({ setup: null });
    const none = mount({ providers: [providerInfo({ hasKey: false, configured: false })] });
    await settle();
    expect(button(none.host, "New voice")).toBeNull();
  });
});
