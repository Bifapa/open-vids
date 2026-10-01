/**
 * Check the locale catalog in `locales/` (the source of truth for UI strings).
 *
 * - `locales/index.json` must be an array of `{code, name}` with unique codes; `en` must be listed.
 * - `locales/en.json` is the source of truth; every listed `<code>.json` must be a flat object
 *   of string messages.
 * - Every message must be valid ICU MessageFormat. `extractIcuArguments` below validates brace
 *   balance and plural/select forms while collecting argument names; `main` additionally runs
 *   every message through `@formatjs/icu-messageformat-parser` on the rare setups where that
 *   transitive studio dependency resolves (it is not a direct dependency, so the dynamic import
 *   usually fails and the built-in validation stands alone).
 * - A key missing from a non-en locale is a WARNING (translations may be partial; English is
 *   the fallback). A key that is not in `en.json` is a FAILURE, as are parse errors and
 *   argument-name mismatches against `en` (a locale must name the same arguments, top-level
 *   and nested inside plural/select options).
 *
 * Run: `bun scripts/check-locales.ts` (root script `locales:check`). Exit 1 on any failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const LOCALES_DIR = join(ROOT, "locales");

export interface LocaleCheckResult {
  failures: string[];
  warnings: string[];
}

export type IcuArgumentParser = (message: string) => Set<string>;

// ---------------------------------------------------------------------------
// Minimal ICU MessageFormat validation: brace balance and plural/select forms,
// collecting the set of argument names (top-level and nested in options).
// Covers the subset the catalog uses: simple arguments, `plural`,
// `selectordinal`, `select`, `number`/`date`/`time` styles, `#` in plurals,
// and apostrophe quoting (`''`, `'{`, `'}`, `'#`).
// ---------------------------------------------------------------------------

const PLURAL_CATEGORIES: Record<string, true> = {
  zero: true,
  one: true,
  two: true,
  few: true,
  many: true,
  other: true,
};
const EXPLICIT_VALUE = /^=\d+(\.\d+)?$/;
const SELECT_KEY = /^[a-zA-Z0-9_-]+$/;
const OFFSET_VALUE = /^\d+(\.\d+)?$/;

interface Cursor {
  index: number;
}

function skipSpaces(text: string, cursor: Cursor): void {
  while (cursor.index < text.length) {
    const char = text[cursor.index];
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") return;
    cursor.index += 1;
  }
}

/** Reads up to the next `,`, `{`, `}`, or whitespace character. */
function readToken(text: string, cursor: Cursor): string {
  const start = cursor.index;
  while (cursor.index < text.length) {
    const char = text[cursor.index];
    if (
      char === "," ||
      char === "{" ||
      char === "}" ||
      char === " " ||
      char === "\t" ||
      char === "\n" ||
      char === "\r"
    ) {
      break;
    }
    cursor.index += 1;
  }
  return text.slice(start, cursor.index);
}

/** Skips an apostrophe-quoted literal (`'` opener already seen at `cursor.index`). */
function skipQuotedLiteral(text: string, cursor: Cursor): void {
  // The opener quotes one special character directly (`'{`, `'}`, `'#`).
  const openerNext = text[cursor.index + 1];
  if (openerNext !== "'") {
    cursor.index += 2;
    return;
  }
  // Otherwise the literal runs to the closing `'` (`''` inside is an escaped quote).
  cursor.index += 1;
  while (cursor.index < text.length) {
    if (text[cursor.index] === "'") {
      if (text[cursor.index + 1] === "'") {
        cursor.index += 2;
        continue;
      }
      cursor.index += 1;
      return;
    }
    cursor.index += 1;
  }
}

function parseMessageText(text: string, cursor: Cursor, args: Set<string>, nested: boolean): void {
  while (cursor.index < text.length) {
    const char = text[cursor.index];
    if (char === "'") {
      const next = text[cursor.index + 1];
      if (next === "'" || next === "{" || next === "}" || next === "#") {
        skipQuotedLiteral(text, cursor);
        continue;
      }
      // A lone apostrophe (as in "l'ami") is a literal character.
      cursor.index += 1;
      continue;
    }
    if (char === "{") {
      parseArgument(text, cursor, args);
      continue;
    }
    if (char === "}") {
      if (nested) return;
      throw new Error(`Unmatched "}" at offset ${cursor.index}`);
    }
    cursor.index += 1;
  }
  if (nested) throw new Error('Unterminated "{" (missing "}")');
}

function parseArgument(text: string, cursor: Cursor, args: Set<string>): void {
  const open = cursor.index;
  cursor.index += 1;
  skipSpaces(text, cursor);
  const name = readToken(text, cursor);
  if (name.length === 0) throw new Error(`Empty argument name at offset ${open}`);
  args.add(name);
  skipSpaces(text, cursor);
  const afterName = text[cursor.index];
  if (afterName === "}") {
    cursor.index += 1;
    return;
  }
  if (afterName !== ",") {
    throw new Error(`Expected "," or "}" after argument "${name}" at offset ${cursor.index}`);
  }
  cursor.index += 1;
  skipSpaces(text, cursor);
  const format = readToken(text, cursor);
  if (format.length === 0) {
    throw new Error(`Missing format for argument "${name}" at offset ${cursor.index}`);
  }
  skipSpaces(text, cursor);
  const afterFormat = text[cursor.index];
  if (afterFormat === "}") {
    cursor.index += 1;
    return;
  }
  if (afterFormat !== ",") {
    throw new Error(`Expected "," or "}" after format "${format}" at offset ${cursor.index}`);
  }
  cursor.index += 1;
  skipSpaces(text, cursor);
  if (format === "plural" || format === "selectordinal" || format === "select") {
    parsePluralOrSelect(text, cursor, args, format, open);
    return;
  }
  if (format === "number" || format === "date" || format === "time") {
    parseSimpleStyle(text, cursor, format, open);
    return;
  }
  throw new Error(`Unknown format "${format}" for argument "${name}" at offset ${open}`);
}

/** A `number`/`date`/`time` style runs to the argument's closing brace. */
function parseSimpleStyle(text: string, cursor: Cursor, format: string, open: number): void {
  while (cursor.index < text.length) {
    const char = text[cursor.index];
    if (char === "}") {
      cursor.index += 1;
      return;
    }
    if (char === "{") {
      throw new Error(`Unexpected "{" in ${format} style at offset ${cursor.index}`);
    }
    cursor.index += 1;
  }
  throw new Error(`Unterminated "{" opened at offset ${open}`);
}

function parsePluralOrSelect(
  text: string,
  cursor: Cursor,
  args: Set<string>,
  format: string,
  open: number,
): void {
  if (format !== "select" && text.startsWith("offset:", cursor.index)) {
    cursor.index += "offset:".length;
    skipSpaces(text, cursor);
    const value = readToken(text, cursor);
    if (!OFFSET_VALUE.test(value)) {
      throw new Error(`Invalid offset "${value}" in ${format} at offset ${open}`);
    }
    skipSpaces(text, cursor);
  }
  let options = 0;
  let sawOther = false;
  while (true) {
    skipSpaces(text, cursor);
    if (cursor.index >= text.length) throw new Error(`Unterminated "{" opened at offset ${open}`);
    if (text[cursor.index] === "}") {
      cursor.index += 1;
      break;
    }
    const selector = readToken(text, cursor);
    if (selector.length === 0) {
      throw new Error(`Expected a ${format} selector at offset ${cursor.index}`);
    }
    if (format === "select") {
      if (!SELECT_KEY.test(selector)) {
        throw new Error(`Invalid select selector "${selector}" at offset ${cursor.index}`);
      }
    } else if (selector.startsWith("=")) {
      if (!EXPLICIT_VALUE.test(selector)) {
        throw new Error(`Invalid plural selector "${selector}" at offset ${cursor.index}`);
      }
    } else if (!(selector in PLURAL_CATEGORIES)) {
      throw new Error(`Unknown plural selector "${selector}" at offset ${cursor.index}`);
    }
    if (selector === "other") sawOther = true;
    options += 1;
    skipSpaces(text, cursor);
    if (text[cursor.index] !== "{") {
      throw new Error(
        `Expected "{" after ${format} selector "${selector}" at offset ${cursor.index}`,
      );
    }
    cursor.index += 1;
    parseMessageText(text, cursor, args, true);
    if (text[cursor.index] !== "}") throw new Error(`Unterminated "{" opened at offset ${open}`);
    cursor.index += 1;
  }
  if (options === 0) throw new Error(`${format} at offset ${open} has no options`);
  if (!sawOther) throw new Error(`${format} at offset ${open} is missing the "other" option`);
}

/** Parses `message`, returning every argument name; throws when the message is not valid ICU. */
export function extractIcuArguments(message: string): Set<string> {
  const args = new Set<string>();
  parseMessageText(message, { index: 0 }, args, false);
  return args;
}

// ---------------------------------------------------------------------------
// Catalog check (pure: `indexJson` and `localeJsonByCode` are already parsed).
// ---------------------------------------------------------------------------

export function checkLocaleCatalog(
  indexJson: unknown,
  localeJsonByCode: Record<string, unknown>,
  parseMessage: IcuArgumentParser = extractIcuArguments,
): LocaleCheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(indexJson)) {
    failures.push("index.json: expected an array of {code, name}");
    return { failures, warnings };
  }
  const entries: unknown[] = indexJson;
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      !("code" in entry) ||
      !("name" in entry)
    ) {
      failures.push("index.json: every entry must be {code, name} with non-empty strings");
      continue;
    }
    const { code, name } = entry;
    if (
      typeof code !== "string" ||
      typeof name !== "string" ||
      code.length === 0 ||
      name.length === 0
    ) {
      failures.push("index.json: every entry must be {code, name} with non-empty strings");
      continue;
    }
    if (seen.has(code)) {
      failures.push(`index.json: duplicate code "${code}"`);
      continue;
    }
    seen.add(code);
    codes.push(code);
  }
  if (!seen.has("en")) failures.push('index.json: "en" must be listed (source of truth)');

  // The English file stays comparable even when the index forgets to list it.
  const loadOrder = codes.includes("en") ? codes : ["en", ...codes];
  const stringsByCode = new Map<string, Map<string, string>>();
  const argsByCode = new Map<string, Map<string, Set<string>>>();
  for (const code of loadOrder) {
    if (!(code in localeJsonByCode)) {
      failures.push(`${code}.json: file not found (locales/${code}.json)`);
      continue;
    }
    const raw = localeJsonByCode[code];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      failures.push(`${code}.json: expected a flat object of string messages`);
      continue;
    }
    const strings = new Map<string, string>();
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== "string") {
        failures.push(`${code}.json: key "${key}" must be a string message`);
      } else {
        strings.set(key, value);
      }
    }
    stringsByCode.set(code, strings);
    const parsed = new Map<string, Set<string>>();
    argsByCode.set(code, parsed);
    for (const [key, message] of strings) {
      try {
        parsed.set(key, parseMessage(message));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${code}.json: key "${key}" does not parse: ${detail}`);
      }
    }
  }

  const enStrings = stringsByCode.get("en");
  const enArgs = argsByCode.get("en");
  if (enStrings && enArgs) {
    for (const code of codes) {
      if (code === "en") continue;
      const strings = stringsByCode.get(code);
      const parsed = argsByCode.get(code);
      if (!strings || !parsed) continue;
      for (const key of enStrings.keys()) {
        if (!strings.has(key)) {
          warnings.push(`${code}.json: missing key "${key}" (English fallback is used)`);
        }
      }
      for (const key of strings.keys()) {
        if (!enStrings.has(key)) {
          failures.push(`${code}.json: extra key "${key}" (not in en.json)`);
        }
      }
      for (const key of enStrings.keys()) {
        const expected = enArgs.get(key);
        const actual = parsed.get(key);
        if (!expected || !actual) continue;
        const mismatch =
          expected.size !== actual.size || [...expected].some((name) => !actual.has(name));
        if (mismatch) {
          const describe = (names: Set<string>): string =>
            names.size === 0 ? "(none)" : `{${[...names].sort().join(", ")}}`;
          failures.push(
            `${code}.json: key "${key}" names different arguments ` +
              `(en: ${describe(expected)}, ${code}: ${describe(actual)})`,
          );
        }
      }
    }
  }
  return { failures, warnings };
}

// ---------------------------------------------------------------------------
// Main (reads the files, prints the report).
// ---------------------------------------------------------------------------

interface FileRead {
  found: boolean;
  value: unknown;
  error: string;
}

function readJsonFile(path: string): FileRead {
  if (!existsSync(path)) return { found: false, value: undefined, error: "" };
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return { found: true, value, error: "" };
  } catch (error) {
    return {
      found: true,
      value: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isParseFunction(value: unknown): value is (message: string) => unknown {
  return typeof value === "function";
}

async function loadRealValidator(): Promise<((message: string) => void) | null> {
  try {
    // Genuinely runtime-selected: the transitive dependency is usually absent, so no static
    // import can work; the segments also keep tsc from resolving the specifier. Failure falls
    // back to the built-in parser.
    const specifier = ["@formatjs", "icu-messageformat-parser"].join("/");
    const module: unknown = await import(specifier);
    if (typeof module !== "object" || module === null || !("parse" in module)) return null;
    const parse = module.parse;
    if (!isParseFunction(parse)) return null;
    return (message: string) => {
      parse(message);
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const indexRead = readJsonFile(join(LOCALES_DIR, "index.json"));
  if (!indexRead.found || indexRead.error.length > 0) {
    const reason = indexRead.found ? `: ${indexRead.error}` : " (file not found)";
    console.error(`ERROR index.json: cannot read locales/index.json${reason}`);
    console.error("Locales FAILED: 1 error, 0 warnings.");
    process.exitCode = 1;
    return;
  }
  const indexJson: unknown = indexRead.value;
  const listed: string[] = [];
  if (Array.isArray(indexJson)) {
    for (const entry of indexJson) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        "code" in entry &&
        typeof entry.code === "string" &&
        entry.code.length > 0 &&
        !listed.includes(entry.code)
      ) {
        listed.push(entry.code);
      }
    }
  }
  const codesToRead = listed.includes("en") ? listed : ["en", ...listed];

  const localeJsonByCode: Record<string, unknown> = {};
  const ioFailures: string[] = [];
  for (const code of codesToRead) {
    const filePath = join(LOCALES_DIR, `${code}.json`);
    const read = readJsonFile(filePath);
    if (!read.found || read.error.length > 0) {
      // A file that is only listed but absent is reported by checkLocaleCatalog.
      if (read.found) ioFailures.push(`${code}.json: cannot parse ${filePath}: ${read.error}`);
    } else {
      localeJsonByCode[code] = read.value;
    }
  }

  const realValidate = await loadRealValidator();
  const parseMessage: IcuArgumentParser =
    realValidate === null
      ? extractIcuArguments
      : (message) => {
          realValidate(message);
          return extractIcuArguments(message);
        };
  const { failures, warnings } = checkLocaleCatalog(indexJson, localeJsonByCode, parseMessage);
  const allFailures = [...ioFailures, ...failures];
  for (const warning of warnings) console.error(`WARNING ${warning}`);
  for (const failure of allFailures) console.error(`ERROR ${failure}`);
  if (allFailures.length > 0) {
    console.error(`Locales FAILED: ${allFailures.length} error(s), ${warnings.length} warning(s).`);
    process.exitCode = 1;
    return;
  }
  const languages = Object.keys(localeJsonByCode).sort();
  const enRaw = localeJsonByCode.en;
  const enKeys =
    typeof enRaw === "object" && enRaw !== null && !Array.isArray(enRaw)
      ? Object.keys(enRaw).length
      : 0;
  console.log(
    `Locales OK: ${languages.length} language(s) (${languages.join(", ")}), ` +
      `${enKeys} key(s) in en, ${warnings.length} warning(s).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
