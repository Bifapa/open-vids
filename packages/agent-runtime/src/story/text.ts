import { clock } from "../analysis/format.js";

/** Everything the story tools return is compact text for the model, capped at this many characters. */
export const RESULT_CHARS = 14_000;

/** Seconds (or any number) with at most two decimals: a value the model can pass straight back as an argument. */
export const num = (value: number) => `${Number(value.toFixed(2))}`;

/** One line of text: whitespace collapsed. */
export const cell = (value: string) => value.replace(/\s+/g, " ").trim();

/** `text` cut to `limit` characters, with `notice` as its last line when something was left out. */
export function cap(
  text: string,
  limit = RESULT_CHARS,
  notice = "… the result is longer than this view and was cut",
): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 60)}\n${notice}`;
}

/** `00:30.0 (30 s)`: readable and directly usable as an argument. */
export const duration = (seconds: number) => `${clock(seconds)} (${num(seconds)} s)`;

/** A title in quotes, on one line. */
export const quoted = (title: string) => `"${cell(title)}"`;
