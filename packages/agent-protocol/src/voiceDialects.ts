/**
 * Voice dialects: how a text-to-speech model family wants its script written. One dialect per model family, whatever
 * service sells the model (Gemini through OpenRouter speaks the same dialect as Gemini direct; only the controls
 * differ). A dialect has a machine part (where the style goes, the tag syntax and the full list of tags, limits) that
 * the server checks a script against before any paid call, and a text part (the vendor's own guidance, with the date
 * it was checked) that the agent writing the script reads.
 *
 * Every rule below was read in the vendor's documentation on {@link VOICE_DIALECTS_CHECKED_AT}; the `sources` of each
 * dialect name the pages. Nothing here was measured against a live API.
 */

/** When the vendor documentation behind every dialect was last read. */
export const VOICE_DIALECTS_CHECKED_AT = "2026-10-07";

export const VOICE_DIALECT_IDS = [
  "gemini-tts",
  "openai-gpt-4o-mini-tts",
  "openai-tts-1",
  "elevenlabs-v3",
  "elevenlabs-v2",
  "plain",
] as const;
export type VoiceDialectId = (typeof VOICE_DIALECT_IDS)[number];

/** Where a delivery direction ("calm, slightly amused") goes: a request field, the instructions field, or nowhere. */
export type VoiceStyleTarget = "style" | "instructions" | "none";

/** `angle`: `<sigh>`; `square`: `[sighs]`; `none`: the model reads any bracket aloud. */
export type VoiceTagSyntax = "angle" | "square" | "none";

export interface VoiceDialect {
  id: VoiceDialectId;
  /** Human name of the model family. */
  name: string;
  style: VoiceStyleTarget;
  /** Longest style/instructions text the family takes (0 when `style` is `none`). */
  styleMaxChars: number;
  tags: {
    syntax: VoiceTagSyntax;
    /** Every documented tag, without brackets, lower case. */
    allowed: readonly string[];
    /** The vendor documents tags as free-form: an unlisted tag is a warning, not an error. */
    open: boolean;
  };
  /** How to make a pause, and how to stress a word, in this family's script. */
  pauses: string;
  emphasis: string;
  /** Longest speaker text of one request, in characters. */
  maxChars: number;
  /** Speakers one request can carry. */
  maxSpeakers: number;
  /** Digits are read unreliably: numbers should be written out as words. */
  numbersAsWords: boolean;
  /** The vendor's prompting guidance, short and imperative, for the agent that writes the script. */
  guidance: readonly string[];
  checkedAt: string;
  sources: readonly string[];
}

/** The 40 vocal-burst tags of the Gemini 3.8 TTS prompting guide (speech-generation › Vocal bursts). */
export const GEMINI_TTS_TAGS = [
  "argh",
  "breath",
  "heavy breath",
  "exhales",
  "cackle",
  "cheer",
  "chuckle",
  "chuckles",
  "cough",
  "cry",
  "gasp",
  "giggle",
  "groan",
  "growl",
  "grunt",
  "grr",
  "hiss",
  "laugh",
  "laughter",
  "moan",
  "pant",
  "pff",
  "phew",
  "scream",
  "shout",
  "shriek",
  "sigh",
  "sighs",
  "sneeze",
  "snicker",
  "snort",
  "sob",
  "throat-clearing",
  "tsk",
  "whimper",
  "whispers",
  "whispering",
  "yawn",
  "short pause",
  "long pause",
] as const;

/**
 * The audio tags the ElevenLabs v3/v4 best-practices page lists (voice-related, the "Enhance" list and the examples).
 * The page says the set is open ("there are likely many more effective tags"), so the dialect is `open`; sound-effect
 * tags (`[applause]`, `[gunshot]`) are left out on purpose: a voiceover keeps to the voice.
 */
export const ELEVENLABS_V3_TAGS = [
  "laughs",
  "laughs harder",
  "starts laughing",
  "wheezing",
  "whispers",
  "whisper",
  "whispering",
  "sighs",
  "exhales",
  "exhales sharply",
  "inhales deeply",
  "sarcastic",
  "curious",
  "excited",
  "crying",
  "snorts",
  "mischievously",
  "happy",
  "sad",
  "angry",
  "annoyed",
  "appalled",
  "thoughtful",
  "surprised",
  "laughing",
  "chuckles",
  "clears throat",
  "short pause",
  "long pause",
  "shouting",
  "casual",
  "professional",
  "quietly curious",
  "measured",
] as const;

const GEMINI: VoiceDialect = {
  id: "gemini-tts",
  name: "Gemini 3.8 TTS",
  style: "style",
  styleMaxChars: 200,
  tags: { syntax: "angle", allowed: GEMINI_TTS_TAGS, open: false },
  pauses: "Commas, dashes and ellipses, or <short pause> / <long pause>.",
  emphasis: "CAPITALIZE the stressed word.",
  maxChars: 5_000,
  maxSpeakers: 2,
  numbersAsWords: false,
  guidance: [
    "The text is a verbatim transcript: everything in it is spoken. Never write stage directions or speaker names into it.",
    "Permanent traits of the voice (age, gender, timbre, accent) belong to the voice itself (a designed or picked voice), never to the style.",
    'Try an empty style first; most lines need none. A style is short (a few words: "warm, unhurried"), stays the same across lines and only corrects the delivery.',
    "Vocal events go in angle brackets from the documented list (<sigh>, <laugh>, <whispers>, <short pause>…). Tags are those English words even when the text is in another language.",
    "Only human vocal sounds; never sound effects (applause, thuds, music).",
    "Split long text into lines of a few sentences; when the emotion changes, start a new line.",
    "Write natural spoken language; light disfluencies make it sound less read.",
  ],
  checkedAt: VOICE_DIALECTS_CHECKED_AT,
  sources: [
    "https://ai.google.dev/gemini-api/docs/speech-generation",
    "https://ai.google.dev/gemini-api/docs/voice-design",
  ],
};

const OPENAI_INSTRUCTIONS: VoiceDialect = {
  id: "openai-gpt-4o-mini-tts",
  name: "OpenAI gpt-4o-mini-tts",
  style: "instructions",
  styleMaxChars: 1_000,
  tags: { syntax: "none", allowed: [], open: false },
  pauses: "Punctuation only: commas, periods, ellipses.",
  emphasis: "Word order and punctuation; describe stress in the instructions.",
  maxChars: 4_096,
  maxSpeakers: 1,
  numbersAsWords: false,
  guidance: [
    "No inline tags: brackets are read aloud. Delivery (tone, pace, accent, emotion) goes in the instructions.",
    'Instructions are short and concrete ("Calm, warm narrator; unhurried; smile in the voice").',
    "Keep each line under 4096 characters; shorter lines give steadier results.",
  ],
  checkedAt: VOICE_DIALECTS_CHECKED_AT,
  sources: [
    "https://platform.openai.com/docs/guides/text-to-speech",
    "https://platform.openai.com/docs/api-reference/audio/createSpeech",
  ],
};

const OPENAI_TTS1: VoiceDialect = {
  ...OPENAI_INSTRUCTIONS,
  id: "openai-tts-1",
  name: "OpenAI tts-1",
  style: "none",
  styleMaxChars: 0,
  guidance: [
    "No inline tags and no instructions: the voice and the punctuation carry the delivery.",
    "Keep each line under 4096 characters.",
  ],
};

const ELEVENLABS_V3: VoiceDialect = {
  id: "elevenlabs-v3",
  name: "ElevenLabs v3 / v4",
  style: "none",
  styleMaxChars: 0,
  tags: { syntax: "square", allowed: ELEVENLABS_V3_TAGS, open: true },
  pauses: "Ellipses (…) add pauses and weight; SSML <break> is not supported.",
  emphasis: "CAPITALIZE the stressed word.",
  maxChars: 5_000,
  maxSpeakers: 1,
  numbersAsWords: false,
  guidance: [
    "Delivery tags go in square brackets right where the delivery changes: [whispers], [sighs], [excited].",
    "Text outside brackets is spoken: never write stage directions as plain text.",
    "Pauses come from ellipses (…), emphasis from CAPITALS; SSML <break> tags are not supported.",
    "Match the tags to the voice: a calm voice will not shout convincingly.",
    "Keep to voice tags; sound-effect tags ([applause], [gunshot]) do not belong in a voiceover.",
  ],
  checkedAt: VOICE_DIALECTS_CHECKED_AT,
  sources: [
    "https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices",
    "https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4",
  ],
};

const ELEVENLABS_V2: VoiceDialect = {
  id: "elevenlabs-v2",
  name: "ElevenLabs Multilingual v2 / Flash",
  style: "none",
  styleMaxChars: 0,
  tags: { syntax: "none", allowed: [], open: false },
  pauses: "Punctuation; ellipses for longer pauses.",
  emphasis: "Punctuation and word order.",
  maxChars: 10_000,
  maxSpeakers: 1,
  numbersAsWords: true,
  guidance: [
    "No audio tags: these models read brackets aloud. Delivery comes from the voice and its settings.",
    "Write numbers, dates and abbreviations as words.",
  ],
  checkedAt: VOICE_DIALECTS_CHECKED_AT,
  sources: ["https://elevenlabs.io/docs/overview/models"],
};

const PLAIN: VoiceDialect = {
  id: "plain",
  name: "Plain text",
  style: "none",
  styleMaxChars: 0,
  tags: { syntax: "none", allowed: [], open: false },
  pauses: "Punctuation only.",
  emphasis: "Punctuation and word order.",
  maxChars: 4_096,
  maxSpeakers: 1,
  numbersAsWords: true,
  guidance: [
    "Plain text and punctuation only: no tags, no markup, no stage directions.",
    "Write numbers, dates, units and abbreviations out as words.",
  ],
  checkedAt: VOICE_DIALECTS_CHECKED_AT,
  sources: [],
};

export const VOICE_DIALECTS: Readonly<Record<VoiceDialectId, VoiceDialect>> = {
  "gemini-tts": GEMINI,
  "openai-gpt-4o-mini-tts": OPENAI_INSTRUCTIONS,
  "openai-tts-1": OPENAI_TTS1,
  "elevenlabs-v3": ELEVENLABS_V3,
  "elevenlabs-v2": ELEVENLABS_V2,
  plain: PLAIN,
};

export function isVoiceDialectId(value: unknown): value is VoiceDialectId {
  return typeof value === "string" && VOICE_DIALECT_IDS.some((id) => id === value);
}

/**
 * The dialect of a model, by family. `approximate` is set when the model is not one the dialect was written for and
 * the nearest family was taken: the caller shows a warning. `family` is the vendor the model belongs to when the
 * service is a reseller (OpenRouter's `google/…` ids).
 */
export interface VoiceDialectMatch {
  dialect: VoiceDialectId;
  approximate: boolean;
}

/**
 * Which dialect a model speaks. `vendorHint` is the family to fall back to for an unknown model of a known service
 * (`gemini`, `openai`, `elevenlabs`); `null` (a custom server) means plain text.
 */
export function dialectForModel(
  model: string,
  vendorHint: "gemini" | "openai" | "elevenlabs" | null,
): VoiceDialectMatch {
  const id = model
    .trim()
    .toLowerCase()
    .replace(/^(google|openai|elevenlabs)\//, "");
  if (/^gemini-3\.8-flash(-lite)?-tts\b/.test(id))
    return { dialect: "gemini-tts", approximate: false };
  if (/^gemini-.*tts/.test(id)) return { dialect: "gemini-tts", approximate: true };
  if (/^gpt-4o-mini-tts\b/.test(id))
    return { dialect: "openai-gpt-4o-mini-tts", approximate: false };
  if (/^tts-1(-hd)?\b/.test(id)) return { dialect: "openai-tts-1", approximate: false };
  if (/^gpt-.*tts/.test(id)) return { dialect: "openai-gpt-4o-mini-tts", approximate: true };
  if (/^eleven_v[34]\b/.test(id) || /^eleven_v[34]_/.test(id))
    return { dialect: "elevenlabs-v3", approximate: false };
  if (/^eleven_(multilingual|flash|turbo)_v2/.test(id))
    return { dialect: "elevenlabs-v2", approximate: false };
  if (/^eleven_/.test(id)) return { dialect: "elevenlabs-v3", approximate: true };
  switch (vendorHint) {
    case "gemini":
      return { dialect: "gemini-tts", approximate: true };
    case "openai":
      return { dialect: "openai-gpt-4o-mini-tts", approximate: true };
    case "elevenlabs":
      return { dialect: "elevenlabs-v3", approximate: true };
    case null:
      return { dialect: "plain", approximate: false };
  }
}

// ── Script text: tags, chips, captions ───────────────────────────────────────

/** A piece of speaker text: words to speak, or a tag in the dialect's syntax (without its brackets). */
export type VoiceTextSegment =
  | { kind: "text"; text: string }
  | { kind: "tag"; tag: string; known: boolean };

const ANGLE_TAG = /<\s*([a-z][a-z' -]{0,40}?)\s*>/gi;
const SQUARE_TAG = /\[\s*([^[\]\n]{1,60}?)\s*\]/g;
const SSML_TAG = /<\s*\/?\s*(break|speak|prosody|emphasis|phoneme|say-as|sub)\b[^>]*>/i;

function isKnownTag(dialect: VoiceDialect, tag: string): boolean {
  const key = tag.trim().toLowerCase().replace(/\s+/g, " ");
  return dialect.tags.allowed.includes(key);
}

/** Splits speaker text into spoken text and the dialect's tags (for chips in the UI). */
export function voiceTextSegments(dialect: VoiceDialect, text: string): VoiceTextSegment[] {
  const syntax = dialect.tags.syntax;
  if (syntax === "none") return text.length > 0 ? [{ kind: "text", text }] : [];
  const pattern =
    syntax === "angle" ? new RegExp(ANGLE_TAG.source, "gi") : new RegExp(SQUARE_TAG.source, "g");
  const segments: VoiceTextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) segments.push({ kind: "text", text: text.slice(last, at) });
    const tag = (match[1] ?? "").trim();
    segments.push({ kind: "tag", tag, known: isKnownTag(dialect, tag) });
    last = at + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/** The words a listener hears: tags removed by the dialect's own syntax, spaces tidied (captions, alignment). */
export function spokenText(dialect: VoiceDialect, text: string): string {
  return voiceTextSegments(dialect, text)
    .map((segment) => (segment.kind === "text" ? segment.text : " "))
    .join(" ")
    .replace(/\s+([,.;:!?…])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Script check ─────────────────────────────────────────────────────────────

export const VOICE_SCRIPT_ISSUE_CODES = [
  "empty_text",
  "too_long",
  "foreign_tag_syntax",
  "unknown_tag",
  "tags_unsupported",
  "ssml_unsupported",
  "style_unsupported",
  "style_too_long",
  "digits",
  "approximate_dialect",
] as const;
export type VoiceScriptIssueCode = (typeof VOICE_SCRIPT_ISSUE_CODES)[number];

export interface VoiceScriptIssue {
  /** The line the issue is about; null for the whole script (the model, the dialect). */
  lineId: string | null;
  code: VoiceScriptIssueCode;
  /** An error stops generation; a warning is shown and generation may go on. */
  severity: "error" | "warning";
  /** English, concrete, for the agent and the UI's fallback. */
  message: string;
  /** Values the UI's localized copy interpolates (`tag`, `max`, `length`). */
  params?: Record<string, string | number>;
}

export interface VoiceCheckLine {
  id: string;
  /** The speaker text: what is sent to the model, tags included. */
  speakerText: string;
  style?: string;
}

/**
 * Checks a script against a dialect before any money is spent: a foreign tag syntax, an unknown tag, a style for a
 * model without one, text over the length limit. `extraRules` (the user's "Rules for the agent") are not machine
 * checked; they reach the agent with the dialect's guidance.
 */
export function checkVoiceScript(
  dialect: VoiceDialect,
  lines: readonly VoiceCheckLine[],
  options: { approximate?: boolean; model?: string } = {},
): VoiceScriptIssue[] {
  const issues: VoiceScriptIssue[] = [];
  if (options.approximate) {
    issues.push({
      lineId: null,
      code: "approximate_dialect",
      severity: "warning",
      message: `The model ${options.model ?? "in use"} is not one the ${dialect.name} rules were written for; they are applied as the nearest family.`,
      params: { dialect: dialect.name, model: options.model ?? "" },
    });
  }
  for (const line of lines) issues.push(...checkLine(dialect, line));
  return issues;
}

function checkLine(dialect: VoiceDialect, line: VoiceCheckLine): VoiceScriptIssue[] {
  const issues: VoiceScriptIssue[] = [];
  const error = (
    code: VoiceScriptIssueCode,
    message: string,
    params?: Record<string, string | number>,
  ) =>
    issues.push({
      lineId: line.id,
      code,
      severity: "error",
      message,
      ...(params ? { params } : {}),
    });
  const warn = (
    code: VoiceScriptIssueCode,
    message: string,
    params?: Record<string, string | number>,
  ) =>
    issues.push({
      lineId: line.id,
      code,
      severity: "warning",
      message,
      ...(params ? { params } : {}),
    });
  const text = line.speakerText;
  if (spokenText(dialect, text).length === 0) error("empty_text", "The line has nothing to speak.");
  if (text.length > dialect.maxChars) {
    error(
      "too_long",
      `The line is ${text.length} characters; ${dialect.name} takes at most ${dialect.maxChars} per request. Split it.`,
      { length: text.length, max: dialect.maxChars },
    );
  }
  const style = line.style?.trim() ?? "";
  if (style.length > 0 && dialect.style === "none") {
    error(
      "style_unsupported",
      `${dialect.name} has no style or instructions field; drop the style and carry the delivery with the voice${dialect.tags.syntax === "none" ? " and punctuation" : " and tags"}.`,
    );
  } else if (style.length > dialect.styleMaxChars && dialect.style !== "none") {
    error(
      "style_too_long",
      `The style is ${style.length} characters; keep it under ${dialect.styleMaxChars}.`,
      {
        length: style.length,
        max: dialect.styleMaxChars,
      },
    );
  }
  if (SSML_TAG.test(text)) {
    error(
      "ssml_unsupported",
      `${dialect.name} does not support SSML tags such as <break>; ${dialect.pauses}`,
    );
  }
  const syntax = dialect.tags.syntax;
  const angle = [...text.matchAll(new RegExp(ANGLE_TAG.source, "gi"))]
    .map((m) => (m[1] ?? "").trim())
    .filter((tag) => !SSML_TAG.test(`<${tag}>`));
  const square = [...text.matchAll(new RegExp(SQUARE_TAG.source, "g"))].map((m) =>
    (m[1] ?? "").trim(),
  );
  if (syntax === "none") {
    for (const tag of [...angle.map((t) => `<${t}>`), ...square.map((t) => `[${t}]`)]) {
      error(
        "tags_unsupported",
        `${dialect.name} reads ${tag} aloud: it has no inline tags. ${dialect.pauses}`,
        {
          tag,
        },
      );
    }
  } else {
    const foreign = syntax === "angle" ? square.map((t) => `[${t}]`) : angle.map((t) => `<${t}>`);
    const own = syntax === "angle" ? angle : square;
    for (const tag of foreign) {
      error(
        "foreign_tag_syntax",
        `${tag} is written in another model's tag syntax; ${dialect.name} uses ${syntax === "angle" ? "<tag>" : "[tag]"}.`,
        { tag },
      );
    }
    for (const tag of own) {
      if (isKnownTag(dialect, tag)) continue;
      const shown = syntax === "angle" ? `<${tag}>` : `[${tag}]`;
      if (dialect.tags.open) {
        warn(
          "unknown_tag",
          `${shown} is not a documented ${dialect.name} tag; it may be ignored or read aloud.`,
          {
            tag: shown,
          },
        );
      } else {
        error(
          "unknown_tag",
          `${shown} is not a ${dialect.name} tag. Allowed: ${dialect.tags.allowed.map((t) => `<${t}>`).join(" ")}.`,
          { tag: shown },
        );
      }
    }
  }
  if (dialect.numbersAsWords && /\d/.test(spokenText(dialect, text))) {
    warn("digits", "Write numbers out as words: this model reads digits unreliably.");
  }
  return issues;
}

/** The dialect as text for the agent: machine rules, the vendor's guidance and the user's own rules. */
export function renderVoiceDialect(dialect: VoiceDialect, userRules = ""): string {
  const tagLine =
    dialect.tags.syntax === "none"
      ? "Inline tags: none (brackets are read aloud)."
      : `Inline tags: ${dialect.tags.syntax === "angle" ? "<tag>" : "[tag]"}${dialect.tags.open ? " (documented list below; others may be ignored)" : " (only these)"}: ${dialect.tags.allowed.map((t) => (dialect.tags.syntax === "angle" ? `<${t}>` : `[${t}]`)).join(" ")}.`;
  const styleLine =
    dialect.style === "none"
      ? "Style: none — do not send a style."
      : `Style: the ${dialect.style === "style" ? "style field" : "instructions field"}, at most ${dialect.styleMaxChars} characters.`;
  const lines = [
    `Voice dialect: ${dialect.name} (rules checked ${dialect.checkedAt}).`,
    styleLine,
    tagLine,
    `Pauses: ${dialect.pauses}`,
    `Emphasis: ${dialect.emphasis}`,
    `At most ${dialect.maxChars} characters of speaker text per line.${dialect.numbersAsWords ? " Write numbers as words." : ""}`,
    "Guidance:",
    ...dialect.guidance.map((rule) => `- ${rule}`),
  ];
  const rules = userRules.trim();
  if (rules.length > 0)
    lines.push("The user's rules for this provider (they win over the guidance):", rules);
  return lines.join("\n");
}
