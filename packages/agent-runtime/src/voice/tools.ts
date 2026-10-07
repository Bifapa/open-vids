import {
  VOICE_LIMITS,
  isRecord,
  type AgentId,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import type { HostTool, ToolActivity } from "../backend.js";
import { withInheritedTools } from "../agents/inherit.js";
import type { ToolExecutor } from "../agents/tools.js";

export const VOICE_TOOL_NAMES = {
  setup: "request_voice_setup",
  generate: "generate_voiceover",
} as const;

export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[keyof typeof VOICE_TOOL_NAMES];

export function isVoiceToolName(name: string): name is VoiceToolName {
  return Object.values<string>(VOICE_TOOL_NAMES).includes(name);
}

/**
 * What one agent gets as if every specialist were on: Audio speaks — it asks for the voice and generates the
 * recording; the Director asks for the voice too (it writes the script and may show it as a plan). {@link
 * voiceToolsFor} adds the team rule.
 */
function voiceBaseTools(agent: AgentId): VoiceToolName[] {
  const { setup, generate } = VOICE_TOOL_NAMES;
  if (agent === "audio") return [setup, generate];
  if (agent === "director") return [setup];
  return [];
}

/**
 * Which voice tools an agent gets. Both tools exist only when the runtime has a voice host. The
 * Director may ask for the voice; Audio asks for it and generates the voiceover. When Audio is off in the chat the
 * Director also gets `generate_voiceover` (the work moves to it, under the same approvals), see `withInheritedTools`.
 * A specialist only gets them when it is on the team; Jev and the other specialists never do.
 */
export function voiceToolsFor(agent: AgentId, enabled: readonly SpecialistId[]): VoiceToolName[] {
  const onTeam = agent === "director" || enabled.some((specialist) => specialist === agent);
  if (!onTeam) return [];
  return withInheritedTools(agent, enabled, voiceBaseTools);
}

const DESCRIPTIONS: Record<VoiceToolName, string> = {
  request_voice_setup: `Ask the user to choose the voice of the narration, and wait for their choice. Call it FIRST whenever the user wants a voiceover or narration: the chat shows the project's current voice ("Use" / "Change"), asks the user to connect a voice provider when none is set up, or opens the voice setup (the provider's voices, sound check). Pass the language of the script, sampleText (the first sentence of the script: every voice the user auditions speaks it, so write it in the script's language) and suggestion (the character you think fits: "warm, mid-30s, calm, unhurried"). The call returns the chosen voice and that voice's script dialect (the tags, pauses, style and length limits the script must follow) — write the script in it. If the user declines or does not answer, no voiceover can be generated: do not try another way, tell the user a voice is needed. The voices belong to the user's own provider account; you never see or send a key.`,
  generate_voiceover: `Generate the voiceover for a script with the project's voice, paid on the user's own provider account. lines: the lines to add or change, one entry per spoken line: text (what the captions show), speakerText (what the narrator reads — the model's dialect with its tags; defaults to text), style (delivery for this line, only where the dialect has a style), and id (the id of an existing line replaces that line in place and keeps its takes when its text did not change; omit it for a new line, which is appended). The project's script is UPDATED, never replaced: lines you do not pass stay untouched, with their takes and the clips that use them. lineIds: generate only these lines (default: the lines passed in this call that have no current take). The call saves the script, checks it against the dialect before anything is paid (a wrong tag, a style the model does not take, a too long line are returned to you to fix — nothing was generated), asks the user to allow the cost, generates the FIRST line as a pilot and shows it to the user in the chat, and only after they press Continue generates the rest in this same call. If they ask for changes you get their note back and nothing else was generated: change the script and call again. Files go to assets/voice/; the result lists each line's file, start and end in the file and duration. Then place every line on the timeline with edit_timeline add_clip { voiceLine: "<id>", start, track } (the clip takes the file and range of the line's selected take) and lower the music under it with duck_audio. Needs the project's voice: call request_voice_setup first.`,
};

const stringProperty = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength !== undefined && { maxLength }),
});

const PARAMETERS: Record<VoiceToolName, Record<string, unknown>> = {
  request_voice_setup: {
    type: "object",
    properties: {
      language: stringProperty(
        "BCP-47 language of the script (en-US, ru-RU, de-DE…), to filter the voices the user sees. Empty when unknown.",
        VOICE_LIMITS.languageChars,
      ),
      sampleText: stringProperty(
        "The first sentence of the script, in the script's language: the phrase every voice the user auditions speaks.",
        VOICE_LIMITS.sampleTextChars,
      ),
      suggestion: stringProperty(
        "Your proposal for the voice's character (gender, age, tone, pace) in a few words, shown to the user.",
        VOICE_LIMITS.suggestionChars,
      ),
    },
    required: ["sampleText"],
    additionalProperties: false,
  },
  generate_voiceover: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        minItems: 1,
        maxItems: VOICE_LIMITS.lines,
        description:
          "The lines to add or change, in the order they are spoken: one entry per line; other lines of the script stay as they are.",
        items: {
          type: "object",
          properties: {
            id: stringProperty(
              "Keeps this line's takes when its text did not change. Omit for a new line; use 1–64 letters, digits, - or _.",
              64,
            ),
            text: stringProperty(
              "The source text: what captions show (no tags).",
              VOICE_LIMITS.lineChars,
            ),
            speakerText: stringProperty(
              "What the narrator reads, written in the voice dialect (tags included). Defaults to text.",
              VOICE_LIMITS.lineChars,
            ),
            style: stringProperty(
              "Delivery for this line (the dialect's style or instructions); empty uses the voice's own.",
              VOICE_LIMITS.styleChars,
            ),
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      lineIds: {
        type: "array",
        maxItems: VOICE_LIMITS.lines,
        items: { type: "string", maxLength: 64 },
        description:
          "Generate only these lines (ids of lines of the script). Default: the lines passed in this call that have no current take.",
      },
    },
    required: ["lines"],
    additionalProperties: false,
  },
};

// ── Activity rows ────────────────────────────────────────────────────────────

const ACTIVITIES: Record<VoiceToolName, (args: unknown) => ToolActivity> = {
  request_voice_setup: () => ({
    category: "other",
    label: "Choosing the narrator's voice",
    labelCode: "requesting_voice_setup",
  }),
  generate_voiceover: (args) => {
    const lines = isRecord(args) && Array.isArray(args.lines) ? args.lines.length : 0;
    return lines > 0
      ? {
          category: "edit",
          label: `Generating the voiceover (${lines} ${lines === 1 ? "line" : "lines"})`,
          labelCode: "generating_voiceover",
          labelParams: { count: lines },
        }
      : { category: "edit", label: "Generating the voiceover" };
  },
};

/** The voice tools of one agent; every call goes to `execute` (the running turn's voice executor). */
export function buildVoiceTools(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  execute: ToolExecutor,
): HostTool[] {
  return voiceToolsFor(agent, enabled).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: PARAMETERS[name],
    execute: (args, signal, progress) => execute(name, args, signal, progress),
    activity: (args) => ACTIVITIES[name](args),
  }));
}
