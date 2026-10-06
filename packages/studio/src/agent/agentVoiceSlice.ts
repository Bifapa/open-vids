import type { StoreApi } from "zustand/vanilla";
import type {
  AnswerVoicePilotRequest,
  AnswerVoiceSetupRequest,
  VoicePilotRequest,
  VoiceSetupRequest,
} from "@hyperframes/agent-protocol";
import type { AgentClient } from "./agentClient";
import { describeAgentError, describeAgentFailure } from "./agentErrors";
import type { AgentState } from "./agentStore";

/** How the user's answer to a voice-setup card ended: the request as the runtime now has it, or why it failed. */
export type VoiceSetupAnswer =
  | { ok: true; setup: VoiceSetupRequest }
  | { ok: false; message: string };

/** How the user's verdict on a pilot line ended. */
export type VoicePilotAnswer =
  | { ok: true; pilot: VoicePilotRequest }
  | { ok: false; message: string };

/** The voice cards of the open chat: the voice the agent asks for, and the pilot line it asks a verdict on. */
export interface AgentVoiceSlice {
  /**
   * Answers a pending voice-setup card with a saved preset (the runtime sets it as the project's voice) or "Not
   * now". The chat stream carries the updated part (the source of truth); the answer returned here only ends the
   * card's busy state. Never rejects.
   */
  answerVoiceSetup(
    turnId: string,
    setupId: string,
    answer: AnswerVoiceSetupRequest,
  ): Promise<VoiceSetupAnswer>;
  /** Answers a pending pilot card: approve (the rest is generated) or change with a note. Never rejects. */
  answerVoicePilot(
    turnId: string,
    pilotId: string,
    answer: AnswerVoicePilotRequest,
  ): Promise<VoicePilotAnswer>;
}

export interface AgentVoiceSliceDeps {
  client: AgentClient;
  get: StoreApi<AgentState>["getState"];
}

export function createAgentVoiceSlice({ client, get }: AgentVoiceSliceDeps): AgentVoiceSlice {
  return {
    async answerVoiceSetup(turnId, setupId, answer) {
      const chatId = get().chatId;
      if (!chatId) return { ok: false, message: describeAgentFailure("internal") };
      try {
        const { setup } = await client.answerVoiceSetup(chatId, turnId, setupId, answer);
        return { ok: true, setup };
      } catch (error) {
        return { ok: false, message: describeAgentError(error) };
      }
    },

    async answerVoicePilot(turnId, pilotId, answer) {
      const chatId = get().chatId;
      if (!chatId) return { ok: false, message: describeAgentFailure("internal") };
      try {
        const { pilot } = await client.answerVoicePilot(chatId, turnId, pilotId, answer);
        return { ok: true, pilot };
      } catch (error) {
        return { ok: false, message: describeAgentError(error) };
      }
    },
  };
}
