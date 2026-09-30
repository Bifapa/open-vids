import type { SpeakerTurn, TranscriptArtifact } from "@hyperframes/agent-protocol";
import { buildTranscript } from "./transcript.js";

interface SpeakOptions {
  /** Seconds a word lasts (default 0.3). */
  wordSeconds?: number;
  /** Seconds between two words (default 0.05). */
  gapSeconds?: number;
  /** Time of the first word (default 0). */
  start?: number;
}

/**
 * Recognizer-style words from a script: words separated by spaces, `|1.5` inserts a 1.5 s pause. Punctuation stays on
 * the words, like real recognizer output.
 */
export function speak(
  script: string,
  options: SpeakOptions = {},
): Array<{ text: string; start: number; end: number }> {
  const wordSeconds = options.wordSeconds ?? 0.3;
  const gapSeconds = options.gapSeconds ?? 0.05;
  let time = options.start ?? 0;
  const words: Array<{ text: string; start: number; end: number }> = [];
  for (const token of script.split(/\s+/).filter((part) => part.length > 0)) {
    if (token.startsWith("|")) {
      time += Number(token.slice(1));
      continue;
    }
    words.push({ text: token, start: time, end: time + wordSeconds });
    time += wordSeconds + gapSeconds;
  }
  return words;
}

export function transcriptOf(
  script: string,
  options: SpeakOptions & { turns?: SpeakerTurn[]; language?: string } = {},
): TranscriptArtifact {
  return buildTranscript(
    "media/talk.mp4",
    speak(script, options),
    options.language ?? "en",
    options.turns ?? null,
  );
}
