/**
 * Naming a project from the Start composer's prompt: the instruction one short, tool-less completion runs with, and
 * the sanitizing that turns whatever the model answers into a folder name.
 *
 * Pure on purpose — no harness imports (the OMP-backed call lives in `omp/title.ts`), so the rules are unit-testable.
 * The home page falls back to its own derivation whenever this fails, so a title that sanitizes to nothing is a
 * failure, not an empty name.
 */

/** Longest title kept, in characters: folder names stay readable and well inside every filesystem's limit. */
export const TITLE_MAX_CHARS = 40;

/** The prompt text sent to the model; longer descriptions are cut here (the title needs the gist only). */
const TITLE_PROMPT_CHARS = 4_000;

/** Wrapping quotes and brackets a model likes to add around a title. */
const TITLE_WRAPPERS = /^["'«»„“”‘’`([{]+|["'«»„“”‘’`)\]}]+\s*$/g;

/** Characters that may not appear in a project folder name (Studio's project-id rule), plus control characters. */
const TITLE_BAD_CHARS = /[:/\\]+|\p{Cc}/gu;

/** Emoji and the invisible code points that join them. */
const TITLE_PICTOGRAPHS = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;

/** A leading label the model may add before the title itself. */
const TITLE_LABEL =
  /^(?:here(?:'s| is)[^:]*:\s*|title\s*[:—–-]\s*|заголовок\s*[:—–-]\s*|название\s*[:—–-]\s*)/i;

/** Trailing sentence punctuation: a title is not a sentence. */
const TITLE_TRAILING_PUNCTUATION = /[\s.,;:!?…]+$/;

function languageCaseRule(language: string): string {
  if (language === "en") return "English titles use Title Case (capitalize the main words).";
  if (language === "ru")
    return "Russian titles capitalize only the first word; keep proper names as written.";
  return "Use the language's usual capitalization for titles.";
}

/**
 * The system prompt of the title completion. `language` is the UI language the title must be written in (`en`, `ru`,
 * a tag like `pt-BR`, …); null follows the language of the description.
 */
export function projectTitleInstruction(language: string | null): string {
  const base = language?.trim();
  const languageLine = base
    ? `Write the title in ${base}.`
    : "Write the title in the language of the description.";
  return [
    "You name video projects. Answer with the title alone, wrapped in <title></title>, and nothing else.",
    "Rules:",
    '- 2 to 5 words; no quotes, no emoji, no trailing punctuation, no ":", "/" or "\\".',
    `- ${languageLine} ${languageCaseRule(base?.toLowerCase().split("-")[0] ?? "")}`,
    "- Name what the video is about, not the files or the request.",
  ].join("\n");
}

/** The user turn of the title completion: the description, plus the attached file names for context. */
export function projectTitleUserMessage(prompt: string, files: readonly string[]): string {
  const trimmed = prompt.trim().slice(0, TITLE_PROMPT_CHARS);
  const names = files.slice(0, 32).filter((name) => name.trim().length > 0);
  const lines = [`Description: ${trimmed}`];
  if (names.length > 0) lines.push(`Attached files: ${names.join(", ")}`);
  return lines.join("\n");
}

/**
 * The title out of a completion's text: the `<title>` marker when the model used one, otherwise the whole answer with
 * stray marker tags removed. Returns "" when nothing usable is left.
 */
export function extractProjectTitle(text: string): string {
  const marked = /<title>([\s\S]*?)<\/title>/i.exec(text);
  return sanitizeProjectTitle(marked?.[1] ?? text.replace(/<\/?title>/gi, " "));
}

/**
 * A model's answer as a project name: thinking envelopes and code fences dropped, a leading label and wrapping
 * quotes removed, folder-hostile characters, emoji and trailing punctuation stripped, then cut to
 * {@link TITLE_MAX_CHARS} at a word boundary. Returns "" when no letters or digits remain.
 */
export function sanitizeProjectTitle(raw: string): string {
  let text = String(raw ?? "")
    .replace(/<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi, " ")
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(TITLE_LABEL, "").replace(TITLE_WRAPPERS, "").trim();
  // Wrapping quotes may nest («"Тизер"»): one more pass handles the inner pair.
  text = text.replace(TITLE_WRAPPERS, "").trim();
  text = text
    .replace(TITLE_BAD_CHARS, " ")
    .replace(TITLE_PICTOGRAPHS, "")
    .replace(/\s+/g, " ")
    .trim();
  if ([...text].length > TITLE_MAX_CHARS) {
    const slice = [...text].slice(0, TITLE_MAX_CHARS).join("");
    const boundary = slice.lastIndexOf(" ");
    text = (boundary > 0 ? slice.slice(0, boundary) : slice).trim();
  }
  text = text.replace(TITLE_TRAILING_PUNCTUATION, "").trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}
