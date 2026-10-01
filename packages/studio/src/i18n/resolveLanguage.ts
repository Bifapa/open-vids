import { SOURCE_LANGUAGE } from "./languages";

/**
 * The language code the app shows for a `language` preference. Identical to the algorithm in the Projects page
 * (`apps/desktop/src-tauri/src/home_page/i18n.js`):
 *
 * - a preference that is a supported code is that language;
 * - anything else (`system`, or a code that is not supported) follows `navigatorLanguages` in order, each one
 *   matched exactly first (case-insensitive: `ru` / `RU`), then by its base language (`ru-RU` → `ru`);
 * - nothing matching falls back to English.
 */
export function resolveLanguage(
  preference: string,
  navigatorLanguages: readonly string[],
  codes: readonly string[],
): string {
  if (codes.includes(preference)) return preference;
  const lowered = codes.map((code) => code.toLowerCase());
  const match = (candidate: string): string | undefined => codes[lowered.indexOf(candidate)];
  for (const language of navigatorLanguages) {
    const tag = language.toLowerCase();
    const found = match(tag) ?? match(tag.split("-")[0] ?? "");
    if (found) return found;
  }
  return SOURCE_LANGUAGE;
}
