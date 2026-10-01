import catalog from "../../../../locales/index.json";

/**
 * The supported languages, from the shared catalog `locales/index.json`. The desktop shell, the Studio server
 * and the Projects page read the same file, so adding a language is a new `locales/<code>.json` plus one line
 * there and nothing in this package.
 */
export interface Language {
  code: string;
  name: string;
}

export const LANGUAGES: readonly Language[] = catalog;

export const LANGUAGE_CODES: readonly string[] = LANGUAGES.map(({ code }) => code);

/** The source-of-truth locale: bundled with the app, and what every missing key falls back to. */
export const SOURCE_LANGUAGE = "en";

/** The preference value that follows the operating system's languages. */
export const SYSTEM_LANGUAGE = "system";
