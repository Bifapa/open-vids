import { describe, expect, it } from "vitest";
import { voiceSetupStage, type VoiceSetupStageInput } from "./voiceSetupStage";

const ready: VoiceSetupStageInput = {
  projectLoaded: true,
  hasProjectVoice: false,
  changing: false,
  providersLoaded: true,
  configuredCount: 1,
  connecting: false,
};

describe("which face the voice-setup card shows", () => {
  it("waits while the project's voice or the services are still being read", () => {
    expect(voiceSetupStage({ ...ready, projectLoaded: false })).toBe("loading");
    expect(voiceSetupStage({ ...ready, providersLoaded: false })).toBe("loading");
  });

  it("puts the project's own voice first, whatever else is set up", () => {
    expect(voiceSetupStage({ ...ready, hasProjectVoice: true })).toBe("project-voice");
    expect(voiceSetupStage({ ...ready, hasProjectVoice: true, configuredCount: 0 })).toBe(
      "project-voice",
    );
  });

  it("leaves the project's voice once the user pressed Change", () => {
    expect(voiceSetupStage({ ...ready, hasProjectVoice: true, changing: true })).toBe("choose");
    expect(
      voiceSetupStage({ ...ready, hasProjectVoice: true, changing: true, configuredCount: 0 }),
    ).toBe("connect");
  });

  it("connects first when no service can speak", () => {
    expect(voiceSetupStage({ ...ready, configuredCount: 0 })).toBe("connect");
  });

  it("stays on the connect step until the user goes on, even though saving the key made a service ready", () => {
    expect(voiceSetupStage({ ...ready, connecting: true })).toBe("connect");
  });

  it("opens the voice window when a service is ready", () => {
    expect(voiceSetupStage(ready)).toBe("choose");
    expect(voiceSetupStage({ ...ready, configuredCount: 3 })).toBe("choose");
  });
});
