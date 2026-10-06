// @vitest-environment happy-dom

/**
 * The voice surfaces of the chat: the voice-setup card (its faces, answers and failures), the pilot-line card, the
 * `voice_generation` permission card and the tag chips of plan steps. The shell context is stubbed to one project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { VOICE_DIALECTS, type PermissionVoice, type PlanStep } from "@hyperframes/agent-protocol";
import { AgentStoreProvider } from "../../agent/agentContext";
import { createAgentStore } from "../../agent/agentStore";
import {
  CATALOG,
  assistantMessage,
  chatState,
  createFakeClient,
  createSourceLog,
  permissionRequest,
  voicePilotPart,
  voicePilotRequest,
  voiceSetupPart,
  voiceSetupRequest,
} from "../../agent/agentTestHarness";
import type * as studioContext from "../../contexts/StudioContext";
import { useSettingsDialog } from "../settings/settingsStore";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { VoiceProvider } from "../../voice/voiceContext";
import type * as voiceAudio from "../../voice/voiceAudio";
import { playVoiceSound } from "../../voice/voiceAudio";
import {
  button,
  byLabel,
  byTestId,
  pressAndSettle,
  settle,
  typeInto,
  visitStudio,
} from "../../voice/voiceDom.testHelpers";
import { useVoiceUi } from "../../voice/voiceUiStore";
import {
  audioRef,
  createFakeVoice,
  freshProviders,
  providerInfo,
  scriptView,
  voicePreset,
  type FakeVoiceData,
} from "../../voice/voiceTestHarness";
import { AssistantBlock } from "./Messages";
import { PermissionCard } from "./PermissionCard";
import { PlanStepList } from "./PlanParts";
import { VoicePilotCard } from "./VoicePilotCard";
import { VoiceSetupCard } from "./VoiceSetupCard";

vi.mock("../../contexts/StudioContext", async (importOriginal) => ({
  ...(await importOriginal<typeof studioContext>()),
  useStudioShellContextOptional: () => ({ projectId: "demo" }),
}));
vi.mock("../../voice/voiceAudio", async (importOriginal) => ({
  ...(await importOriginal<typeof voiceAudio>()),
  playVoiceSound: vi.fn(async () => true),
  stopVoiceSound: vi.fn(),
}));

beforeEach(() => visitStudio("beta"));

afterEach(() => {
  cleanupMounted();
  vi.clearAllMocks();
  visitStudio("");
  useVoiceUi.setState({ setup: null });
  useSettingsDialog.setState({ open: false, section: "general" });
});

const GEMINI = VOICE_DIALECTS["gemini-tts"];
const PROJECT_VOICE = voicePreset();

function mountWith(element: ReactElement, data: FakeVoiceData = {}) {
  const agentClient = createFakeClient({ chat: chatState() });
  const agent = createAgentStore({ client: agentClient, openEventSource: createSourceLog().open });
  agent.setState({ availability: "ready", models: CATALOG, view: "chat", chatId: "c1" });
  const voice = createFakeVoice(data);
  const host = mountHost(
    <AgentStoreProvider store={agent}>
      <VoiceProvider client={voice.client} store={voice.store}>
        {element}
      </VoiceProvider>
    </AgentStoreProvider>,
  );
  return { host, agent, agentClient, voice };
}

const card = (host: ParentNode) => byTestId(host, "voice-setup-card");
const stage = (host: ParentNode) => card(host)?.getAttribute("data-voice-setup-stage");

describe("the voice-setup card", () => {
  it("offers the project's own voice first, and answers with it when the user takes it", async () => {
    const { host, agentClient, voice } = mountWith(
      <VoiceSetupCard turnId="t1" setup={voiceSetupRequest()} />,
      { script: scriptView({ voice: PROJECT_VOICE }), presets: [PROJECT_VOICE] },
    );
    await settle();
    expect(stage(host)).toBe("project-voice");
    const row = byTestId(host, "voice-setup-project-voice");
    expect(row?.textContent).toContain("Warm narrator");
    expect(byLabel(row ?? host, "Play the sample of Warm narrator")).not.toBeNull();
    await pressAndSettle(button(host, "Use this voice"));
    expect(voice.calls.createPreset).not.toHaveBeenCalled();
    expect(agentClient.answerVoiceSetup).toHaveBeenCalledWith("c1", "t1", "setup1", {
      presetId: "preset1",
    });
    expect(byTestId(host, "voice-setup-status")?.textContent).toBe("Voice chosen: Warm narrator");
  });

  it("saves the project's voice into the library again when its preset was deleted, and answers with the new one", async () => {
    const { host, agentClient, voice } = mountWith(
      <VoiceSetupCard turnId="t1" setup={voiceSetupRequest()} />,
      { script: scriptView({ voice: PROJECT_VOICE }), presets: [] },
    );
    await settle();
    await pressAndSettle(button(host, "Use this voice"));
    expect(voice.calls.createPreset).toHaveBeenCalledTimes(1);
    expect(voice.calls.createPreset.mock.calls[0][0]).toMatchObject({
      preset: { name: "Warm narrator", providerId: "gemini" },
      sampleHash: audioRef().hash,
    });
    expect(agentClient.answerVoiceSetup).toHaveBeenCalledWith("c1", "t1", "setup1", {
      presetId: "preset1",
    });
  });

  it("opens the setup window from the project's voice on Change, and answers with the voice it saves", async () => {
    const { host, agentClient } = mountWith(
      <VoiceSetupCard turnId="t1" setup={voiceSetupRequest()} />,
      { script: scriptView({ voice: PROJECT_VOICE }), presets: [PROJECT_VOICE] },
    );
    await settle();
    await pressAndSettle(button(host, "Change"));
    const opened = useVoiceUi.getState().setup;
    expect(opened).toMatchObject({
      language: "ru",
      sampleText: "Привет! Это пример голоса.",
      suggestion: "warm, mid-30s, calm",
      startFrom: PROJECT_VOICE,
    });
    opened?.onSaved?.(voicePreset({ id: "preset9" }));
    await settle();
    expect(agentClient.answerVoiceSetup).toHaveBeenCalledWith("c1", "t1", "setup1", {
      presetId: "preset9",
    });
  });

  it("connects first when no service is set up: key, check sample, then the window", async () => {
    const { host, voice } = mountWith(<VoiceSetupCard turnId="t1" setup={voiceSetupRequest()} />, {
      providers: freshProviders(),
    });
    await settle();
    expect(stage(host)).toBe("connect");
    const continueButton = () => byTestId<HTMLButtonElement>(host, "voice-connect-continue");
    expect(continueButton()?.disabled).toBe(true);
    // The custom server is not offered until it is configured.
    expect(byTestId(host, "voice-connect")?.textContent).not.toContain("Custom server");

    const field = byLabel<HTMLInputElement>(host, "API key for Gemini");
    if (!field) throw new Error("no key field");
    await typeInto(field, "AIza-secret");
    await pressAndSettle(button(host, "Save"));
    expect(voice.calls.setApiKey).toHaveBeenCalledWith("gemini", "AIza-secret");
    expect(voice.calls.checkProvider).toHaveBeenCalledWith("gemini");
    expect(playVoiceSound).toHaveBeenCalledWith("voice-key:gemini", audioRef().url);
    // The key is never shown back, and the connect step stays up until the user goes on.
    expect(host.textContent).not.toContain("AIza-secret");
    expect(stage(host)).toBe("connect");
    expect(continueButton()?.disabled).toBe(false);
    await pressAndSettle(continueButton());
    expect(useVoiceUi.getState().setup).not.toBeNull();
  });

  it("explains the Gemini free tier honestly on the connect step", async () => {
    const { host } = mountWith(<VoiceSetupCard turnId="t1" setup={voiceSetupRequest()} />, {
      providers: freshProviders(),
    });
    await settle();
    const note = host.querySelector('[data-voice-note="free_tier_terms"]');
    expect(note?.textContent).toContain("human reviewers may read them");
    expect(note?.textContent).toContain(
      "Don’t send sensitive, confidential or personal information",
    );
    expect(note?.textContent).toContain("daily limits");
    expect(note?.textContent).toContain("EEA, Switzerland and the UK");
    expect(note?.querySelector("a")?.getAttribute("href")).toBe(
      "https://ai.google.dev/gemini-api/terms",
    );
  });

  it("opens the window straight from a ready service, and answers with the saved voice", async () => {
    const { host, agentClient } = mountWith(
      <VoiceSetupCard turnId="t1" setup={voiceSetupRequest()} />,
      { providers: [providerInfo()] },
    );
    await settle();
    expect(stage(host)).toBe("choose");
    await pressAndSettle(byTestId(host, "voice-setup-choose"));
    const opened = useVoiceUi.getState().setup;
    expect(opened).toMatchObject({ language: "ru", startFrom: null });
    opened?.onSaved?.(voicePreset({ id: "preset2" }));
    await settle();
    expect(agentClient.answerVoiceSetup).toHaveBeenCalledWith("c1", "t1", "setup1", {
      presetId: "preset2",
    });
  });

  it("declines with Not now in every face", async () => {
    const { host, agentClient } = mountWith(
      <VoiceSetupCard turnId="t1" setup={voiceSetupRequest()} />,
      { providers: [providerInfo()] },
    );
    await settle();
    await pressAndSettle(byTestId(host, "voice-setup-decline"));
    expect(agentClient.answerVoiceSetup).toHaveBeenCalledWith("c1", "t1", "setup1", {
      decline: true,
    });
    expect(byTestId(host, "voice-setup-status")?.textContent).toBe(
      "Not now. The agent goes on without a voice.",
    );
  });

  it("says when the answer could not be sent and tries again", async () => {
    const { host, agentClient } = mountWith(
      <VoiceSetupCard turnId="t1" setup={voiceSetupRequest()} />,
      { providers: [providerInfo()] },
    );
    agentClient.answerVoiceSetup.mockRejectedValueOnce(new Error("offline"));
    await settle();
    await pressAndSettle(byTestId(host, "voice-setup-decline"));
    expect(byTestId(host, "voice-setup-error")?.textContent).toContain(
      "Couldn’t send your answer.",
    );
    await pressAndSettle(button(byTestId(host, "voice-setup-error") ?? host, "Try again"));
    expect(agentClient.answerVoiceSetup).toHaveBeenCalledTimes(2);
    expect(byTestId(host, "voice-setup-error")).toBeNull();
  });

  it("is a one-line record once answered, declined or expired", () => {
    for (const [setup, text] of [
      [
        voiceSetupRequest({ state: "answered", presetId: "p", presetName: "Warm" }),
        "Voice chosen: Warm",
      ],
      [voiceSetupRequest({ state: "declined" }), "Not now. The agent goes on without a voice."],
      [voiceSetupRequest({ state: "expired" }), "The question expired."],
    ] as const) {
      cleanupMounted();
      const { host } = mountWith(<VoiceSetupCard turnId="t1" setup={setup} />);
      expect(byTestId(host, "voice-setup-status")?.textContent).toBe(text);
      expect(button(host, "Not now")).toBeNull();
    }
  });

  it("is drawn in an assistant reply only in a beta build", () => {
    const message = assistantMessage({ parts: [voiceSetupPart({ state: "declined" })] });
    const { host } = mountWith(<AssistantBlock message={message} />);
    expect(card(host)).not.toBeNull();
    cleanupMounted();
    visitStudio("");
    const plain = mountWith(<AssistantBlock message={message} />);
    expect(card(plain.host)).toBeNull();
  });
});

describe("the pilot-line card", () => {
  const withVoice = { script: scriptView({ voice: PROJECT_VOICE, dialect: GEMINI }) };

  it("plays the take's range from the project's file and shows the tags of the line as chips", async () => {
    const { host } = mountWith(
      <VoicePilotCard
        turnId="t1"
        pilot={voicePilotRequest({ text: "Hello <sigh> there <boom> friend" })}
      />,
      withVoice,
    );
    await settle();
    await pressAndSettle(byLabel(host, "Play the first line"));
    expect(playVoiceSound).toHaveBeenCalledWith(
      "voice-pilot:pilot1",
      "/api/projects/demo/preview/assets/voice/welcome-1a2b3c4d.wav",
      { start: 1.5, end: 4 },
    );
    const chips = [...host.querySelectorAll("[data-voice-tag]")];
    expect(
      chips.map((chip) => [
        chip.getAttribute("data-voice-tag"),
        chip.getAttribute("data-voice-tag-known"),
      ]),
    ).toEqual([
      ["sigh", "true"],
      ["boom", "false"],
    ]);
    expect(byTestId(host, "voice-pilot-remaining")?.textContent).toBe(
      "Continue generates the other 5 lines. Estimated cost: $0.02.",
    );
  });

  it("says the cost is unknown when the provider's rate is not", async () => {
    const { host } = mountWith(
      <VoicePilotCard turnId="t1" pilot={voicePilotRequest({ remainingUsdCost: null })} />,
    );
    await settle();
    expect(byTestId(host, "voice-pilot-remaining")?.textContent).toContain(
      "Estimated cost: unknown.",
    );
  });

  it("continues with the rest on Continue", async () => {
    const { host, agentClient } = mountWith(
      <VoicePilotCard turnId="t1" pilot={voicePilotRequest()} />,
    );
    await settle();
    await pressAndSettle(byTestId(host, "voice-pilot-continue"));
    expect(agentClient.answerVoicePilot).toHaveBeenCalledWith("c1", "t1", "pilot1", {
      decision: "approve",
    });
    expect(byTestId(host, "voice-pilot-status")?.textContent).toBe(
      "Approved. The rest is being generated.",
    );
  });

  it("sends the user's note on Change, and only once there is one", async () => {
    const { host, agentClient } = mountWith(
      <VoicePilotCard turnId="t1" pilot={voicePilotRequest()} />,
    );
    await settle();
    await pressAndSettle(byTestId(host, "voice-pilot-change"));
    const send = () => byTestId<HTMLButtonElement>(host, "voice-pilot-send");
    expect(send()?.disabled).toBe(true);
    const note = host.querySelector("textarea");
    if (!note) throw new Error("no note field");
    await typeInto(note, "  slower and warmer ");
    await pressAndSettle(send());
    expect(agentClient.answerVoicePilot).toHaveBeenCalledWith("c1", "t1", "pilot1", {
      decision: "change",
      feedback: "slower and warmer",
    });
    expect(byTestId(host, "voice-pilot-status")?.textContent).toBe("Changes requested");
    expect(byTestId(host, "voice-pilot-feedback")?.textContent).toBe("slower and warmer");
  });

  it("is drawn in an assistant reply only in a beta build", () => {
    const message = assistantMessage({ parts: [voicePilotPart({ state: "approved" })] });
    const { host } = mountWith(<AssistantBlock message={message} />);
    expect(byTestId(host, "voice-pilot-card")).not.toBeNull();
    cleanupMounted();
    visitStudio("");
    expect(
      byTestId(mountWith(<AssistantBlock message={message} />).host, "voice-pilot-card"),
    ).toBeNull();
  });
});

describe("the voice_generation permission card", () => {
  const request = (
    voice: PermissionVoice = {
      provider: "gemini",
      model: "gemini-3.8-flash-tts",
      lines: 6,
      seconds: 74,
      usdCost: 0.0153,
    },
  ) =>
    permissionRequest({
      kind: "voice_generation",
      action: "render",
      site: null,
      agent: "audio",
      voice,
    });

  it("shows the lines, the length and the estimate before anything is paid, with a once-only answer", () => {
    const { host } = mountWith(<PermissionCard turnId="t1" permission={request()} />);
    const card = byTestId(host, "permission-card");
    expect(card?.getAttribute("data-permission-kind")).toBe("voice_generation");
    expect(byTestId(host, "permission-sentence")?.textContent).toBe(
      "Audio wants to generate a voiceover with Gemini",
    );
    expect(byTestId(host, "permission-voice-service")?.textContent).toBe(
      "Gemini · gemini-3.8-flash-tts",
    );
    expect(byTestId(host, "permission-voice-lines")?.textContent).toBe("6");
    expect(byTestId(host, "permission-voice-seconds")?.textContent).toBe("1m 14s");
    expect(byTestId(host, "permission-voice-cost")?.textContent).toBe("$0.0153");
    expect([...(card?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "Generate",
      "Don’t generate",
    ]);
  });

  it("says the cost is unknown instead of guessing one", () => {
    const { host } = mountWith(
      <PermissionCard
        turnId="t1"
        permission={request({
          provider: "openai",
          model: "gpt-4o-mini-tts",
          lines: 2,
          seconds: 9,
          usdCost: null,
        })}
      />,
    );
    expect(byTestId(host, "permission-voice-cost")?.textContent).toBe("unknown");
    expect(byTestId(host, "permission-voice-service")?.textContent).toBe(
      "OpenAI · gpt-4o-mini-tts",
    );
  });

  it("answers once and records it", async () => {
    const { host, agentClient } = mountWith(<PermissionCard turnId="t1" permission={request()} />);
    agentClient.answerPermission.mockResolvedValueOnce({
      permission: { ...request(), state: "allowed_once", answeredAt: 5 },
    });
    await pressAndSettle(button(host, "Generate"));
    expect(agentClient.answerPermission).toHaveBeenCalledWith("c1", "t1", "perm1", "once");
    expect(byTestId(host, "permission-status")?.textContent).toBe("Generation allowed");
    expect(byTestId(host, "permission-voice")).toBeNull();
  });
});

describe("tags in plan steps", () => {
  const step = (id: string, title: string): PlanStep => ({
    id,
    title,
    status: "pending",
    agent: "director",
  });
  const chips = (host: ParentNode) =>
    [...host.querySelectorAll("[data-voice-tag]")].map((chip) => [
      chip.getAttribute("data-voice-tag"),
      chip.getAttribute("data-voice-tag-known"),
    ]);

  it("draws the project voice's tags as chips, an undocumented one as a warning", async () => {
    const { host } = mountWith(
      <PlanStepList
        steps={[step("a", "Welcome <sigh> to the show"), step("b", "Then <boom> go")]}
      />,
      { script: scriptView({ voice: PROJECT_VOICE, dialect: GEMINI }) },
    );
    await settle();
    expect(chips(host)).toEqual([
      ["sigh", "true"],
      ["boom", "false"],
    ]);
    const first = host.querySelector("li");
    expect(first?.textContent).toContain("Welcome sigh to the show");
  });

  it("leaves the titles alone when the project has no voice", async () => {
    const { host, voice } = mountWith(<PlanStepList steps={[step("a", "Say <sigh> now")]} />, {
      script: scriptView({ voice: null, dialect: null }),
    });
    await settle();
    expect(voice.calls.script).toHaveBeenCalledTimes(1);
    expect(chips(host)).toEqual([]);
    expect(host.querySelector("li")?.textContent).toContain("Say <sigh> now");
  });

  it("does not ask the server about plain titles, or at all outside a beta build", async () => {
    const plain = mountWith(<PlanStepList steps={[step("a", "Trim the intro")]} />);
    await settle();
    expect(plain.voice.calls.script).not.toHaveBeenCalled();
    cleanupMounted();
    visitStudio("");
    const stable = mountWith(<PlanStepList steps={[step("a", "Say <sigh> now")]} />, {
      script: scriptView({ voice: PROJECT_VOICE, dialect: GEMINI }),
    });
    await settle();
    expect(stable.voice.calls.script).not.toHaveBeenCalled();
    expect(chips(stable.host)).toEqual([]);
  });
});
