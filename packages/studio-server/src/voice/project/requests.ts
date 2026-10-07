import {
  VOICE_DIALECTS,
  VOICE_LIMITS,
  dialectForModel,
  spokenText,
  type VoiceDialect,
  type VoiceLine,
  type VoicePreset,
  type VoiceProviderId,
} from "@hyperframes/agent-protocol";
import type { EngineSynthesisInput } from "../types.js";

/** Characters per second of speech when the preset has no sample to measure. */
export const DEFAULT_CHARS_PER_SECOND = 14;

/** How much of a neighbouring line a continuity-aware provider (ElevenLabs) is given. */
const NEIGHBOUR_CHARS = 500;

/** One line with everything the request needs: its effective voice, dialect and delivery. */
export interface PlannedLine {
  line: VoiceLine;
  /** Position in the script. */
  index: number;
  preset: VoicePreset;
  dialect: VoiceDialect;
  /** The model is not one the dialect was written for. */
  approximate: boolean;
  /** The words a listener hears (tags removed). */
  spoken: string;
  /** Engine hash of this line's own single request (no neighbours); `planLines` fills it. */
  fingerprint: string;
}

/** One provider request: a line, or a scene of consecutive lines read in one go. */
export interface RequestPlan {
  lines: PlannedLine[];
  input: Omit<EngineSynthesisInput, "signal">;
  scene: boolean;
  /** Characters sent (speaker text and style). */
  chars: number;
  /** Expected length of the audio, seconds. */
  seconds: number;
}

/** The vendor family an unknown model of a service falls back to (`dialectForModel`'s hint). */
export function vendorHintOf(
  providerId: VoiceProviderId,
  model: string,
): "gemini" | "openai" | "elevenlabs" | null {
  switch (providerId) {
    case "gemini":
      return "gemini";
    case "openai":
      return "openai";
    case "elevenlabs":
      return "elevenlabs";
    case "openrouter": {
      const vendor = model.trim().toLowerCase().split("/")[0];
      if (vendor === "google") return "gemini";
      if (vendor === "openai") return "openai";
      if (vendor === "elevenlabs") return "elevenlabs";
      return null;
    }
    case "custom":
      return null;
  }
}

export function dialectOfPreset(preset: Pick<VoicePreset, "providerId" | "model">): {
  dialect: VoiceDialect;
  approximate: boolean;
} {
  const match = dialectForModel(preset.model, vendorHintOf(preset.providerId, preset.model));
  return { dialect: VOICE_DIALECTS[match.dialect], approximate: match.approximate };
}

/** Speech pace of a voice: measured on its sample when it has one, else the default. */
export function charsPerSecondOf(preset: VoicePreset): number {
  const sample = preset.sample;
  if (!sample || sample.audio.durationSeconds <= 0) return DEFAULT_CHARS_PER_SECOND;
  const measured = sample.text.length / sample.audio.durationSeconds;
  // A sample of one word or a long pause says little about the pace: keep it within what speech can be.
  return Math.min(40, Math.max(5, measured));
}

export function plannedLine(line: VoiceLine, index: number, preset: VoicePreset): PlannedLine {
  const { dialect, approximate } = dialectOfPreset(preset);
  return {
    line,
    index,
    preset,
    dialect,
    approximate,
    spoken: spokenText(dialect, line.speakerText),
    fingerprint: "",
  };
}

function neighbour(
  all: readonly VoiceLine[],
  index: number,
  dialect: VoiceDialect,
  side: "before" | "after",
) {
  if (!dialect.id.startsWith("elevenlabs")) return undefined;
  const line = all[side === "before" ? index - 1 : index + 1];
  if (!line) return undefined;
  const spoken = spokenText(dialect, line.speakerText);
  if (spoken.length === 0) return undefined;
  return side === "before" ? spoken.slice(-NEIGHBOUR_CHARS) : spoken.slice(0, NEIGHBOUR_CHARS);
}

/**
 * Groups the lines to generate into provider requests. A scene is consecutive script lines with the same voice and
 * delivery, at most `VOICE_LIMITS.sceneLines` of them and within the dialect's length limit; it is on by default for
 * Gemini (one take of the whole passage keeps the pacing and tone), and `scene` overrides that for every dialect.
 */
export function planRequests(
  lines: readonly PlannedLine[],
  script: readonly VoiceLine[],
  options: { scene?: boolean; language: string | null; fresh?: boolean },
): RequestPlan[] {
  const groups: PlannedLine[][] = [];
  for (const planned of lines) {
    const group = groups[groups.length - 1];
    const last = group?.[group.length - 1];
    const sceneOn = options.scene ?? planned.dialect.id === "gemini-tts";
    const joined = group
      ? group.reduce((sum, entry) => sum + entry.line.speakerText.length + 1, 0)
      : 0;
    const joins =
      sceneOn &&
      group !== undefined &&
      last !== undefined &&
      last.preset.id === planned.preset.id &&
      last.line.style === planned.line.style &&
      planned.index === last.index + 1 &&
      group.length < VOICE_LIMITS.sceneLines &&
      joined + planned.line.speakerText.length <= planned.dialect.maxChars;
    if (joins) group.push(planned);
    else groups.push([planned]);
  }
  return groups.map((group) => {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) throw new Error("empty request group");
    const { preset, dialect } = first;
    const speaker = group.map((entry) => entry.line.speakerText).join("\n");
    const style = first.line.style;
    const previousText = neighbour(script, first.index, dialect, "before");
    const nextText = neighbour(script, last.index, dialect, "after");
    const spokenChars = group.reduce((sum, entry) => sum + entry.spoken.length, 0);
    return {
      lines: group,
      scene: group.length > 1,
      chars: speaker.length + style.length,
      seconds: spokenChars / charsPerSecondOf(preset),
      input: {
        preset: {
          providerId: preset.providerId,
          model: preset.model,
          voice: preset.voice,
          style: preset.style,
          settings: preset.settings,
        },
        text: speaker,
        ...(style.length > 0 && { style }),
        ...(previousText !== undefined && { previousText }),
        ...(nextText !== undefined && { nextText }),
        ...(options.language !== null && { language: options.language }),
        ...(options.fresh === true && { fresh: true }),
      },
    };
  });
}
