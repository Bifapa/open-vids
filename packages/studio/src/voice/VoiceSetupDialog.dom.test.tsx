// @vitest-environment happy-dom

/**
 * The voice setup window: providers (a switcher only with several), the model with its price, the controls of that
 * model, a sample of the user's own phrase (made once, reused), side-by-side comparison, listening with the video, and a
 * saved preset that resolves the opener.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoicePreset } from "@hyperframes/agent-protocol";
import { useSettingsDialog } from "../components/settings/settingsStore";
import { cleanupMounted } from "../components/ui/mountHost.testHelpers";
import type * as voiceAudio from "./voiceAudio";
import { listenWithVideo, playVoiceSound } from "./voiceAudio";
import {
  button,
  byLabel,
  byTestId,
  mountVoice,
  pressAndSettle,
  settle,
  typeAndEnter,
  typeInto,
} from "./voiceDom.testHelpers";
import {
  audioRef,
  catalogEntry,
  catalogPage,
  ELEVEN_CONTROLS,
  freshProviders,
  providerControls,
  providerInfo,
  voicePreset,
} from "./voiceTestHarness";
import { VoiceSetupDialog } from "./VoiceSetupDialog";
import type { VoiceSetupRequest } from "./voiceUiStore";

vi.mock("./voiceAudio", async (importOriginal) => ({
  ...(await importOriginal<typeof voiceAudio>()),
  playVoiceSound: vi.fn(async () => true),
  listenWithVideo: vi.fn(async () => true),
  stopVoiceSound: vi.fn(),
}));

afterEach(() => {
  cleanupMounted();
  vi.clearAllMocks();
  useSettingsDialog.setState({ open: false, section: "general" });
});

const BOTH = [
  providerInfo(),
  providerInfo({
    id: "elevenlabs",
    connector: "elevenlabs",
    name: "ElevenLabs",
    model: "eleven_v4",
  }),
];

const KORE = catalogEntry();
const PUCK = catalogEntry({ id: "Puck", name: "Puck", description: "Upbeat", labels: {} });

function open(
  data: Parameters<typeof mountVoice>[1] = {},
  request: Partial<VoiceSetupRequest> = {},
) {
  const onClose = vi.fn();
  const onSaved = vi.fn<(preset: VoicePreset) => void>();
  const mounted = mountVoice(
    <VoiceSetupDialog
      request={{
        language: "en",
        sampleText: "Welcome to the channel.",
        suggestion: "",
        startFrom: null,
        onSaved,
        ...request,
      }}
      onClose={onClose}
    />,
    { catalog: catalogPage([KORE, PUCK]), ...data },
  );
  return { ...mounted, onClose, onSaved };
}

const dialog = () => document.body.querySelector<HTMLElement>('[data-testid="voice-setup-dialog"]');
const pick = (id: string) =>
  document.body.querySelector<HTMLElement>(`[data-voice-id="${id}"] button`);
const phrase = () =>
  document.body.querySelector<HTMLTextAreaElement>('[data-testid="voice-sample-panel"] textarea');
const save = () => byTestId<HTMLButtonElement>(document.body, "voice-setup-save");

describe("the window's frame", () => {
  it("shows one configured service without a switcher, and the model with its price per minute", async () => {
    open();
    await settle();
    expect(dialog()).not.toBeNull();
    expect(document.body.querySelector('[role="radiogroup"][aria-label="Service"]')).toBeNull();
    const model = byLabel(document.body, "Model");
    expect(model?.textContent).toBe("Gemini 3.8 Flash TTS · $0.0135/min");
  });

  it("puts a switcher on top when several services are configured, and starts over for the one picked", async () => {
    const { calls } = open({ providers: BOTH, controls: providerControls() });
    await settle();
    const group = document.body.querySelector('[role="radiogroup"][aria-label="Service"]');
    expect(
      [...(group?.querySelectorAll('[role="radio"]') ?? [])].map((radio) => radio.textContent),
    ).toEqual(["Gemini", "ElevenLabs"]);
    expect(calls.controls.mock.calls[0][0]).toBe("gemini");
    await pressAndSettle(button(group ?? document.body, "ElevenLabs"));
    expect(calls.controls.mock.calls.at(-1)?.[0]).toBe("elevenlabs");
    // A model's own default is asked for: no model is named on a fresh switch.
    expect(calls.controls.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it("leaves a service that is not configured out", async () => {
    open({
      providers: freshProviders().map((p, i) =>
        i === 1 ? { ...p, hasKey: true, configured: true } : p,
      ),
    });
    await settle();
    // Only OpenAI can speak: no switcher, and its controls were read.
    expect(document.body.querySelector('[role="radiogroup"][aria-label="Service"]')).toBeNull();
  });

  it("sends a user with no service to Settings instead of an empty form", async () => {
    const { onClose } = open({ providers: freshProviders() });
    await settle();
    expect(byTestId(document.body, "voice-setup-empty")?.textContent).toContain("Add a key first");
    expect(byTestId(document.body, "voice-controls")).toBeNull();
    await pressAndSettle(button(document.body, "Open Settings › Voice"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useSettingsDialog.getState()).toMatchObject({ open: true, section: "voice" });
  });

  it("shows the agent's suggestion and an approximate-dialect warning", async () => {
    open(
      {
        controls: providerControls({
          models: [
            providerControls().models[0],
            { ...providerControls().models[0], dialectApproximate: true },
          ].slice(1),
        }),
      },
      { suggestion: "warm, mid-30s, calm" },
    );
    await settle();
    expect(dialog()?.textContent).toContain("The agent suggests: warm, mid-30s, calm");
    expect(dialog()?.textContent).toContain("applied as the nearest family");
  });
});

describe("hearing a voice", () => {
  it("makes the sample of the user's own phrase with the draft, plays it, and reuses it", async () => {
    const { calls } = open();
    await settle();
    expect(button(document.body, "Listen")?.disabled).toBe(true);
    expect(dialog()?.textContent).toContain("Choose a voice to hear it.");
    await pressAndSettle(pick("Kore"));
    await pressAndSettle(button(document.body, "Listen"));

    expect(calls.sample).toHaveBeenCalledTimes(1);
    expect(calls.sample.mock.calls[0][0]).toEqual({
      preset: {
        name: "Kore",
        providerId: "gemini",
        model: "gemini-3.8-flash-tts",
        voice: { id: "Kore", name: "Kore", kind: "prebuilt", language: "en-US" },
        style: "",
        settings: {},
      },
      text: "Welcome to the channel.",
    });
    expect(playVoiceSound).toHaveBeenCalledWith("voice-setup:sample", audioRef().url, undefined);
    // Duration and what it cost.
    expect(dialog()?.textContent).toContain("$0.0004");

    await pressAndSettle(button(document.body, "Listen"));
    expect(calls.sample).toHaveBeenCalledTimes(1);
  });

  it("speaks a phrase the user edited, with the style they typed", async () => {
    const { calls } = open();
    await settle();
    await pressAndSettle(pick("Kore"));
    const style = document.body.querySelector<HTMLTextAreaElement>(
      '[data-voice-control="style:style"] textarea',
    );
    if (!style) throw new Error("no style field");
    await typeInto(style, "whispered");
    const field = phrase();
    if (!field) throw new Error("no phrase field");
    expect(field.value).toBe("Welcome to the channel.");
    await typeInto(field, "Something else entirely.");
    await pressAndSettle(button(document.body, "Listen"));
    expect(calls.sample.mock.calls[0][0]).toMatchObject({
      text: "Something else entirely.",
      preset: { style: "whispered" },
    });
  });

  it("plays the sample from the playhead together with the composition", async () => {
    const { calls } = open();
    await settle();
    await pressAndSettle(pick("Puck"));
    await pressAndSettle(button(document.body, "Listen with video"));
    expect(calls.sample).toHaveBeenCalledTimes(1);
    expect(listenWithVideo).toHaveBeenCalledWith("voice-setup:sample-video", audioRef().url);
    expect(playVoiceSound).not.toHaveBeenCalled();
  });

  it("says why there is nothing to hear when the sample cannot be made", async () => {
    const { calls } = open();
    calls.sample.mockRejectedValueOnce(new Error("The service rejected this key."));
    await settle();
    await pressAndSettle(pick("Kore"));
    await pressAndSettle(button(document.body, "Listen"));
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The service rejected this key.",
    );
    expect(playVoiceSound).not.toHaveBeenCalled();
  });
});

describe("a server where the voice is a typed name", () => {
  const custom = providerInfo({
    id: "custom",
    connector: "openai_compatible",
    name: "Custom server",
    baseUrl: "http://127.0.0.1:8880/v1",
    model: "say-tts",
    voice: "Samantha",
    keyRequired: false,
    hasKey: false,
    configured: true,
  });
  const data = {
    providers: [custom],
    controls: providerControls({
      provider: custom,
      model: "say-tts",
      models: [],
      controls: [{ kind: "voice_text", maxChars: 200 }],
    }),
  };

  it("starts with the voice configured for the server, so Listen works without typing", async () => {
    const { calls } = open(data);
    await settle();
    expect(byLabel<HTMLInputElement>(document.body, "Voice name")?.value).toBe("Samantha");
    expect(button(document.body, "Listen")?.disabled).toBe(false);
    expect(save()?.disabled).toBe(false);
    await pressAndSettle(button(document.body, "Listen"));
    expect(calls.voices).not.toHaveBeenCalled();
    expect(calls.sample.mock.calls[0][0].preset).toMatchObject({
      providerId: "custom",
      model: "say-tts",
      voice: { id: "Samantha", name: "Samantha", kind: "custom" },
    });
  });

  it("hears a name as soon as it is typed, and not at all while the field is empty", async () => {
    const unset = { ...custom, voice: "" };
    const { calls } = open({
      providers: [unset],
      controls: providerControls({
        provider: unset,
        model: "say-tts",
        models: [],
        controls: [{ kind: "voice_text", maxChars: 200 }],
      }),
    });
    await settle();
    const field = byLabel<HTMLInputElement>(document.body, "Voice name");
    if (!field) throw new Error("no voice name field");
    expect(field.value).toBe("");
    expect(button(document.body, "Listen")?.disabled).toBe(true);
    expect(save()?.disabled).toBe(true);
    await typeInto(field, "Alex");
    expect(button(document.body, "Listen")?.disabled).toBe(false);
    await pressAndSettle(button(document.body, "Listen"));
    expect(calls.sample.mock.calls[0][0].preset.voice).toMatchObject({
      id: "Alex",
      kind: "custom",
    });
    await typeInto(field, "");
    expect(button(document.body, "Listen")?.disabled).toBe(true);
  });
});

describe("comparing voices", () => {
  it("keeps up to three voices side by side on the same phrase, and takes one back as the current voice", async () => {
    const { calls } = open({
      catalog: catalogPage([
        KORE,
        PUCK,
        catalogEntry({ id: "Leda", name: "Leda" }),
        catalogEntry({ id: "Zephyr", name: "Zephyr" }),
      ]),
    });
    await settle();
    for (const id of ["Kore", "Puck", "Leda"]) {
      await pressAndSettle(pick(id));
      await pressAndSettle(button(document.body, "Compare"));
    }
    const tray = byTestId(document.body, "voice-compare");
    expect(
      [...(tray?.querySelectorAll("[data-compared]") ?? [])].map((card) =>
        card.getAttribute("data-compared"),
      ),
    ).toEqual(["Kore", "Puck", "Leda"]);
    // Each voice speaks the same phrase, asked once.
    expect(calls.sample).toHaveBeenCalledTimes(3);
    expect(new Set(calls.sample.mock.calls.map(([request]) => request.text))).toEqual(
      new Set(["Welcome to the channel."]),
    );
    // Full tray: no fourth voice.
    await pressAndSettle(pick("Zephyr"));
    expect(button(document.body, "Compare")?.disabled).toBe(true);

    // Take Puck back: it becomes the chosen voice again.
    const puck = tray?.querySelector('[data-compared="Puck"]');
    await pressAndSettle(button(puck ?? document.body, "Use"));
    expect(pick("Puck")?.getAttribute("aria-pressed")).toBe("true");
    expect(pick("Zephyr")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not add the same voice twice and removes one on request", async () => {
    open();
    await settle();
    await pressAndSettle(pick("Kore"));
    await pressAndSettle(button(document.body, "Compare"));
    expect(button(document.body, "Compare")?.disabled).toBe(true);
    await pressAndSettle(byLabel(document.body, "Remove Kore from the comparison"));
    expect(byTestId(document.body, "voice-compare")).toBeNull();
  });
});

describe("voice design", () => {
  it("makes a voice from a description and uses it, with its instant sample to play", async () => {
    const { calls } = open({ controls: providerControls() });
    await settle();
    const description = document.body.querySelector<HTMLTextAreaElement>(
      '[data-voice-control="voice_design"] textarea',
    );
    if (!description) throw new Error("no design field");
    await pressAndSettle(button(document.body, "Make the voice"));
    expect(dialog()?.textContent).toContain("Describe the voice first.");
    await typeInto(description, "A warm astronomer in his sixties");
    await pressAndSettle(button(document.body, "Make the voice"));
    expect(calls.designVoice).toHaveBeenCalledWith("gemini", {
      name: "A warm astronomer in his sixties",
      description: "A warm astronomer in his sixties",
      model: "gemini-3.8-flash-tts",
      language: "en",
    });
    const made = byTestId(document.body, "voice-designed");
    expect(made?.textContent).toContain("Astronomer");
    expect(button(made ?? document.body, "Hear it")).not.toBeNull();
    // The designed voice is now the draft's voice: its description stays with it.
    await pressAndSettle(button(document.body, "Listen"));
    expect(calls.sample.mock.calls[0][0].preset.voice).toEqual({
      id: "voice_1",
      name: "Astronomer",
      kind: "designed",
      description: "A warm astronomer in his sixties",
      language: "en-US",
    });
  });
});

describe("saving", () => {
  it("is possible once a voice is chosen, and saves the sample the user listened to", async () => {
    const { calls, onSaved, onClose } = open();
    await settle();
    expect(save()?.disabled).toBe(true);
    await pressAndSettle(pick("Kore"));
    await pressAndSettle(button(document.body, "Listen"));
    await pressAndSettle(save());
    expect(calls.createPreset).toHaveBeenCalledWith({
      preset: {
        name: "Kore",
        providerId: "gemini",
        model: "gemini-3.8-flash-tts",
        voice: { id: "Kore", name: "Kore", kind: "prebuilt", language: "en-US" },
        style: "",
        settings: {},
      },
      sampleHash: audioRef().hash,
      sampleText: "Welcome to the channel.",
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.calls[0][0]).toMatchObject({ id: "preset1", name: "Kore" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves without a sample when the user never listened, under the name they gave", async () => {
    const { calls, onSaved } = open();
    await settle();
    await pressAndSettle(pick("Puck"));
    const name = byLabel<HTMLInputElement>(document.body, "Name for the saved voice");
    if (!name) throw new Error("no name field");
    await typeAndEnter(name, "Narrator");
    await pressAndSettle(save());
    const request = calls.createPreset.mock.calls[0][0];
    expect(request.preset.name).toBe("Narrator");
    expect(request).not.toHaveProperty("sampleHash");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("starts from the voice it is given, with that voice's style and settings", async () => {
    const { calls } = open(
      {
        providers: BOTH,
        controls: providerControls({
          provider: BOTH[1],
          model: "eleven_v4",
          controls: ELEVEN_CONTROLS,
        }),
      },
      {
        startFrom: voicePreset({
          providerId: "elevenlabs",
          model: "eleven_v4",
          voice: { id: "v1", name: "Rachel", kind: "library" },
          style: "",
          settings: { stability: 0.2 },
        }),
      },
    );
    await settle();
    expect(calls.controls.mock.calls[0][0]).toBe("elevenlabs");
    expect(calls.controls.mock.calls[0][1]).toBe("eleven_v4");
    await pressAndSettle(button(document.body, "Listen"));
    expect(calls.sample.mock.calls[0][0].preset).toMatchObject({
      providerId: "elevenlabs",
      voice: { id: "v1" },
      settings: { stability: 0.2, similarity_boost: 0.75, use_speaker_boost: true },
    });
  });

  it("keeps the window open and says why when the preset cannot be saved", async () => {
    const { calls, onSaved, onClose } = open();
    calls.createPreset.mockRejectedValueOnce(new Error("The disk is full."));
    await settle();
    await pressAndSettle(pick("Kore"));
    await pressAndSettle(save());
    expect(document.body.textContent).toContain("The disk is full.");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
