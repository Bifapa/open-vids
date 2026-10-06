import { isVoiceProviderId } from "@hyperframes/agent-protocol";
import { t } from "../i18n";

/**
 * The name of a voice service from its id, for text that only has the id (a permission request's `voice.provider`).
 * The built-in services are brand names and stay as they are; the custom server is the user's own.
 */
export function voiceProviderName(id: string): string {
  if (!isVoiceProviderId(id)) return id;
  switch (id) {
    case "gemini":
      return "Gemini";
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "elevenlabs":
      return "ElevenLabs";
    case "custom":
      return t("voice.provider.custom");
  }
}
