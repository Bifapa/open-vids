/** Which face the chat's voice-setup card shows while the agent waits for a voice. */
export type VoiceSetupStage =
  /** The project's voice and the services are still being read. */
  | "loading"
  /** The project already has a voice: its name, a sample, "Use" / "Change". */
  | "project-voice"
  /** No service is set up: pick one, paste the key, hear it work. */
  | "connect"
  /** A service is ready: open the voice setup window. */
  | "choose";

export interface VoiceSetupStageInput {
  /** The project's voice script was read (or there is no project to ask). */
  projectLoaded: boolean;
  hasProjectVoice: boolean;
  /** The user pressed "Change" on the project's voice. */
  changing: boolean;
  /** The list of services was read. */
  providersLoaded: boolean;
  /** Services that can synthesize now. */
  configuredCount: number;
  /** The connect step was shown and is not finished: it stays until the key was checked and the user went on. */
  connecting: boolean;
}

/**
 * The card's state selection, in one place: a project voice comes first (answering costs nothing), then connecting
 * when there is no service (or while it is not finished: saving the key makes the service ready, but the check sample
 * must still be heard), else the window.
 */
export function voiceSetupStage(input: VoiceSetupStageInput): VoiceSetupStage {
  if (!input.projectLoaded || !input.providersLoaded) return "loading";
  if (input.hasProjectVoice && !input.changing) return "project-voice";
  if (input.configuredCount === 0 || input.connecting) return "connect";
  return "choose";
}
