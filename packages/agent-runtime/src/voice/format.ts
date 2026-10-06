import type {
  VoiceLineView,
  VoicePreset,
  VoiceProviderInfo,
  VoiceScriptIssue,
  VoiceScriptView,
  VoiceTake,
} from "@hyperframes/agent-protocol";
import type { VoiceToolError } from "./host.js";

/** Longest part of the server's raw answer shown for a `not_audio` failure. */
const BODY_EXCERPT_CHARS = 400;
/** Longest line text echoed in a result. */
const LINE_EXCERPT_CHARS = 70;

const seconds = (value: number): string => value.toFixed(2);

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The issues of a dialect check, one per line, with the line each is about. */
export function formatIssues(issues: readonly VoiceScriptIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.lineId === null ? "script" : `line ${issue.lineId}`;
      return `- ${where} [${issue.severity}] ${issue.code}: ${issue.message}`;
    })
    .join("\n");
}

/** The text of a failed voice call, with what the agent should do about it. Keys never appear: the server scrubs them. */
export function formatVoiceError(error: VoiceToolError): string {
  const { code, message, params } = error;
  switch (code) {
    case "aborted":
      return "The voiceover call was cancelled (the turn was stopped).";
    case "studio_unavailable":
    case "write_unsettled":
      return message;
    case "invalid_key":
      return `The voice provider rejected the API key (${message}). The key is the user's: tell them to check it in Settings › Voice, or to choose the voice again. Do not retry.`;
    case "rate_limited": {
      const wait =
        typeof params.retryAfterSeconds === "number"
          ? ` Retry in about ${Math.ceil(params.retryAfterSeconds)} seconds.`
          : " The provider did not say when to retry.";
      const daily =
        params.daily === 1
          ? " This is a daily limit: it will not clear within this turn, so do not retry; tell the user."
          : "";
      return `The voice provider is rate limiting the account (${message}).${wait}${daily} Lines that were already generated are kept; calling generate_voiceover again generates only what is missing.`;
    }
    case "quota_exhausted":
      return `The user's voice provider account has no quota or credit left (${message}). Do not retry; tell the user to check their plan or choose another voice.`;
    case "not_audio": {
      const type = typeof params.contentType === "string" ? params.contentType : "unknown";
      const body =
        typeof params.body === "string" && params.body.length > 0
          ? ` It said: ${excerpt(params.body, BODY_EXCERPT_CHARS)}`
          : "";
      return `The voice server answered something that is not audio (content type ${type}; ${message}).${body} The provider's address or model in Settings › Voice is probably wrong: tell the user. Do not retry.`;
    }
    case "not_configured":
      return `There is no usable voice: ${message} Call request_voice_setup so the user can choose and connect one.`;
    case "dialect_violation":
      return `The script does not fit the voice's dialect; nothing was generated or paid. Fix every error and call generate_voiceover again:\n${formatIssues(error.issues)}`;
    case "provider_unreachable":
      return `The voice provider could not be reached (${message}). Tell the user; one retry later may work if it was a network blip.`;
    case "cancelled":
      return "The voice generation was cancelled. Lines that were already generated are kept.";
    default:
      return `Voice service error (${code}): ${message}`;
  }
}

/** The user's rules for a preset's provider, as Settings › Voice stores them ("" when there are none). */
export function agentRulesOf(preset: VoicePreset, providers: readonly VoiceProviderInfo[]): string {
  return providers.find((provider) => provider.id === preset.providerId)?.agentRules ?? "";
}

/** The chosen voice, for the agent: who it is, where it speaks, how it is told to deliver. */
export function formatVoice(preset: VoicePreset, provider: VoiceProviderInfo | undefined): string {
  const via = provider ? `${provider.name}, model ${preset.model}` : `model ${preset.model}`;
  const style = preset.style.trim() ? `; delivery: ${excerpt(preset.style, 200)}` : "";
  return `"${preset.name}" (voice ${preset.voice.name}, ${via}${style})`;
}

/** The selected take of a line, when it has one. */
export function selectedTake(line: VoiceLineView): VoiceTake | undefined {
  return line.takes.find((take) => take.id === line.selectedTakeId);
}

/** A line needs generating when it has no current take (none selected, or its text or style changed since). */
export function needsGeneration(line: VoiceLineView): boolean {
  return selectedTake(line) === undefined || line.textChanged;
}

/** One line of a result: where its audio is and how long it is. */
export function formatTake(line: VoiceLineView, take: VoiceTake): string {
  const length = take.end - take.start;
  return `- ${line.id} "${excerpt(line.text, LINE_EXCERPT_CHARS)}": ${take.file}, ${seconds(take.start)}–${seconds(take.end)} s in the file (${seconds(length)} s)`;
}

export interface GeneratedSummary {
  view: VoiceScriptView;
  /** The lines the report covers (ids), in script order. */
  scope: readonly string[];
  generated: number;
  reused: number;
  usdCost: number | null;
  warnings: readonly VoiceScriptIssue[];
  notes: readonly string[];
}

/** What the agent needs after a generation: the takes, how to place them, the cost and the non-fatal notes. */
export function formatGenerated(summary: GeneratedSummary): string {
  const lines = summary.view.lines.filter((line) => summary.scope.includes(line.id));
  const placed = lines.flatMap((line) => {
    const take = selectedTake(line);
    return take ? [formatTake(line, take)] : [];
  });
  const total = lines.reduce((sum, line) => {
    const take = selectedTake(line);
    return take ? sum + (take.end - take.start) : sum;
  }, 0);
  const cost =
    summary.usdCost === null
      ? "cost unknown (no price known for this model)"
      : `cost about $${summary.usdCost.toFixed(4)}`;
  const parts = [
    `Voiceover ready: ${summary.generated} line${summary.generated === 1 ? "" : "s"} generated${summary.reused > 0 ? `, ${summary.reused} reused from earlier takes` : ""}, ${seconds(total)} s of speech in total; ${cost}.`,
    "Lines (file under the project, the line's range in the file, length):",
    ...placed,
    'Place each line with edit_timeline add_clip { voiceLine: "<line id>", start: <seconds on the timeline>, track: <an audio track> }: the clip takes the file, the range and the length from the line\'s selected take. Put the lines one after another in script order with a short pause (about 0.3–0.6 s) between sentences. Then lower the music under the narration with duck_audio { clip: <music clip id>, underTrack: <the narration track> }.',
  ];
  if (summary.warnings.length > 0)
    parts.push(`Script warnings (generation went ahead):\n${formatIssues(summary.warnings)}`);
  if (summary.notes.length > 0)
    parts.push(`Notes from the voice service:\n- ${summary.notes.join("\n- ")}`);
  return parts.join("\n");
}
