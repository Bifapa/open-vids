import { basename } from "node:path";

const MAX_SCRUBBED_STRING_LENGTH = 240;

function truncateScrubbedString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function scrubUrlQueryStrings(value: string): string {
  return value.replace(/\b(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1?…");
}

const SEGMENT = String.raw`[^\s/\\'"]+`;
const SEGMENT_NODOT = String.raw`[^\s/\\'".]+`;
const TOKEN_TAIL = String.raw`[^\s'")]*`;

const ABSOLUTE_PATH = new RegExp(
  String.raw`(?<![:\w/\\])(?:[A-Za-z]:)?(?:[\\/]${SEGMENT}){2,}${TOKEN_TAIL}`,
  "g",
);

const RELATIVE_PATH = new RegExp(
  String.raw`(?<![\w/\\.])\.{1,2}(?:[\\/]${SEGMENT})+${TOKEN_TAIL}`,
  "g",
);

const ASSET_BASENAME =
  /(?<![\w/\\])[^\s/\\'"]+\.(?:mp4|mov|mkv|webm|avi|m4v|mpe?g|ts|mp3|wav|aac|m4a|flac|ogg|opus|png|jpe?g|gif|webp|svg|html?|json|srt|vtt|ass)\b/gi;

const BARE_RELATIVE_PATH = new RegExp(
  [
    String.raw`(?<![^\s'\"(=,\[])(?:${SEGMENT}[\\/]){2,}${SEGMENT}${TOKEN_TAIL}`,
    String.raw`(?<![^\s'\"(=,\[])${SEGMENT}[\\/]${SEGMENT_NODOT}\.\w{1,8}\b${TOKEN_TAIL}`,
  ].join("|"),
  "g",
);

function scrubFilePaths(value: string): string {
  return value
    .replace(/file:\/\/[^\s'")]+/g, "[file-url]")
    .replace(RELATIVE_PATH, "[path]")
    .replace(BARE_RELATIVE_PATH, "[path]")
    .replace(ABSOLUTE_PATH, "[path]")
    .replace(ASSET_BASENAME, "[file]");
}

export function scrubErrorMessage(value: string, maxLength = MAX_SCRUBBED_STRING_LENGTH): string {
  return truncateScrubbedString(scrubFilePaths(scrubUrlQueryStrings(value)), maxLength);
}

export function scrubFfprobeInput(stderr: string, filePath: string): string {
  if (!filePath) return stderr;
  let redacted = stderr.split(filePath).join("[input]");
  const inputBasename = basename(filePath);
  if (inputBasename) redacted = redacted.split(inputBasename).join("[input]");
  return redacted;
}
