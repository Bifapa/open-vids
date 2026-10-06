import { describe, expect, it } from "vitest";
import type { AssistantPart } from "@hyperframes/agent-protocol";
import {
  permissionPart,
  voicePilotPart,
  voicePilotRequest,
  voiceSetupPart,
  voiceSetupRequest,
} from "./agentTestHarness";
import { isPermissionPart, isPermissionRequest } from "./permissionGuards";
import {
  isAnswerVoicePilotResponse,
  isAnswerVoiceSetupResponse,
  isVoicePilotPart,
  isVoiceSetupPart,
} from "./voiceChatGuards";

/** A part the way a damaged or newer runtime could write it: the parts are checked, not trusted. */
function damaged<T extends AssistantPart>(part: T, patch: object): T {
  return Object.assign(structuredClone(part), patch);
}

describe("voice-setup part guard", () => {
  it("accepts a pending, an answered and a declined card", () => {
    expect(isVoiceSetupPart(voiceSetupPart())).toBe(true);
    expect(
      isVoiceSetupPart(
        voiceSetupPart({ state: "answered", presetId: "p1", presetName: "Warm", answeredAt: 5 }),
      ),
    ).toBe(true);
    expect(isVoiceSetupPart(voiceSetupPart({ state: "declined" }))).toBe(true);
    expect(isVoiceSetupPart(voiceSetupPart({ language: null }))).toBe(true);
  });

  it("drops a card the runtime worded differently instead of crashing the chat", () => {
    expect(isVoiceSetupPart(damaged(voiceSetupPart(), { setup: null }))).toBe(false);
    expect(
      isVoiceSetupPart(
        damaged(voiceSetupPart(), { setup: { ...voiceSetupRequest(), state: "x" } }),
      ),
    ).toBe(false);
    expect(
      isVoiceSetupPart(
        damaged(voiceSetupPart(), { setup: { ...voiceSetupRequest(), presetName: 4 } }),
      ),
    ).toBe(false);
    expect(
      isVoiceSetupPart(
        damaged(voiceSetupPart(), { setup: { ...voiceSetupRequest(), sampleText: undefined } }),
      ),
    ).toBe(false);
  });

  it("is not fooled by another part type", () => {
    expect(isVoiceSetupPart(voicePilotPart())).toBe(false);
    expect(isVoiceSetupPart(permissionPart())).toBe(false);
  });
});

describe("voice-pilot part guard", () => {
  it("accepts a pending pilot, one with an unknown remaining cost, and a changes verdict", () => {
    expect(isVoicePilotPart(voicePilotPart())).toBe(true);
    expect(isVoicePilotPart(voicePilotPart({ remainingUsdCost: null }))).toBe(true);
    expect(
      isVoicePilotPart(voicePilotPart({ state: "changes", feedback: "slower", answeredAt: 9 })),
    ).toBe(true);
  });

  it("drops a pilot whose range or estimate is not a number", () => {
    const part = voicePilotPart();
    expect(isVoicePilotPart(damaged(part, { pilot: { ...voicePilotRequest(), start: "1" } }))).toBe(
      false,
    );
    expect(
      isVoicePilotPart(
        damaged(part, { pilot: { ...voicePilotRequest(), remainingUsdCost: "0.1" } }),
      ),
    ).toBe(false);
    expect(
      isVoicePilotPart(damaged(part, { pilot: { ...voicePilotRequest(), feedback: 3 } })),
    ).toBe(false);
    expect(isVoicePilotPart(damaged(part, { pilot: { ...voicePilotRequest(), state: "?" } }))).toBe(
      false,
    );
  });
});

describe("answers", () => {
  it("accepts the runtime's answers and refuses anything else", () => {
    expect(
      isAnswerVoiceSetupResponse({
        setup: voiceSetupRequest({ state: "answered", presetId: "p" }),
      }),
    ).toBe(true);
    expect(isAnswerVoiceSetupResponse({ setup: { id: "x" } })).toBe(false);
    expect(isAnswerVoiceSetupResponse(null)).toBe(false);
    expect(isAnswerVoicePilotResponse({ pilot: voicePilotRequest({ state: "approved" }) })).toBe(
      true,
    );
    expect(isAnswerVoicePilotResponse({ pilot: voiceSetupRequest() })).toBe(false);
  });
});

describe("voice_generation permission guard", () => {
  const voice = {
    provider: "Gemini",
    model: "gemini-3.8-flash-tts",
    lines: 6,
    seconds: 41,
    usdCost: 0.01,
  };

  it("accepts the facts of a generation, with a known or an unknown cost", () => {
    expect(
      isPermissionPart(permissionPart({ kind: "voice_generation", action: "render", voice })),
    ).toBe(true);
    expect(
      isPermissionRequest({
        ...permissionPart({ kind: "voice_generation" }).permission,
        voice: { ...voice, usdCost: null },
      }),
    ).toBe(true);
    // The facts are optional: an old request without them still draws.
    expect(isPermissionPart(permissionPart({ kind: "voice_generation" }))).toBe(true);
  });

  it("drops a request whose voice facts are not whole", () => {
    const base = permissionPart({ kind: "voice_generation" }).permission;
    expect(isPermissionRequest({ ...base, voice: { ...voice, lines: "6" } })).toBe(false);
    expect(isPermissionRequest({ ...base, voice: { ...voice, usdCost: undefined } })).toBe(false);
    expect(isPermissionRequest({ ...base, voice: { provider: "Gemini" } })).toBe(false);
  });
});
